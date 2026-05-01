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
declare -a FONTS=(
  "Montserrat-Regular.ttf"
  "Montserrat-Bold.ttf"
  "Montserrat-Black.ttf"
)

declare -a BASE_URLS=(
  "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf"
  "https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf"
  "https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static"
)

for filename in "${FONTS[@]}"; do
  dest="$FONTS_DIR/$filename"
  if [ -f "$dest" ] && [ -s "$dest" ]; then
    echo "[fonts] $filename ya existe, skip"
    continue
  fi

  success=0
  for base in "${BASE_URLS[@]}"; do
    url="$base/$filename"
    echo "[fonts] intentando $url"
    if curl -fsSL --retry 2 --retry-delay 2 --max-time 30 "$url" -o "$dest"; then
      # Verificacion minima: el fichero existe y pesa al menos 50 KB
      # (los .ttf de Montserrat pesan >100 KB; <50 KB es respuesta corrupta).
      size=$(wc -c < "$dest" 2>/dev/null || echo 0)
      if [ "$size" -ge 50000 ]; then
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
