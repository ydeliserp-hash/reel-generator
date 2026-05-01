# =============================================================================
# ffmpeg-reel-worker
#
# Imagen Docker para componer reels verticales 1080x1920 con FFmpeg.
# Disenada para correr en EasyPanel como contenedor interno (sin TLS, accesible
# por DNS interno desde n8n -> http://ffmpeg-reel-worker:3000).
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — instalar dependencias npm en una capa cacheable
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` falla si no hay package-lock; en su defecto usamos `npm install`.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi


# -----------------------------------------------------------------------------
# Stage 2 — runtime con FFmpeg y fontconfig
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        fontconfig \
        fonts-dejavu-core \
        curl \
        ca-certificates \
        bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node_modules desde el stage anterior
COPY --from=deps /app/node_modules ./node_modules

# Codigo fuente y assets
COPY package.json ./
COPY src ./src
COPY assets ./assets
COPY scripts ./scripts

# Descargar fuentes Montserrat en build (red disponible) y registrarlas
# con fontconfig para que FFmpeg / libass las localicen por nombre.
RUN bash scripts/fetch-fonts.sh \
    && mkdir -p /usr/share/fonts/truetype/montserrat \
    && cp assets/fonts/*.ttf /usr/share/fonts/truetype/montserrat/ \
    && fc-cache -f -v

ENV NODE_ENV=production \
    PORT=3000 \
    SESSIONS_ROOT=/tmp/reel-sessions \
    FONT_DIR=/usr/share/fonts/truetype/montserrat \
    ASSETS_DIR=/app/assets \
    LOG_LEVEL=info

EXPOSE 3000

# Healthcheck — EasyPanel respeta esto para reiniciar el contenedor si /health
# devuelve != 200 durante demasiado tiempo.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -fs http://localhost:3000/health || exit 1

# `tini` no esta instalado pero node 20 maneja senales decentemente.
CMD ["node", "src/server.js"]
