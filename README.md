# Reel Generator — @draydeliserodriguez

Sistema automatizado para generar reels verticales 1080×1920 con voz, subtítulos quemados, B-roll de stock y firma de marca, a partir de un audio narrado por Dra. Ydelise Rodríguez. Pensado para correr en EasyPanel junto al resto de la infraestructura de n8n.

Tres entregables que funcionan juntos:

1. **`ffmpeg-reel-worker/`** — microservicio Node.js + FFmpeg que compone el MP4 final desde una especificación JSON.
2. **`n8n-workflow-reel-generator.json`** — workflow n8n que orquesta el flujo completo (audio → Whisper → planner → búsqueda Pexels/Pixabay → composición → respuesta).
3. **`db/migrations/001_asset_usage.sql`** — tabla Postgres que evita repetición de B-roll entre reels.

---

## Diagrama de flujo

```
                   POST multipart audio + topic
                                │
                                ▼
                      ┌──────────────────┐
                      │  Webhook (n8n)   │
                      └─────────┬────────┘
                                │
                ┌───────────────┴────────────────┐
                ▼                                ▼
      ┌──────────────────┐            ┌──────────────────┐
      │ Groq Whisper     │            │ Initialize       │
      │ (transcripción)  │            │ Session (uuid)   │
      └─────────┬────────┘            └──────────────────┘
                │ palabras + timing
                ▼
      ┌──────────────────┐
      │ Segment chunks   │  3–7s respetando puntuación
      │ (Code)           │
      └─────────┬────────┘
                │ segments[]
                ▼
      ┌──────────────────┐
      │ Groq Llama 3.3   │  keywords_en + asset_type por segmento
      │ Visual Planner   │
      └─────────┬────────┘
                ▼
      ┌──────────────────┐
      │ Get Blocked      │  SELECT de asset_usage (status IN reserved/used)
      │ Assets (Pg)      │
      └─────────┬────────┘
                ▼
      ┌──────────────────┐
      │ Search & Pick    │  Pexels + Pixabay, excluye blocked
      │ Assets (Code)    │
      └─────────┬────────┘
                ▼
      ┌──────────────────┐
      │ Reserve Assets   │  INSERT status='reserved'
      │ (Postgres)       │
      └─────────┬────────┘
                ▼
      ┌──────────────────┐         ┌──────────────────────┐
      │ FFmpeg Worker    │ ◄────►  │  ffmpeg-reel-worker  │
      │ HTTP /compose    │ multipart│  (contenedor)        │
      └─────────┬────────┘         └──────────────────────┘
                ▼
      ┌──────────────────┐
      │ Confirm Used     │  UPDATE status='used'
      │ (Postgres)       │
      └─────────┬────────┘
                ▼
            ┌────┴────┐
            ▼         ▼
     ┌──────────┐  ┌──────────────┐
     │ Drive    │  │ Respond to   │
     │ Upload   │─►│ Webhook      │  MP4 binario
     └──────────┘  └──────────────┘
```

---

## Estructura del repo

```
REEL GENERATOR/
├── README.md                              ← este fichero
├── .env.example                           ← variables del sistema completo
├── .gitignore
├── ffmpeg-reel-worker/                    ← microservicio Docker
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── server.js                      ← Express, /health y /compose
│   │   ├── compose.js                     ← orquestación FFmpeg en 3 fases
│   │   ├── subtitles.js                   ← generador .ass
│   │   ├── branding.js                    ← paleta, fuentes, posiciones
│   │   └── utils/
│   │       ├── download.js                ← fetch nativo a fichero
│   │       ├── probe.js                   ← ffprobe wrapper
│   │       └── background.js              ← bake del PNG de gradiente
│   ├── assets/
│   │   ├── fonts/                         ← Montserrat (descargada en build)
│   │   └── overlays/                      ← bg_gradient.png (idempotente)
│   └── scripts/
│       └── fetch-fonts.sh                 ← descarga Montserrat de Google Fonts
├── n8n-workflow-reel-generator.json       ← workflow importable
├── db/
│   └── migrations/
│       └── 001_asset_usage.sql            ← tabla + índices + vista
└── tests/
    ├── sample-payload.json                ← spec de ejemplo (3 segmentos)
    └── smoke-compose.sh                   ← prueba end-to-end del worker
```

---

## Instalación en EasyPanel

### 1. Variables de entorno

Copia `.env.example` a `.env` y rellena:

