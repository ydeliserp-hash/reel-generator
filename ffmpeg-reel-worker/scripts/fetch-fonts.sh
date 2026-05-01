#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# fetch-fonts.sh — descarga las variantes Bold, Black y Regular de Montserrat
# desde el repositorio oficial de Google Fonts en GitHub y las deja en
# assets/fonts/ listas para el build del contenedor.
#
# Idempotente: si los .ttf ya existen y no estan vacios, no hace nada.
# Las fuentes se distribuyen bajo licencia OFL.
# -----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FONTS_DIR="$SCRIPT_DIR/../assets/fonts"
mkdir -p "$FONTS_DIR"

# Fuente: repo oficial de Google Fonts en GitHub.
# Si Google reorganiza el repo y rompe esta ruta, alternativa:
#   1) descargar el zip oficial de https://fonts.google.com/download?family=Montserrat
#   2) extraer Montserrat-{Regular,Bold,Black}.ttf a assets/fonts/
BASE_URL="https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static"

declare -a FONTS=(
  "Montserrat-Regular.ttf"
  "Montserrat-Bold.ttf"
  "Montserrat-Black.ttf"
)

for filename in "${FONTS[@]}"; do
  dest="$FONTS_DIR/$filename"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "[fonts] $filename ya existe, skip"
    continue
  fi
  url="$BASE_URL/$filename"
  echo "[fonts] descargando $filename"
  if ! curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$dest"; then
    echo "[fonts] ERROR descargando $url" >&2
    rm -f "$dest"
    exit 1
  fi
done

echo "[fonts] OK — fuentes en $FONTS_DIR:"
ls -la "$FONTS_DIR" | grep -E '\.ttf$' || true
