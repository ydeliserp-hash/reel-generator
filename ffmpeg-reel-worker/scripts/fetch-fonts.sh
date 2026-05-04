#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# fetch-fonts.sh — descarga las variantes Bold, Black y Regular de Montserrat
# y las deja en assets/fonts/ listas para el build del contenedor.
#
# Estrategia: intenta varias fuentes en orden hasta que una funciona.
#   1) Repo oficial de la autora (Julieta Ulanovsky) — la fuente original.
#   2) Repo google/fonts — backup por si la autora reorganiza.
#
# Idempotente: si los .ttf ya existen y no estan vacios, no hace nada.
# Las fuentes se distribuyen bajo licencia OFL.
# -----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FONTS_DIR="$SCRIPT_DIR/../assets/fonts"
mkdir -p "$FONTS_DIR"

# Fuentes a descargar. El orden de las URLs base se prueba secuencialmente
# para cada fichero hasta que una responda 200 OK.
# Cada fuente se intenta desde un set de URLs base distinto (familia distinta).
# Formato: "Nombre.ttf|url_base_1|url_base_2|..."
# Min size esta tras el primer ":" del nombre si quieres override (default 50000).
declare -a FONT_SPECS=(
  "Montserrat-Regular.ttf|https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf|https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf|https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static"
  "Montserrat-Bold.ttf|https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf|https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf|https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static"
  "Montserrat-Black.ttf|https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf|https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf|https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static"
  "GreatVibes-Regular.ttf|https://raw.githubusercontent.com/google/fonts/main/ofl/greatvibes|https://github.com/google/fonts/raw/main/ofl/greatvibes"
)

for spec in "${FONT_SPECS[@]}"; do
  IFS='|' read -ra parts <<< "$spec"
  filename="${parts[0]}"
  dest="$FONTS_DIR/$filename"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "[fonts] $filename ya existe, skip"
    continue
  fi

  success=0
  # Recorrer URLs base (a partir del indice 1)
  for ((i=1; i<${#parts[@]}; i++)); do
    base="${parts[$i]}"
    url="$base/$filename"
    echo "[fonts] intentando $url"
    if curl -fsSL --retry 2 --retry-delay 2 --max-time 30 "$url" -o "$dest"; then
      size=$(wc -c < "$dest" 2>/dev/null || echo 0)
      # Great Vibes pesa ~70 KB, Montserrat ~450 KB. Min 30 KB cubre ambos.
      if [ "$size" -ge 30000 ]; then
        echo "[fonts] OK $filename ($size bytes)"
        success=1
        break
      else
        echo "[fonts] WARN: $filename pesa $size bytes (sospechoso), probando siguiente fuente"
        rm -f "$dest"
      fi
    else
      echo "[fonts] fallo desde $base, probando siguiente fuente"
      rm -f "$dest"
    fi
  done

  if [ "$success" = "0" ]; then
    echo "[fonts] ERROR: no se pudo descargar $filename desde ninguna fuente conocida" >&2
    exit 1
  fi
done

echo "[fonts] OK — fuentes en $FONTS_DIR:"
ls -la "$FONTS_DIR" | grep -E '\.ttf$' || true