| Variable | Cómo obtenerla |
|---|---|
| `GROQ_API_KEY` | https://console.groq.com → API Keys (free tier sobrado para 3–5 reels/sem) |
| `PEXELS_API_KEY` | https://www.pexels.com/api/ → registrarse (free) |
| `PIXABAY_API_KEY` | https://pixabay.com/api/docs/ → free, instantánea |
| `PG_*` | Credenciales de la instancia Postgres que ya usa n8n; crear BD `reels_assets` |
| `GDRIVE_OUTPUT_FOLDER_ID` | (opcional) ID de la carpeta de Drive para subir los reels |

### 2. Crear la base de datos

Conecta a Postgres y crea la BD + ejecuta la migración:

```sql
-- Una sola vez, conectada como superusuario:
CREATE DATABASE reels_assets OWNER n8n;
\c reels_assets
\i db/migrations/001_asset_usage.sql
```

Verifica:

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- debería listar: asset_usage  (+ vista asset_usage_blocked)
```

### 3. Desplegar el worker FFmpeg

En EasyPanel, en el proyecto `prueba_yde`:

1. Crear un nuevo servicio tipo **App → Dockerfile**.
2. Apuntar el repo a esta carpeta y el `Dockerfile` a `ffmpeg-reel-worker/Dockerfile`.
3. Configurar:
   - **Service name**: `ffmpeg-reel-worker` (importante: este nombre es el host DNS interno que verá n8n)
   - **Port**: `3000`
   - **Public domain**: deshabilitado (solo accesible internamente)
   - **Resources**: 1 vCPU, 1.5 GB RAM mínimo (FFmpeg + libx264 son hambrientos)
   - **Volume opcional**: montar `/tmp/reel-sessions` si quieres persistir sesiones para debug (`KEEP_SESSIONS=1`)
4. Variables de entorno del contenedor (puedes dejarlas en defaults):
   ```
   PORT=3000
   LOG_LEVEL=info
   ```
5. **Deploy**. El primer build tarda ~3-5 min (descarga apt + Montserrat + npm).

Verificar:

```bash
# Desde dentro de cualquier contenedor del proyecto:
curl http://ffmpeg-reel-worker:3000/health
# {"status":"ok","ffmpeg":"6.x","uptime_s":12}
```

### 4. Importar el workflow en n8n

1. En n8n → **Workflows → Import from File** → seleccionar `n8n-workflow-reel-generator.json`.
2. Crear las credenciales que faltan:
   - **Groq API Key (Header Auth)**: tipo `HTTP Header Auth`. Header `Authorization`, valor `Bearer <GROQ_API_KEY>`.
   - **Reels Postgres**: credencial Postgres apuntando a la BD `reels_assets`.
   - **Google Drive OAuth2** (opcional): solo si vas a usar el upload a Drive.
3. En el menú de variables de entorno de n8n añadir:
   ```
   PEXELS_API_KEY=<...>
   PIXABAY_API_KEY=<...>
   FFMPEG_WORKER_URL=http://ffmpeg-reel-worker:3000
   FFMPEG_WORKER_TIMEOUT_MS=300000
   GDRIVE_OUTPUT_FOLDER_ID=<...o vacío para deshabilitar Drive>
   ```
   > En EasyPanel, las env de n8n se editan en el contenedor de n8n (Settings → Environment).
4. **Save** y **Activate** el workflow.

### 5. Probar end-to-end

```bash
curl -X POST https://n8n.tudominio.com/webhook/reel-generator \
  -F "audio=@discurso_sraa.mp3" \
  -F "topic=Sistema Renina-Angiotensina-Aldosterona" \
  -F "style=educational" \
  -o reel_sraa.mp4
