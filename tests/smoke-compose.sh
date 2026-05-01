#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# smoke-compose.sh — prueba end-to-end del worker /compose en local.
#
# Que hace:
#   1) Comprueba que el worker responde en /health.
#   2) Genera un audio sintetico de 13s con FFmpeg si no existe.
#   3) Llama a POST /compose en modo multipart, pasando:
#        - spec  = sample-payload.json (con segmentos de Pexels)
#        - audio = el .mp3 sintetico generado
#   4) Verifica con ffprobe que el MP4 devuelto es 1080x1920 y que su
#      duracion es ~ 13s (tolerancia +/- 0.6s).
#
# Requisitos:
#   - bash, curl, jq, ffmpeg, ffprobe en el PATH del host
#   - worker corriendo en $WORKER_URL (por defecto http://localhost:3000)
#
# Uso:
#   ./tests/smoke-compose.sh
#   WORKER_URL=http://localhost:3000 ./tests/smoke-compose.sh
# -----------------------------------------------------------------------------

set -euo pipefail

WORKER_URL="${WORKER_URL:-http://localhost:3000}"
TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$TEST_DIR/output"
mkdir -p "$OUTPUT_DIR"

PAYLOAD_JSON="$TEST_DIR/sample-payload.json"
AUDIO_FILE="$OUTPUT_DIR/sample-audio.mp3"
OUTPUT_MP4="$OUTPUT_DIR/smoke-output.mp4"

# 1) Health check ------------------------------------------------------------
echo "[smoke] 1) health check $WORKER_URL/health"
if ! curl -fsS --max-time 5 "$WORKER_URL/health" >/dev/null; then
  echo "[smoke] FAIL: worker no responde en $WORKER_URL/health"
  echo "        Asegurate de que el contenedor esta arriba: docker run -p 3000:3000 ffmpeg-reel-worker"
  exit 1
fi
curl -fsS "$WORKER_URL/health" | head -c 200; echo

# 2) Generar audio sintetico de 13s -----------------------------------------
if [ ! -f "$AUDIO_FILE" ]; then
  echo "[smoke] 2) generando audio sintetico ($AUDIO_FILE)"
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "sine=frequency=220:duration=13" \
    -ar 44100 -b:a 128k "$AUDIO_FILE"
else
  echo "[smoke] 2) audio sintetico ya existe, reuse"
fi

# 3) POST /compose en modo multipart ----------------------------------------
echo "[smoke] 3) POST $WORKER_URL/compose (multipart)"
SPEC_JSON=$(cat "$PAYLOAD_JSON")

HTTP_CODE=$(curl -sS -w '%{http_code}' -X POST "$WORKER_URL/compose" \
  -F "spec=$SPEC_JSON;type=application/json" \
  -F "audio=@${AUDIO_FILE};type=audio/mpeg" \
  -o "$OUTPUT_MP4" \
  --max-time 600)

if [ "$HTTP_CODE" != "200" ]; then
  echo "[smoke] FAIL: HTTP $HTTP_CODE"
  echo "[smoke] respuesta:"
  cat "$OUTPUT_MP4" | head -c 500; echo
  exit 1
fi

# 4) Verificar con ffprobe ---------------------------------------------------
echo "[smoke] 4) verificando MP4 con ffprobe"
WIDTH=$(ffprobe -v error -select_streams v:0 -show_entries stream=width  -of csv=p=0 "$OUTPUT_MP4")
HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$OUTPUT_MP4")
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUTPUT_MP4")
VCODEC=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$OUTPUT_MP4")
ACODEC=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$OUTPUT_MP4")

echo "[smoke]    width=$WIDTH height=$HEIGHT duration=$DURATION vcodec=$VCODEC acodec=$ACODEC"

EXPECTED_DUR=13
TOLERANCE=0.6

if [ "$WIDTH" != "1080" ] || [ "$HEIGHT" != "1920" ]; then
  echo "[smoke] FAIL: dimensiones $WIDTH x $HEIGHT (esperaba 1080x1920)"
  exit 1
fi

if [ "$VCODEC" != "h264" ]; then
  echo "[smoke] FAIL: codec video = $VCODEC (esperaba h264)"
  exit 1
fi

if [ "$ACODEC" != "aac" ]; then
  echo "[smoke] FAIL: codec audio = $ACODEC (esperaba aac)"
  exit 1
fi

# Comparacion de duracion con tolerancia (awk para no depender de bc)
if ! awk -v dur="$DURATION" -v exp="$EXPECTED_DUR" -v tol="$TOLERANCE" \
   'BEGIN { d = dur - exp; if (d < 0) d = -d; exit (d > tol) }'; then
  echo "[smoke] FAIL: duracion $DURATION fuera de tolerancia (esperaba ${EXPECTED_DUR}s +/- ${TOLERANCE}s)"
  exit 1
fi

echo "[smoke] OK ✓"
echo "[smoke] output: $OUTPUT_MP4"
