/**
 * ffmpeg-reel-worker — servidor HTTP.
 *
 * Endpoints:
 *   GET  /health   -> { status, ffmpeg, uptime_s }
 *   POST /compose  -> MP4 binario (1080x1920, audio + subtitulos + firma)
 *
 * El endpoint /compose acepta dos formatos de entrada:
 *
 *   1) application/json
 *      Body = spec completo con `audio_url` y `segments[].asset.url`.
 *      El worker descarga todo via HTTP. Util cuando los assets viven
 *      en URLs publicas (Pexels, Pixabay).
 *
 *   2) multipart/form-data
 *      Campo `spec`  (text)  : JSON string del spec.
 *      Campo `audio` (file)  : audio binario (sustituye a spec.audio_url).
 *      Campo `asset_<N>` (file, opcional): asset binario para el segmento N
 *                                          (sustituye a segments[N].asset.url).
 *      Recomendado para n8n: el webhook de n8n no expone una URL publica
 *      del audio recibido, asi que se envia como fichero adjunto.
 */

import express from 'express';
import multer from 'multer';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { mkdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { composeReel } from './compose.js';
import { ensureGradientBackground } from './utils/background.js';

// ---------------------------------------------------------------------------
// Configuracion via entorno
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const SESSIONS_ROOT = process.env.SESSIONS_ROOT || '/tmp/reel-sessions';
const FONT_DIR = process.env.FONT_DIR || '/usr/share/fonts/truetype/montserrat';
const ASSETS_DIR = process.env.ASSETS_DIR || path.resolve('./assets');
const KEEP_SESSIONS = process.env.KEEP_SESSIONS === '1';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '50', 10);
const REQ_BODY_LIMIT = process.env.REQ_BODY_LIMIT || '5mb';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const logger = pino({ level: LOG_LEVEL });
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Multer: aceptar audio + assets como ficheros multipart en /compose
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      // Cada peticion vive en su propio directorio /tmp/reel-sessions/<uuid>.
      // Lo creamos al recibir la primera parte del multipart.
      if (!req._sessionDir) {
        req._sessionId = randomUUID();
        req._sessionDir = path.join(SESSIONS_ROOT, req._sessionId);
        try {
          await mkdir(req._sessionDir, { recursive: true });
        } catch (e) {
          return cb(e, null);
        }
      }
      cb(null, req._sessionDir);
    },
    filename: (_req, file, cb) => {
      // Conservar nombres reconocibles (audio, asset_00, asset_01, ...) +
      // extension del fichero subido.
      const ext = path.extname(file.originalname || '') || '';
      cb(null, `${file.fieldname}${ext}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 32,
  },
});

// `audio` + cualquier `asset_<N>`. Multer.any() acepta todos los campos.
const composeUpload = upload.any();

// ---------------------------------------------------------------------------
// Validacion del spec
// ---------------------------------------------------------------------------
function validateSpec(spec, { hasUploadedAudio = false } = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('spec must be an object');
  }
  if (!hasUploadedAudio && (typeof spec.audio_url !== 'string' || !spec.audio_url)) {
    throw new Error('spec.audio_url is required when no audio file is uploaded');
  }
  if (!Array.isArray(spec.segments) || spec.segments.length === 0) {
    throw new Error('spec.segments must be a non-empty array');
  }
  for (let i = 0; i < spec.segments.length; i++) {
    const s = spec.segments[i];
    if (typeof s.start !== 'number' || typeof s.end !== 'number') {
      throw new Error(`segment ${i}: start/end must be numbers`);
    }
    if (s.end <= s.start) {
      throw new Error(`segment ${i}: end must be > start`);
    }
    if (typeof s.subtitle_text !== 'string') {
      throw new Error(`segment ${i}: subtitle_text must be a string`);
    }
    if (!s.asset || typeof s.asset !== 'object') {
      throw new Error(`segment ${i}: asset object is required`);
    }
    if (!['image', 'video'].includes(s.asset.type)) {
      throw new Error(`segment ${i}: asset.type must be 'image' or 'video'`);
    }
    // asset.url puede faltar si se subio asset_N como fichero — esa
    // sustitucion la verificara composeReel via assetFilePaths.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ffmpegVersion() {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => (out += c.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg -version failed'));
      const m = out.match(/ffmpeg version (\S+)/);
      resolve(m ? m[1] : 'unknown');
    });
  });
}

async function cleanupSession(dir, log) {
  if (!dir || KEEP_SESSIONS) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    log?.warn?.({ err: e.message, dir }, 'cleanup failed');
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(pinoHttp({ logger }));
app.use(express.json({ limit: REQ_BODY_LIMIT }));

app.get('/health', async (_req, res) => {
  try {
    const ver = await ffmpegVersion();
    res.json({
      status: 'ok',
      ffmpeg: ver,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

/**
 * POST /compose — punto de entrada principal.
 */
app.post('/compose', composeUpload, async (req, res) => {
  const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/form-data');

  let spec;
  let audioFilePath;
  let assetFilePaths = {};
  let sessionId;
  let sessionDir;

  try {
    if (isMultipart) {
      sessionId = req._sessionId || randomUUID();
      sessionDir = req._sessionDir || path.join(SESSIONS_ROOT, sessionId);
      await mkdir(sessionDir, { recursive: true });
      if (typeof req.body?.spec !== 'string') {
        throw new Error('multipart request must include a "spec" field with the JSON spec as a string');
      }
      try {
        spec = JSON.parse(req.body.spec);
      } catch (e) {
        throw new Error(`invalid JSON in spec field: ${e.message}`);
      }
      for (const f of req.files || []) {
        if (f.fieldname === 'audio') {
          audioFilePath = f.path;
        } else if (f.fieldname.startsWith('asset_')) {
          const idx = parseInt(f.fieldname.slice('asset_'.length), 10);
          if (Number.isFinite(idx)) assetFilePaths[idx] = f.path;
        }
      }
    } else {
      sessionId = randomUUID();
      sessionDir = path.join(SESSIONS_ROOT, sessionId);
      await mkdir(sessionDir, { recursive: true });
      spec = req.body;
    }

    validateSpec(spec, { hasUploadedAudio: !!audioFilePath });
  } catch (e) {
    req.log.warn({ err: e.message }, 'invalid /compose request');
    await cleanupSession(sessionDir, req.log);
    return res.status(400).json({ error: 'invalid_request', message: e.message });
  }

  res.setHeader('X-Session-Id', sessionId);

  let result;
  try {
    result = await composeReel({
      spec,
      sessionDir,
      fontDir: FONT_DIR,
      logger: req.log,
      audioFilePath,
      assetFilePaths,
    });
  } catch (e) {
    req.log.error({ err: e.message, stack: e.stack }, 'compose failed');
    await cleanupSession(sessionDir, req.log);
    return res.status(500).json({
      error: 'compose_failed',
      message: e.message,
      session_id: sessionId,
    });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="reel-${sessionId}.mp4"`
  );
  res.setHeader('X-Compose-Elapsed-Ms', String(result.metadata.elapsed_ms));
  res.setHeader('X-Segment-Count', String(result.metadata.segment_count));
  if (result.metadata.audio_duration != null) {
    res.setHeader('X-Audio-Duration', String(result.metadata.audio_duration));
  }

  let cleaned = false;
  const finalize = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupSession(sessionDir, req.log);
  };
  res.on('finish', finalize);
  res.on('close', finalize);

  const stream = createReadStream(result.outputPath);
  stream.on('error', (err) => {
    req.log.error({ err: err.message }, 'output stream error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'stream_failed', message: err.message });
    }
    finalize();
  });
  stream.pipe(res);
});

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// Manejo de errores no atrapados (incluye errores de multer)
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message }, 'unhandled error');
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    error: err.code || 'internal_error',
    message: err.message,
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function bootstrap() {
  await mkdir(SESSIONS_ROOT, { recursive: true }).catch(() => {});
  // Bake gradient background (best-effort; el modulo cae a color solido si falla).
  const overlayPath = path.join(ASSETS_DIR, 'overlays', 'bg_gradient.png');
  await ensureGradientBackground(overlayPath, logger).catch((e) => {
    logger.warn({ err: e.message }, 'background bake failed (continuing with solid color)');
  });

  app.listen(PORT, () => {
    logger.info(
      { port: PORT, sessionsRoot: SESSIONS_ROOT, fontDir: FONT_DIR },
      'ffmpeg-reel-worker listening'
    );
  });
}

bootstrap().catch((e) => {
  logger.fatal({ err: e.message }, 'bootstrap failed');
  process.exit(1);
});