```

Si todo va bien, recibirás un MP4 1080×1920 listo para subir a Instagram. La latencia típica es ~30-90 s para un audio de 60 s (transcripción + planner + búsqueda + composición).

---

## Cómo funciona el worker FFmpeg

### Endpoints

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| `GET` | `/health` | — | `{ status, ffmpeg, uptime_s }` |
| `POST` | `/compose` | `application/json` o `multipart/form-data` | `video/mp4` binario |

### Modos de entrada

**JSON puro** — `Content-Type: application/json`, body con `audio_url` y `segments[].asset.url` apuntando a URLs públicas.

**Multipart** — `Content-Type: multipart/form-data` con:
- Campo `spec` (texto): JSON string del spec.
- Campo `audio` (fichero): audio binario que reemplaza a `spec.audio_url`.
- Campo `asset_<N>` (fichero, opcional): asset binario que reemplaza a `segments[N].asset.url`.

El workflow n8n usa **multipart** porque el audio llega al webhook como binario y no tiene URL pública.

### Pipeline de composición (3 fases)

1. **Pre-procesado por segmento** → `seg_NN.mp4` (1080×1920, 30 fps, sin audio):
   - Imágenes: Ken Burns sutil (zoom, pan u oscilación vertical, alternados).
   - Vídeos: scale + pad sobre fondo navy, con `stream_loop` por si el clip es más corto.
2. **Concatenación con xfade** → `concat.mp4` con transiciones `fade` de 0.5 s.
3. **Overlays finales** → `output.mp4`:
   - Subtítulos quemados desde un `.ass` generado en `subtitles.js`.
   - Barra navy semitransparente con la firma centrada abajo.
   - Badge dorado opcional con el título durante los primeros 2 s.
   - Mux con el audio original.

Codec final: H.264 CRF 20, AAC 192k, `+faststart`.

### Cálculo de duraciones

Para que el video dure **exactamente** lo mismo que el audio aunque haya transiciones xfade, cada segmento se renderiza con duración `audio_dur + 0.5 s` (excepto el último), y las transiciones consumen ese medio segundo. La fórmula:

```
visual_dur[i] = audio_dur[i] + xfade_dur     (i < N-1)
visual_dur[N-1] = audio_dur[N-1]
xfade offset_k = sum(audio_dur[0..k])
=> total = sum(audio_dur)  ✓
```

---

## Reglas de no-repetición de assets

| Estado | Significado | Cuándo se asigna |
|---|---|---|
| `reserved` | En uso por una sesión en curso | INSERT antes de llamar al worker |
| `used` | Publicado en un reel exitoso | UPDATE tras éxito del worker |
| `released` | Reserva liberada (la sesión falló) | UPDATE en error handler |

El workflow:
1. **Antes** de buscar B-roll, lee de `asset_usage` los `(source, asset_id)` con status `reserved` o `used`.
2. Filtra esos assets de los candidatos de Pexels/Pixabay.
3. Después de elegir, inserta como `reserved` (con `ON CONFLICT DO NOTHING` por idempotencia).
4. Si el worker termina con éxito → `UPDATE` a `used`.
5. Si falla → debería `UPDATE` a `released` (ver sección **Error handling** más abajo).

Una segunda ejecución del workflow con el mismo `topic` no podrá elegir ningún `asset_id` ya marcado como `used` — verificable con:

```sql
SELECT used_in_reel, source, asset_id, used_at
FROM asset_usage
WHERE status = 'used'
ORDER BY used_at DESC LIMIT 20;
```

---

## Error handling (importante — lee esto)

El workflow tal y como se importa **NO incluye** el paso de liberar reservas ante un fallo del worker. Es decisión consciente para mantener el JSON simple. Para añadirlo en n8n:

1. Selecciona el nodo **FFmpeg Worker** y activa **Settings → On Error → Continue (Error Output)**.
2. Aparece una segunda salida (roja). Conéctala a un nuevo nodo Postgres **Execute Query** llamado *Release Reservations* con:
   ```sql
   UPDATE asset_usage
   SET status = 'released', released_at = NOW()
   WHERE used_in_reel = $1 AND status = 'reserved';
   ```
   Y queryReplacement: `={{ $('Build Compose Spec').first().json.session_id }}`.
3. Conecta *Release Reservations* a un **Respond to Webhook** con código 500 que devuelva el error.

Documentado para que tengas control fino sobre el flujo.

---

## Tests locales

Antes de desplegar, prueba el worker en local:

```bash
# 1) Build
cd ffmpeg-reel-worker
docker build -t ffmpeg-reel-worker .

# 2) Run
docker run --rm -p 3000:3000 ffmpeg-reel-worker

# 3) Smoke test (otra terminal, requiere bash + curl + jq + ffmpeg + ffprobe)
cd ..
chmod +x tests/smoke-compose.sh
./tests/smoke-compose.sh
```

El smoke test:
1. Hace `GET /health`.
2. Genera un audio sintético de 13 s.
3. Llama a `/compose` en modo multipart con `tests/sample-payload.json`.
4. Verifica que el MP4 devuelto es 1080×1920, H.264 + AAC, ~13 s de duración.

---

## Estilo visual (resumen ejecutivo)

| Elemento | Valor |
|---|---|
| Resolución | 1080 × 1920 (9:16), 30 fps |
| Codec | H.264 CRF 20, AAC 192k, `+faststart` |
| Fondo | Navy `#0A1F3D` con (futuro) degradado radial a `#1B4F8C` |
| Subtítulos | Montserrat Black 64 px blanco, outline navy 4 px, ~10% desde arriba, máx 2 líneas × 22 chars |
| Asset central | 18%–88% del eje vertical, aspect-preserving, fondo navy si aspect no coincide |
| Firma | Barra navy alpha 0.8, 90 px alta, `@draydeliserodriguez` Montserrat Bold 38 px blanco |
| Badge título | Dorado `#F1C40F` Montserrat Bold 56 px, primeros 2 s |
| Transiciones | `xfade fade` 0.5 s entre segmentos (nunca cortes secos) |
| Ken Burns imágenes | Alternancia entre zoom centrado, pan H y zoom + drift vertical (factor 1.0→1.15) |

