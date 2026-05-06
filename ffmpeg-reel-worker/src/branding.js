/**
 * Constantes de marca y helpers de color para el reel generator.
 *
 * Modulo puro: no hace I/O ni invoca a FFmpeg. Sirve como fuente unica
 * de verdad para tipografias, paleta y posiciones. Los valores aqui
 * deben coincidir con los reels existentes de @draydeliserodriguez.
 */

export const BRAND = {
  colors: {
    bg_dark: '#0A1F3D',          // navy fondo principal y outline subtitulos
    bg_mid: '#1B4F8C',           // navy medio para degradado radial
    accent_gold: '#F1C40F',      // dorado para badge de titulo
    accent_teal: '#14B8A6',      // turquesa para acentos secundarios
    text_primary: '#FFFFFF',     // blanco para texto y firma
    text_outline: '#0A1F3D',     // outline navy de subtitulos
  },
  fonts: {
    // Nombres tal y como los registra fontconfig dentro del contenedor
    // (ver Dockerfile + assets/fonts/*.ttf instalados en /usr/share/fonts).
    subtitle: 'Montserrat Black',
    title: 'Montserrat Bold',
    signature: 'Montserrat Bold',
    cursive: 'Great Vibes',
    // Rutas de los .ttf, usadas por el filtro `drawtext` que requiere
    // fontfile=. Se consume desde compose.js parametrizado con FONT_DIR.
    file_subtitle: 'Montserrat-Black.ttf',
    file_title: 'Montserrat-Bold.ttf',
    file_signature: 'Montserrat-Bold.ttf',
    file_cursive: 'GreatVibes-Regular.ttf',
  },
  // Posiciones expresadas como fraccion del eje vertical (1350 px de alto en 4:5).
  // Layout NUEVO: badge titulo ARRIBA, asset en medio, subtitulos ABAJO,
  // firma al pie.
  positions: {
    title_badge_y_pct: 0.04,           // ~54 px (titulo del reel arriba del todo)
    asset_top_pct: 0.13,               // ~175 px (asset empieza debajo del badge)
    asset_bottom_pct: 0.78,            // ~1053 px (asset acaba antes de los subtitulos)
    subtitle_margin_v_bottom_pct: 0.10, // ~135 px desde abajo (subtitulo zona baja)
    signature_bar_y_pct: 0.965,        // centro vertical de la barra firma (~1303)
  },
  subtitle: {
    font_size: 64,
    max_chars_per_line: 22,
    max_lines: 2,
    outline_width: 4,
    shadow_offset: 3,
    // Keywords medicas que se resaltan en color destacado dentro de los
    // subtitulos. Match case-insensitive con respeto a acentos. Se pueden
    // anadir/quitar libremente. El highlight_color es el color de marca
    // (dorado) por default, modificable.
    highlight_color: '#F1C40F',          // dorado de marca
    highlight_keywords: [
      // ===== CARDIOVASCULAR =====
      // Anatomia / terminos generales
      'corazón', 'corazon', 'cardíaco', 'cardiaco', 'cardíaca', 'cardiaca',
      'cardiovascular', 'cardiopatía', 'cardiopatia', 'cardiología', 'cardiologia',
      'miocardio', 'miocárdico', 'endotelio', 'endotelial', 'vascular',
      'arteria', 'arterial', 'vena', 'venoso', 'capilar', 'aorta',
      'válvula', 'valvular', 'pericardio',
      // Arritmias y conduccion
      'arritmia', 'arritmias', 'fibrilación', 'fibrilacion',
      'taquicardia', 'bradicardia', 'palpitaciones', 'extrasístoles', 'extrasistoles',
      'flutter',
      // HTA / presion
      'hipertensión', 'hipertension', 'hipertenso', 'presión', 'presion',
      'tensión', 'tension', 'hipotensión', 'hipotension',
      // Eventos agudos
      'infarto', 'IAM', 'síndrome', 'sindrome', 'coronario',
      'ictus', 'ACV', 'trombosis', 'embolia', 'tromboembolismo', 'TEP',
      'angina', 'angor', 'isquemia', 'isquémico', 'isquemico', 'aneurisma',
      // Lipidos
      'colesterol', 'LDL', 'HDL', 'ApoB', 'lipoproteína', 'lipoproteina', 'Lp(a)',
      'dislipemia', 'dislipidemia', 'triglicéridos', 'trigliceridos',
      'aterosclerosis', 'ateroma', 'placa', 'calcio',
      // IC / valvulopatias
      'insuficiencia', 'estenosis', 'soplo', 'disnea', 'edema',
      'miocardiopatía', 'miocardiopatia', 'pericarditis', 'miocarditis', 'endocarditis',
      // Sintomas / signos
      'frecuencia', 'pulso',

      // ===== RIESGO / HABITOS =====
      'prevención', 'prevencion', 'primaria', 'secundaria',
      'factor', 'SCORE',
      'alcohol', 'etanol',
      'tabaco', 'fumar', 'fumador', 'nicotina', 'cigarrillo',
      'vapeo', 'vapear', 'vaper', 'e-cigarrillo',
      'ejercicio', 'actividad', 'sedentarismo', 'sedentario',
      'HIIT', 'MICT', 'aeróbico', 'aerobico', 'anaeróbico', 'anaerobico',
      'fuerza', 'resistencia', 'pasos', 'caminar',
      'dieta', 'alimentación', 'alimentacion', 'nutrición', 'nutricion',
      'mediterránea', 'mediterranea', 'DASH',
      'ultraprocesados', 'ultraprocesado', 'procesados',
      'azúcar', 'azucar', 'sal', 'sodio',
      'ayuno', 'intermitente',
      'cronoalimentación', 'cronoalimentacion', 'circadiano', 'ritmo',
      'desayuno', 'cena', 'almuerzo',
      'sobrepeso', 'IMC', 'perímetro', 'perimetro', 'cintura',
      'obesidad', 'obeso',

      // ===== BIOQUIMICOS / SUPLEMENTOS =====
      // Lipidos y marcadores
      'omega', 'omega-3', 'EPA', 'DHA',
      'homocisteína', 'homocisteina', 'PCR',
      // Vitaminas / minerales
      'vitamina', 'D3', 'B12', 'cobalamina', 'folato',
      'hierro', 'ferritina', 'anemia',
      'magnesio', 'potasio', 'calcio', 'zinc', 'selenio',
      // Glucosa / diabetes
      'glucosa', 'glucemia', 'glicemia',
      'insulina', 'insulinoresistencia',
      'diabetes', 'prediabetes', 'diabético', 'diabetico',
      'HbA1c', 'hemoglobina', 'glicosilada',
      'índice', 'indice', 'glucémico', 'glucemico', 'carga',
      // Macros
      'proteína', 'proteina', 'aminoácidos', 'aminoacidos',
      'carbohidratos', 'hidratos',
      'grasas', 'saturadas', 'insaturadas', 'trans',
      'fructosa', 'sacarosa',
      'fibra', 'prebióticos', 'prebioticos', 'probióticos', 'probioticos', 'microbiota',
      // Antioxidantes
      'antioxidantes', 'polifenoles', 'flavonoides', 'resveratrol', 'catequinas',
      // Hormonas
      'cortisol', 'adrenalina', 'catecolaminas',
      'testosterona', 'estrógenos', 'estrogenos',
      'TSH', 'tiroides', 'tiroideo',

      // ===== WELLBEING =====
      'estrés', 'estres', 'ansiedad', 'ansioso',
      'sueño', 'sueno', 'dormir', 'insomnio',
      'apnea', 'ronquido',
      'descanso', 'fatiga', 'cansancio',
      'meditación', 'meditacion', 'mindfulness', 'respiración', 'respiracion',
      'bienestar', 'salud', 'mental',
      'depresión', 'depresion', 'ánimo', 'animo',
      'relajación', 'relajacion',
      'soledad', 'conexión', 'conexion',

      // ===== MEDICACION =====
      'estatinas', 'estatina', 'ezetimiba', 'fibratos', 'PCSK9',
      'ARA-II', 'IECA', 'betabloqueante', 'betabloqueantes',
      'diurético', 'diuretico', 'anticoagulante', 'antiagregante',
      'aspirina', 'AAS', 'clopidogrel',
      'anticoagulación', 'anticoagulacion', 'Sintrom',
      'antihipertensivo', 'antihipertensivos',

      // ===== PRUEBAS =====
      'electrocardiograma', 'ECG', 'electro',
      'ecocardiograma', 'ecocardio', 'ecografía', 'ecografia',
      'holter', 'ergometría', 'ergometria', 'prueba',
      'cateterismo', 'coronariografía', 'coronariografia',
      'TAC', 'resonancia', 'RMN',
      'analítica', 'analitica', 'perfil', 'lipídico', 'lipidico',
      'marcapasos', 'desfibrilador', 'DAI', 'stent', 'bypass', 'ablación', 'ablacion',

      // ===== AMBIENTAL =====
      'frío', 'frio', 'calor', 'temperatura',
      'ola', 'contaminación', 'contaminacion', 'polución', 'polucion',
      'sol', 'luz', 'exposición', 'exposicion',
      'sauna', 'ducha',

      // ===== OTROS (cafe, te, hidratacion) =====
      'café', 'cafe', 'cafeína', 'cafeina',
      'té', 'te', 'infusión', 'infusion',
      'chocolate', 'cacao',
      'agua', 'hidratación', 'hidratacion', 'deshidratación', 'deshidratacion',
    ],
  },
  signature: {
    text: process.env.BRAND_SIGNATURE || '@draydeliserodriguez',
    font_size: 34,
    bar_height: 70,
    bar_alpha: 0.8,
  },
  title_badge: {
    font_size: 56,
    horizontal_padding: 40,
    vertical_padding: 18,
    duration_default: 2.0,
  },
  // Outro: clip estatico de cierre (logo + frase) concatenado al final del
  // reel. NO va como overlay sobre la voz, va como segmento extra final.
  // Asi evitamos que ffmpeg procese un overlay en cada frame del video (lo
  // que saturaba el VPS). Concat sin reencode tarda ~2s.
  outro: {
    // Se puede desactivar en runtime con OUTRO_ENABLED=false (sin redeploy de codigo).
    enabled: process.env.OUTRO_ENABLED !== 'false',
    duration: 3.5,                        // segundos del clip outro al final
    logo_file: 'logo_firma.png',          // en assets/overlays/
    logo_width_pct: 0.95,                 // ~1026 px de ancho (sobre 1080) — casi todo el ancho
    logo_y_pct: 0.43,                     // CENTRO vertical del logo (~580 px) — zona del rectangulo rojo
    logo_fade_in_duration: 0.7,           // segundos de fade-in del logo
    backdrop_color: '#0A1F3D',            // navy de marca (fallback)
    // Slogan: PNG pre-disenado por la doctora (slogan_reel.png en assets/overlays/).
    // El PNG debe ser del MISMO tamano que el video (1080x1350) — se overlay
    // tal cual en (0,0) sin escalar. El layout/posicion del texto va dentro
    // del PNG, no en el config. Si no existe el archivo, el outro se genera
    // sin slogan (solo logo).
    slogan_file: 'slogan_reel.png',
    slogan_fade_in_start: 1.0,            // segundo en que empieza el fade-in del slogan
    slogan_fade_in_duration: 1.0,         // duracion del fade-in
    transition_duration: 0.5,             // segundos de xfade entre reel y outro
    // Drop shadow detras del logo (negro semitransparente blureado).
    shadow_offset_x: 6,
    shadow_offset_y: 6,
    shadow_blur: 14,
    shadow_alpha: 0.65,
  },
  // Musica de fondo suave bajo la voz. Las melodias estan en assets/music/
  // (melody1.mp3 ... melody8.mp3). Se elige una por reel via hash del sessionDir.
  background_music: {
    enabled: process.env.BACKGROUND_MUSIC_ENABLED !== 'false',
    music_dir: 'music',                  // dentro de assets/
    volume: 0.15,                        // 0..1 (15% volumen)
    voice_boost: 1.4,                    // multiplicador del volumen de la voz (1.0 = sin cambio)
    // dynaudnorm: normaliza dinamicamente el volumen de la voz, subiendo
    // las partes bajas. Necesario para compensar ElevenLapse que reduce
    // el volumen progresivamente. Pon a null para desactivar.
    //   f=200  : frame de 200ms (rapido para detectar cambios)
    //   g=15   : ventana de 15 frames (suaviza transiciones)
    //   p=0.9  : peak target 90% (sin clipping)
    //   m=10   : max amplification 10x
    voice_normalize: 'dynaudnorm=f=200:g=15:p=0.9:m=10',
    fade_in_duration: 1.0,               // segundos de fade-in al inicio
    fade_out_duration: 1.5,              // segundos de fade-out al final
  },
  video: {
    width: 1080,
    height: 1350,                  // Formato 4:5 (Instagram feed portrait)
    fps: 30,
    crf: 21,                       // Mejor calidad (antes 23)
    preset: 'fast',                // Compresion ~70% mejor que ultrafast
    audio_bitrate: '128k',
    xfade_duration: 0.3,           // Transicion entre segmentos (mas corta = menos desfase imagen-audio)
    xfade_transition: 'fade',
    // Numero maximo de segmentos pre-procesados en paralelo en fase 1.
    // Bajar este valor si el worker se queda sin RAM o CPU.
    max_parallel_segments: 2,
  },
};

