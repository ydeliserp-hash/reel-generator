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
const REQ_BODY_LIMIT = process.env.REQ_BODY_LIMIT || '50mb';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
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
      // Modo JSON. Soporta dos variantes:
      //   (a) audio_url externo (descarga via HTTP) — formato original
      //   (b) audio_base64 inline (decodifica a fichero) — para n8n que tiene
      //       bug enviando multipart binary a servicios externos/internos
      sessionId = randomUUID();
      sessionDir = path.join(SESSIONS_ROOT, sessionId);
      await mkdir(sessionDir, { recursive: true });
      const body = req.body || {};
      // Acepta el spec como objeto raiz, o anidado bajo 'spec' (igual que /transcribe)
      spec = body.spec || body;

      if (body.audio_base64) {
        const fs = await import('node:fs/promises');
        const ext = body.audio_filename ? path.extname(body.audio_filename) : '.mp3';
        audioFilePath = path.join(sessionDir, `audio_inline${ext || '.mp3'}`);
        await fs.writeFile(audioFilePath, Buffer.from(body.audio_base64, 'base64'));
      }

      // assets_base64 = { "0": "<b64>", "1": "<b64>", ... } (opcional)
      if (body.assets_base64 && typeof body.assets_base64 === 'object') {
        const fs = await import('node:fs/promises');
        for (const [idxStr, b64] of Object.entries(body.assets_base64)) {
          const idx = parseInt(idxStr, 10);
          if (!Number.isFinite(idx) || !b64) continue;
          const ext = body.assets_filename?.[idxStr] ? path.extname(body.assets_filename[idxStr]) : '.bin';
          const dest = path.join(sessionDir, `asset_inline_${String(idx).padStart(2, '0')}${ext || '.bin'}`);
          await fs.writeFile(dest, Buffer.from(b64, 'base64'));
          assetFilePaths[idx] = dest;
        }
      }
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

/**
 * POST /transcribe — proxy a Groq Whisper.
 *
 * Existe porque el HTTP Request node + Code node de n8n v2.13.3 tienen
 * bugs con multipart/binary que rompen la llamada directa a Groq. El
 * worker la hace en su lugar (Node 20 nativo, sin sandbox restrictivo).
 *
 * Acepta dos formatos:
 *   1) multipart/form-data con campo `audio` (file)
 *   2) application/json con `{ audio_base64, filename, mime_type, language? }`
 *
 * Devuelve el JSON tal cual lo devuelve Groq (verbose_json).
 */
const transcribeUpload = upload.single('audio');
app.post('/transcribe', (req, res, next) => {
  // Si es multipart, pasamos por multer; si no, dejamos pasar para que
  // express.json haya parseado req.body en el middleware global.
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) return transcribeUpload(req, res, next);
  return next();
}, async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(500).json({
      error: 'groq_api_key_missing',
      message: 'GROQ_API_KEY no esta configurada en el entorno del worker',
    });
  }

  let audioBuffer;
  let filename = 'audio.mp3';
  let mimeType = 'audio/mpeg';
  let language = 'es';
  let prompt;

  try {
    if (req.file) {
      // Modo multipart
      const fs = await import('node:fs/promises');
      audioBuffer = await fs.readFile(req.file.path);
      filename = req.file.originalname || filename;
      mimeType = req.file.mimetype || mimeType;
      language = req.body?.language || language;
      prompt = req.body?.prompt;
    } else {
      // Modo JSON con base64
      const body = req.body || {};
      if (!body.audio_base64) {
        return res.status(400).json({ error: 'invalid_request', message: 'Falta audio_base64 en el body JSON' });
      }
      audioBuffer = Buffer.from(body.audio_base64, 'base64');
      filename = body.filename || filename;
      mimeType = body.mime_type || mimeType;
      language = body.language || language;
      prompt = body.prompt;
    }
  } catch (e) {
    return res.status(400).json({ error: 'invalid_request', message: e.message });
  }

  if (mimeType === 'application/octet-stream') mimeType = 'audio/mpeg';

  // Construye FormData (Node 20 nativo) y llama a Groq.
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('language', language);
  if (prompt) form.append('prompt', prompt);

  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
    });
  } catch (e) {
    req.log.error({ err: e.message }, 'groq fetch failed');
    return res.status(502).json({ error: 'groq_unreachable', message: e.message });
  }

  const text = await groqRes.text();
  if (!groqRes.ok) {
    req.log.warn({ status: groqRes.status, body: text.slice(0, 500) }, 'groq returned error');
    return res.status(groqRes.status).json({
      error: 'groq_error',
      status: groqRes.status,
      body: text.slice(0, 2000),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return res.status(502).json({ error: 'groq_bad_json', body: text.slice(0, 2000) });
  }
  res.json(parsed);
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