Las constantes viven en [ffmpeg-reel-worker/src/branding.js](ffmpeg-reel-worker/src/branding.js) — fuente única de verdad.

---

## Troubleshooting

### El worker devuelve 500 con `ffmpeg exited with code 1`
- Mira los headers de la respuesta: `X-Session-Id` te da el id para buscar logs.
- En el contenedor, revisa los logs (`docker logs <container>`); el último error suele ser un filter graph mal formado o un asset no descargable.
- Activa `KEEP_SESSIONS=1` y monta volumen en `/tmp/reel-sessions` para inspeccionar los ficheros intermedios (`seg_*.mp4`, `subtitles.ass`, `concat.mp4`).

### Pexels devuelve menos resultados de los esperados
- El planner Llama puede haber generado keywords muy abstractas. Comprueba la salida de `Visual Planner` en la ejecución de n8n.
- El nodo *Search & Pick Assets* hace fallback a Pixabay si Pexels devuelve <3 candidatos. Asegúrate de tener `PIXABAY_API_KEY`.
- Si todos los candidatos están ya bloqueados (la tabla está saturada), tendrás que ampliar las queries: edita el Code node y prueba con `medical_concept` traducido o keywords más genéricas.

### Whisper transcribe mal términos médicos
- El nodo *Whisper Transcribe* incluye un campo `prompt` con un glosario por defecto. Si pasas el campo `script` en el webhook, ese script se usa como prompt y mejora drásticamente la precisión sobre palabras como "angiotensina", "aldosterona", etc.

### El video sale más corto / más largo que el audio
- Comprueba que la suma de `(end - start)` de los segmentos coincide con la duración del audio. Si Whisper deja silencios al inicio/final, los segmentos no cubren todo y el video sale corto.
- En esos casos, añade segmentos artificiales con `subtitle_text: ""` para los huecos, o ajusta el segmenter en `Segment Transcript` para extender el primer/último chunk hasta los extremos.

### El badge de título no se ve centrado o se desborda
- El badge usa una estimación del ancho (`text.length * fontSize * 0.55`). Para títulos muy cortos o con muchos caracteres anchos (W, M), puede quedar mal.
- TODO en `compose.js`: renderizar el badge como PNG con alpha pre-rasterizado por el server, lo que da control exacto del ancho.

---

## Ideas para fase 2

- **pHash perceptual**: además del `asset_id` de la fuente, calcular un perceptual hash de la imagen/primer frame y bloquear assets con Hamming distance < 5 respecto a alguno ya `used`. Columna `asset_phash` ya existe.
- **Fondo gradiente**: el `bg_gradient.png` ya se hornea al arranque del worker pero `compose.js` aún usa `pad=color=NAVY` sólido. Sustituir por overlay del asset sobre el gradiente.
- **Esquinas redondeadas**: pre-renderizar máscaras PNG con alpha (radius 24 px) y usar `overlay` en vez de `pad`/`drawbox`.
- **Publicación automática**: nuevo nodo final que llame a la Meta Graph API para publicar directamente en Instagram (requiere Cuenta Profesional + Página de Facebook conectada).
- **Generador de copy**: pequeño nodo Llama adicional que produzca caption + hashtags sugeridos en función del topic, para devolverlos junto con el MP4 (`X-Suggested-Caption` header o JSON de respuesta alternativo).
- **Política de retención**: cron en Postgres que borre filas `released` >30 días para no inflar la tabla.

---

## Restricciones del proyecto

- **Solo free tier**: Groq, Pexels, Pixabay, Whisper, FFmpeg, Postgres, Drive (cuota free). Volumen estimado de ~3–5 reels/semana cabe holgado.
- **Sin servicios de pago**: no introducir SaaS adicionales.
- **Postgres > SQLite**: la instancia ya existe en EasyPanel, reutilizamos.

---

## Licencias

- Código del worker y workflow: para uso personal de Dra. Ydelise Rodríguez.
- Fuentes Montserrat: SIL Open Font License (descargadas en build).
- Stock visual: Pexels License y Pixabay License (free para uso comercial con atribución no obligatoria).