/**
 * Convierte `#RRGGBB` al formato de color de FFmpeg `0xRRGGBB`.
 */
export function ffmpegColor(hex) {
  return '0x' + hex.replace('#', '').toUpperCase();
}

/**
 * Convierte `#RRGGBB` + alpha (0..1) a formato FFmpeg `0xRRGGBB@A`.
 * Apto para argumentos `color=` de `drawbox`, `pad`, `color` source, etc.
 */
export function ffmpegColorAlpha(hex, alpha) {
  return `${ffmpegColor(hex)}@${alpha}`;
}

/**
 * Convierte `#RRGGBB` al formato de color ASS: `&HAABBGGRR`.
 * - ASS usa orden BGR (no RGB).
 * - Alpha invertido: 00 = opaco, FF = transparente.
 */
export function assColor(hex, alpha = 0) {
  const clean = hex.replace('#', '').toUpperCase().padStart(6, '0');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  const a = alpha.toString(16).toUpperCase().padStart(2, '0');
  return `&H${a}${b}${g}${r}`;
}

/**
 * Convierte `#RRGGBB` al formato de color ASS para inline tags `\c`: `&HBBGGRR&`
 * (sin alpha, con `&` final). Usado para resaltar palabras dentro del texto.
 */
export function assColorInline(hex) {
  const clean = hex.replace('#', '').toUpperCase().padStart(6, '0');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${b}${g}${r}&`;
}

/**
 * Convierte un porcentaje (0..1) a coordenada Y absoluta en px.
 */
export function pctY(pct) {
  return Math.round(BRAND.video.height * pct);
}

/**
 * Convierte un porcentaje (0..1) a coordenada X absoluta en px.
 */
export function pctX(pct) {
  return Math.round(BRAND.video.width * pct);
}
