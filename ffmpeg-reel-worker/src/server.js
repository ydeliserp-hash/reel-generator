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
import { ensureGradientBackground, ensureResizedLogo, ensureOutroClipsForAllPatterns } from './utils/background.js';
import { BRAND, pctY } from './branding.js';

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
// URL del webhook de n8n al que el dashboard /upload reenvia el MP3.
// Si no esta seteado, el dashboard muestra error al subir.
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

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
    // Acepta `asset` (singular, formato clasico) o `assets` (array, modo
    // remix donde un segmento largo puede tener varias imagenes que se
    // alternan con xfade interno).
    if (Array.isArray(s.assets)) {
      if (s.assets.length === 0) {
        throw new Error(`segment ${i}: assets array cannot be empty`);
      }
      for (let k = 0; k < s.assets.length; k++) {
        const a = s.assets[k];
        if (!a || typeof a !== 'object') {
          throw new Error(`segment ${i}: assets[${k}] must be an object`);
        }
        if (!['image', 'video'].includes(a.type)) {
          throw new Error(`segment ${i}: assets[${k}].type must be 'image' or 'video'`);
        }
      }
    } else {
      if (!s.asset || typeof s.asset !== 'object') {
        throw new Error(`segment ${i}: asset object (or assets[]) is required`);
      }
      if (!['image', 'video'].includes(s.asset.type)) {
        throw new Error(`segment ${i}: asset.type must be 'image' or 'video'`);
      }
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
          // Acepta dos formatos:
          //   asset_N      -> assetFilePaths[N]      (modo clasico, 1 asset por segmento)
          //   asset_N_K    -> assetFilePaths['N_K']  (modo remix, K-esimo asset del segmento N)
          const m = f.fieldname.match(/^asset_(\d+)(?:_(\d+))?$/);
          if (m) {
            if (m[2] === undefined) {
              const idx = parseInt(m[1], 10);
              if (Number.isFinite(idx)) assetFilePaths[idx] = f.path;
            } else {
              assetFilePaths[`${m[1]}_${m[2]}`] = f.path;
            }
          }
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

      // assets_base64 = { "0": "<b64>", "1": "<b64>", ... } (opcional, modo clasico)
      // o tambien con claves compuestas para multi-asset por segmento (modo remix):
      //   { "0_0": "<b64>", "0_1": "<b64>", "1_0": "<b64>", ... }
      // donde "N_K" es el K-esimo asset del segmento N.
      if (body.assets_base64 && typeof body.assets_base64 === 'object') {
        const fs = await import('node:fs/promises');
        for (const [keyStr, b64] of Object.entries(body.assets_base64)) {
          if (!b64) continue;
          const m = String(keyStr).match(/^(\d+)(?:_(\d+))?$/);
          if (!m) continue;
          const ext = body.assets_filename?.[keyStr] ? path.extname(body.assets_filename[keyStr]) : '.bin';
          const safeKey = m[2] !== undefined ? `${m[1]}_${m[2]}` : m[1];
          const dest = path.join(sessionDir, `asset_inline_${safeKey}${ext || '.bin'}`);
          await fs.writeFile(dest, Buffer.from(b64, 'base64'));
          assetFilePaths[safeKey] = dest;
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

  // Modo de respuesta:
  //   - multipart input -> binario (mantiene compatibilidad con tests/smoke)
  //   - JSON input -> JSON con mp4_base64 (evita problemas de encoding en n8n)
  if (!isMultipart) {
    // Modo JSON: devolvemos solo metadatos + URL para descargar el MP4.
    // El MP4 se queda en disco y se descarga en una segunda llamada GET
    // /output/:sessionId. Asi evitamos meter ~10 MB de base64 en JSON
    // que satura la memoria de n8n.
    try {
      const fs = await import('node:fs/promises');
      const stat = await fs.stat(result.outputPath);
      res.setHeader('X-Session-Id', sessionId);
      res.setHeader('X-Compose-Elapsed-Ms', String(result.metadata.elapsed_ms));
      res.setHeader('X-Segment-Count', String(result.metadata.segment_count));
      res.json({
        success: true,
        session_id: sessionId,
        filename: `reel-${sessionId}.mp4`,
        size_bytes: stat.size,
        output_url: `http://ffmpeg-reel-worker:3000/output/${sessionId}`,
        metadata: result.metadata,
      });
      // NO cleanup aqui; cleanup lo hace el endpoint GET /output/:sessionId
      // tras streamear el fichero. Si el cliente nunca descarga, queda
      // huerfano y un cleanup periodico (TODO fase 2) lo borra.
    } catch (err) {
      req.log.error({ err: err.message }, 'failed to stat mp4 for json response');
      res.status(500).json({ error: 'mp4_stat_failed', message: err.message });
      if (!KEEP_SESSIONS) cleanupSession(sessionDir, req.log);
    }
    return;
  }

  // Modo multipart -> stream binario (igual que antes).
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
  // Pedir tanto segments como WORDS individuales con timestamps para que el
  // nodo "Segment Transcript" pueda cortar en signos de puntuacion reales.
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
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

/**
 * GET /output/:sessionId — descarga el MP4 generado por una llamada anterior
 * a /compose en modo JSON. Streamea el fichero (no lo carga en memoria) y
 * limpia la sesion del disco tras servirlo correctamente.
 */
app.get('/output/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'invalid_session_id' });
  }
  const sessionDir = path.join(SESSIONS_ROOT, sessionId);
  const outputPath = path.join(sessionDir, 'output.mp4');

  let stat;
  try {
    const fs = await import('node:fs/promises');
    stat = await fs.stat(outputPath);
  } catch (e) {
    return res.status(404).json({ error: 'output_not_found', session_id: sessionId });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `attachment; filename="reel-${sessionId}.mp4"`);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned || KEEP_SESSIONS) return;
    cleaned = true;
    cleanupSession(sessionDir, req.log);
  };
  res.on('finish', cleanup);
  res.on('close', cleanup);

  const stream = createReadStream(outputPath);
  stream.on('error', (err) => {
    req.log.error({ err: err.message, sessionId }, 'output stream error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'stream_failed', message: err.message });
    }
    cleanup();
  });
  stream.pipe(res);
});

/**
 * GET /upload — dashboard web simple para subir MP3 con drag & drop sin
 * tener que tocar curl. Reenvia el form al webhook de n8n internamente y
 * streamea el MP4 final al navegador.
 */
app.get(['/', '/upload'], async (_req, res) => {
  const html = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<title>Reel Generator — Dra. Ydelise</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(135deg,#0A1F3D,#1B4F8C);color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:rgba(255,255,255,0.06);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:32px;width:100%;max-width:560px;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
  h1{margin:0 0 4px;font-size:24px;font-weight:600}
  .sub{color:#9ec3e8;font-size:14px;margin-bottom:24px}
  .drop{border:2px dashed rgba(255,255,255,0.25);border-radius:12px;padding:32px;text-align:center;cursor:pointer;transition:all 0.2s;margin-bottom:16px}
  .drop:hover,.drop.drag{border-color:#14B8A6;background:rgba(20,184,166,0.06)}
  .drop p{margin:8px 0 0;color:#9ec3e8;font-size:14px}
  .drop strong{color:#fff;font-size:16px}
  .drop .file{color:#F1C40F;margin-top:8px;font-weight:600;display:none}
  input[type=file]{display:none}
  label.field{display:block;margin-bottom:12px}
  label.field span{display:block;font-size:13px;color:#9ec3e8;margin-bottom:6px}
  input[type=text]{width:100%;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:10px 14px;color:#fff;font-size:15px;font-family:inherit}
  input[type=text]:focus{outline:none;border-color:#14B8A6}
  button{width:100%;background:#F1C40F;color:#0A1F3D;border:none;border-radius:8px;padding:14px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;margin-top:8px;transition:all 0.2s}
  button:hover:not(:disabled){background:#fff}
  button:disabled{opacity:0.5;cursor:not-allowed}
  .status{margin-top:20px;padding:16px;background:rgba(0,0,0,0.3);border-radius:8px;font-size:14px;display:none}
  .status.show{display:block}
  .status .timer{color:#F1C40F;font-weight:700;margin-bottom:6px}
  .status .msg{color:#9ec3e8}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#14B8A6;border-radius:50%;animation:spin 0.8s linear infinite;margin-right:8px;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  .download{display:none;margin-top:20px}
  .download a{display:block;background:#14B8A6;color:#fff;text-decoration:none;padding:14px;border-radius:8px;text-align:center;font-weight:600}
  .download a:hover{background:#0e9488}
  .err{color:#fca5a5;margin-top:12px;font-size:14px}
</style>
</head><body>
<div class="card">
  <h1>Reel Generator</h1>
  <div class="sub">Sube tu audio y genera el reel automáticamente</div>

  <form id="form">
    <label class="drop" id="drop">
      <strong>Arrastra tu MP3 aquí</strong>
      <p>o haz click para seleccionar</p>
      <div class="file" id="filename"></div>
      <input type="file" id="audio" name="audio" accept="audio/mpeg,audio/mp3,audio/wav,audio/m4a" required>
    </label>

    <label class="field">
      <span>Título del reel</span>
      <input type="text" id="topic" name="topic" placeholder="Ej: Café y corazón" required>
    </label>

    <label class="field">
      <span>Estilo (opcional)</span>
      <input type="text" id="style" name="style" placeholder="educational" value="educational">
    </label>

    <label class="drop" id="dropImgs" style="border-color:rgba(241,196,15,0.35)">
      <strong style="color:#F1C40F">Imágenes propias (opcional — modo remix)</strong>
      <p>Arrastra varias imágenes desde tu carpeta local. Si vacío, se generan con IA.</p>
      <div class="file" id="imgsCount" style="color:#F1C40F"></div>
      <input type="file" id="imgs" name="imgs" accept="image/png,image/jpeg,image/jpg,image/webp" multiple>
    </label>

    <button type="submit" id="submit">Generar reel</button>
  </form>

  <div class="status" id="status">
    <div class="timer"><span class="spinner"></span><span id="elapsed">0:00</span></div>
    <div class="msg" id="msg">Subiendo audio…</div>
  </div>

  <div class="download" id="download">
    <a id="downloadLink" download="reel.mp4">⬇ Descargar reel</a>
  </div>
</div>

<script>
const drop = document.getElementById('drop');
const audioIn = document.getElementById('audio');
const filenameEl = document.getElementById('filename');
const form = document.getElementById('form');
const submitBtn = document.getElementById('submit');
const status = document.getElementById('status');
const elapsed = document.getElementById('elapsed');
const msg = document.getElementById('msg');
const downloadDiv = document.getElementById('download');
const downloadLink = document.getElementById('downloadLink');

['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('drag')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,()=>drop.classList.remove('drag')));
drop.addEventListener('drop',ev=>{
  ev.preventDefault();
  if(ev.dataTransfer.files[0]){
    audioIn.files=ev.dataTransfer.files;
    showFilename();
  }
});
audioIn.addEventListener('change', showFilename);
function showFilename(){
  if(audioIn.files[0]){
    filenameEl.textContent='📎 '+audioIn.files[0].name;
    filenameEl.style.display='block';
    if(!document.getElementById('topic').value){
      // sugerir topic a partir del filename
      const name=audioIn.files[0].name.replace(/\\.[^.]+$/,'').replace(/[-_]/g,' ');
      document.getElementById('topic').value=name.charAt(0).toUpperCase()+name.slice(1);
    }
  }
}

// Dropzone secundaria: imagenes propias (modo remix). Drag desde local
// (carpeta de descargas, etc.). Multiples archivos. Solo imagenes.
const dropImgs = document.getElementById('dropImgs');
const imgsIn = document.getElementById('imgs');
const imgsCount = document.getElementById('imgsCount');
['dragover','dragenter'].forEach(e=>dropImgs.addEventListener(e,ev=>{ev.preventDefault();dropImgs.classList.add('drag')}));
['dragleave','drop'].forEach(e=>dropImgs.addEventListener(e,()=>dropImgs.classList.remove('drag')));
dropImgs.addEventListener('drop',ev=>{
  ev.preventDefault();
  if(ev.dataTransfer.files && ev.dataTransfer.files.length>0){
    // Filtrar solo imagenes
    const accepted=Array.from(ev.dataTransfer.files).filter(f=>/^image\\//.test(f.type));
    const dt=new DataTransfer();
    accepted.forEach(f=>dt.items.add(f));
    imgsIn.files=dt.files;
    showImgsCount();
  }
});
imgsIn.addEventListener('change', showImgsCount);
function showImgsCount(){
  const n=imgsIn.files?imgsIn.files.length:0;
  if(n>0){
    imgsCount.textContent='📷 '+n+' imagen'+(n>1?'es':'')+' seleccionada'+(n>1?'s':'')+' (modo REMIX)';
    imgsCount.style.display='block';
  }else{
    imgsCount.style.display='none';
  }
}

const stages=[
  [0,'Subiendo audio…'],
  [10,'Transcribiendo con Whisper…'],
  [25,'Planificando imágenes con IA…'],
  [40,'Generando imágenes con Gemini…'],
  [120,'Componiendo segmentos…'],
  [180,'Aplicando subtítulos y firma…'],
  [220,'Mezclando música y outro…'],
  [260,'Subiendo a Drive…'],
];
function updateStage(secs){
  let stage=stages[0][1];
  for(const [t,s] of stages) if(secs>=t) stage=s;
  msg.textContent=stage;
}
function fmt(s){const m=Math.floor(s/60),x=s%60;return m+':'+String(x).padStart(2,'0')}

form.addEventListener('submit', async ev=>{
  ev.preventDefault();
  if(!audioIn.files[0]){alert('Selecciona un MP3');return}
  submitBtn.disabled=true;
  submitBtn.textContent='Generando…';
  status.classList.add('show');
  downloadDiv.style.display='none';

  const fd=new FormData();
  fd.append('audio',audioIn.files[0]);
  fd.append('topic',document.getElementById('topic').value);
  fd.append('style',document.getElementById('style').value||'educational');
  // Modo remix: anadir imagenes propias si las hay (campos image_0..image_N)
  if(imgsIn.files && imgsIn.files.length>0){
    Array.from(imgsIn.files).forEach((f,i)=>fd.append('image_'+i,f,f.name));
    fd.append('remix','1');
  }

  const t0=Date.now();
  const tick=setInterval(()=>{
    const secs=Math.floor((Date.now()-t0)/1000);
    elapsed.textContent=fmt(secs);
    updateStage(secs);
  },500);

  try{
    const r=await fetch('/upload',{method:'POST',body:fd});
    clearInterval(tick);
    if(!r.ok){
      const t=await r.text();
      msg.innerHTML='<span class="err">Error: '+t.slice(0,200)+'</span>';
      submitBtn.disabled=false;
      submitBtn.textContent='Generar reel';
      return;
    }
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    downloadLink.href=url;
    downloadLink.download='reel_'+Date.now()+'.mp4';
    msg.textContent='✓ Reel listo en '+fmt(Math.floor((Date.now()-t0)/1000));
    downloadDiv.style.display='block';
    submitBtn.disabled=false;
    submitBtn.textContent='Generar otro';
  }catch(e){
    clearInterval(tick);
    msg.innerHTML='<span class="err">Error de red: '+e.message+'</span>';
    submitBtn.disabled=false;
    submitBtn.textContent='Generar reel';
  }
});
</script>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/**
 * POST /upload — proxy del dashboard al webhook de n8n.
 * Recibe multipart con audio + topic + style + (opcional) image_0..image_N
 * para modo remix. Reenvia todo a N8N_WEBHOOK_URL y streamea la respuesta
 * (MP4 binario) al navegador.
 */
// upload.any() permite que vengan audio + image_N junto. Multer pone los
// archivos en req.files (array), no en req.file.
const dashboardUpload = upload.any();
app.post('/upload', dashboardUpload, async (req, res) => {
  if (!N8N_WEBHOOK_URL) {
    return res.status(503).json({ error: 'n8n_webhook_not_configured', message: 'Set N8N_WEBHOOK_URL env var' });
  }
  const audioFile = (req.files || []).find((f) => f.fieldname === 'audio');
  if (!audioFile) {
    return res.status(400).json({ error: 'no_audio_file' });
  }
  const imageFiles = (req.files || []).filter((f) => /^image_\d+$/.test(f.fieldname));
  // Ordenar por indice numerico para preservar el orden del usuario
  imageFiles.sort((a, b) => {
    const ai = parseInt(a.fieldname.slice('image_'.length), 10);
    const bi = parseInt(b.fieldname.slice('image_'.length), 10);
    return ai - bi;
  });
  const isRemixMode = imageFiles.length > 0;
  const topic = (req.body?.topic || '').toString();
  const style = (req.body?.style || 'educational').toString();
  // El multer global usa diskStorage, asi que el archivo esta en .path
  // (no en .buffer). Lo leemos del disco antes de reenviar a n8n.
  const fs = await import('node:fs/promises');
  const audioBuffer = await fs.readFile(audioFile.path);
  const audioName = audioFile.originalname || 'audio.mp3';
  const audioMime = audioFile.mimetype || 'audio/mpeg';

  try {
    const form = new FormData();
    form.append('audio', new Blob([audioBuffer], { type: audioMime }), audioName);
    form.append('topic', topic);
    form.append('style', style);
    if (isRemixMode) form.append('remix', '1');
    // Forward de las imagenes propias (modo remix)
    for (let i = 0; i < imageFiles.length; i++) {
      const f = imageFiles[i];
      const buf = await fs.readFile(f.path);
      form.append(`image_${i}`, new Blob([buf], { type: f.mimetype || 'image/jpeg' }), f.originalname || `image_${i}.jpg`);
    }

    req.log.info(
      { topic, audioName, audioBytes: audioBuffer.length, remix: isRemixMode, imagesCount: imageFiles.length },
      'forwarding upload to n8n webhook'
    );
    const upstream = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      body: form,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      req.log.warn({ status: upstream.status, body: text.slice(0, 500) }, 'n8n webhook returned error');
      return res.status(upstream.status).type('text/plain').send(text.slice(0, 1000) || `n8n returned ${upstream.status}`);
    }

    // Streamea el MP4 binary al navegador
    const ct = upstream.headers.get('content-type') || 'video/mp4';
    const cd = upstream.headers.get('content-disposition');
    res.setHeader('Content-Type', ct);
    if (cd) res.setHeader('Content-Disposition', cd);
    if (upstream.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    }
  } catch (e) {
    req.log.error({ err: e.message }, 'upload proxy failed');
    res.status(502).type('text/plain').send('Error reenviando a n8n: ' + e.message);
  }
});

/**
 * GET /assets/:sessionId — devuelve JSON con la lista de assets generados
 * (imagenes Gemini, fallbacks Pexels, etc.) en esa sesion. Cada asset
 * incluye su filename, size y URL relativa para descargarlo via
 * /assets/:sessionId/:filename.
 *
 * Util para que n8n descargue las imagenes y las suba a Google Drive antes
 * de descargar el MP4 final (que trigger la limpieza de la sesion).
 */
app.get('/assets/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'invalid_session_id' });
  }
  const sessionDir = path.join(SESSIONS_ROOT, sessionId);
  try {
    const fs = await import('node:fs/promises');
    const files = await fs.readdir(sessionDir);
    // Filtramos a los assets de imagen/video que entraron como input para
    // los segmentos (asset_NN.*, asset_NN_gemini.png, asset_NN_fb.jpg).
    const assetFiles = files.filter((f) => /^(asset_\d+(_gemini|_fb)?|cover)\.(png|jpg|jpeg|mp4)$/i.test(f));
    const assets = await Promise.all(
      assetFiles.map(async (filename) => {
        const stat = await fs.stat(path.join(sessionDir, filename));
        return {
          filename,
          size: stat.size,
          url: `/assets/${sessionId}/${filename}`,
        };
      })
    );
    res.json({ session_id: sessionId, count: assets.length, assets });
  } catch (e) {
    return res.status(404).json({ error: 'session_not_found', session_id: sessionId });
  }
});

/**
 * GET /assets/:sessionId/:filename — sirve un asset individual de la sesion.
 * No hace cleanup (eso lo hace /output/:sessionId al descargar el MP4).
 */
app.get('/assets/:sessionId/:filename', async (req, res) => {
  const sessionId = req.params.sessionId;
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'invalid_session_id' });
  }
  // Bloquear path traversal: el filename solo puede tener caracteres seguros.
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) {
    return res.status(400).json({ error: 'invalid_filename' });
  }
  const filePath = path.join(SESSIONS_ROOT, sessionId, filename);
  let stat;
  try {
    const fs = await import('node:fs/promises');
    stat = await fs.stat(filePath);
  } catch {
    return res.status(404).json({ error: 'asset_not_found', session_id: sessionId, filename });
  }
  // Content-Type segun extension
  const ext = filename.split('.').pop().toLowerCase();
  const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4' };
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  createReadStream(filePath).pipe(res);
});

/**
 * GET /patterns — pagina HTML con los 15 fondos disponibles para los reels.
 * Util para inspeccionar visualmente cuales rotan y elegir favoritos.
 */
app.get('/patterns', async (req, res) => {
  const labels = [
    '0 - Plexus',
    '1 - Poligonos',
    '2 - Grid 3D perspectiva',
    '3 - ADN doble helice',
    '4 - Particulas bioluminiscentes',
    '5 - Sinapsis fluidas',
    '6 - Lluvia digital tenue',
    '7 - Malla organica curva',
    '8 - Capas de ondas profundas',
    '9 - Lineas topograficas suaves',
    '10 - Constelacion tenue',
  ];
  const tiles = labels.map((label, idx) => `
    <figure>
      <img src="/patterns/${idx}.png" alt="${label}" loading="lazy">
      <figcaption>${label}</figcaption>
    </figure>
  `).join('');
  const html = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<title>Fondos disponibles para reels</title>
<style>
  body { background:#0A1F3D; color:#fff; font-family: system-ui, sans-serif; margin:0; padding:24px; }
  h1 { margin: 0 0 24px 0; font-size: 24px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
  figure { margin:0; background:#1B4F8C; border-radius: 8px; overflow:hidden; }
  figure img { width:100%; height:auto; display:block; }
  figcaption { padding: 10px 12px; font-size: 14px; color:#F1C40F; }
</style>
</head><body>
<h1>Fondos disponibles para los reels (15)</h1>
<div class="grid">${tiles}</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/**
 * GET /patterns/:idx.png — sirve el PNG de un pattern especifico (0..14).
 */
app.get('/patterns/:idx.png', async (req, res) => {
  const idx = parseInt(req.params.idx, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx > 99) {
    return res.status(400).json({ error: 'invalid_idx' });
  }
  const patternPath = path.join(ASSETS_DIR, 'overlays', 'patterns', `bg_pattern_${idx}.png`);
  let stat;
  try {
    const fs = await import('node:fs/promises');
    stat = await fs.stat(patternPath);
  } catch {
    return res.status(404).json({ error: 'pattern_not_found', idx });
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  createReadStream(patternPath).pipe(res);
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
//
// Estrategia: el server arranca a escuchar el puerto INMEDIATAMENTE para que
// los healthchecks de EasyPanel pasen, y las tareas pesadas (generar 11
// patterns + 11 outro_clips, ~2-3 minutos) se ejecutan en segundo plano.
//
// Si llega una request /compose mientras el bootstrap aun no terminado, el
// codigo de compose hara fallback graceful (sin outro o con bg fallback)
// porque cada paso es best-effort.
async function bootstrap() {
  await mkdir(SESSIONS_ROOT, { recursive: true }).catch(() => {});
  // Bake gradient background (best-effort; el modulo cae a color solido si falla).
  const overlayPath = path.join(ASSETS_DIR, 'overlays', 'bg_gradient.png');
  await ensureGradientBackground(overlayPath, logger).catch((e) => {
    logger.warn({ err: e.message }, 'background bake failed (continuing with solid color)');
  });

  // Pre-renderizar el clip outro como MP4 completo (fondo navy + logo +
  // frase + silencio) UNA VEZ al arrancar. composeReel concatena este clip
  // al final del video principal con `-c copy` (sin reencode), evitando
  // procesar overlay en cada frame del video.
  if (BRAND.outro?.enabled) {
    const originalLogo = path.join(ASSETS_DIR, 'overlays', BRAND.outro.logo_file);
    const resizedLogo = path.join(ASSETS_DIR, 'overlays', 'logo_firma_resized.png');
    const targetWidth = Math.round(BRAND.video.width * BRAND.outro.logo_width_pct);
    await ensureResizedLogo(originalLogo, resizedLogo, targetWidth, logger).catch((e) => {
      logger.warn({ err: e.message }, 'logo resize failed (continuing with original)');
    });
    // Slogan: PNG disenado por la doctora. Verificamos que existe antes de
    // generar los outro_clips. Si no existe, no se generan los outros (los
    // reels saldran sin outro).
    const sloganPath = path.join(ASSETS_DIR, 'overlays', BRAND.outro.slogan_file);
    let sloganExists = false;
    try {
      const fs = await import('node:fs/promises');
      await fs.stat(sloganPath);
      sloganExists = true;
    } catch {
      logger.warn({ sloganPath }, 'slogan file no existe en assets/overlays/, outro skip');
    }
    if (sloganExists) {
      // Genera UN outro_clip por pattern (continuidad visual con el reel).
      const patternsDir = path.join(ASSETS_DIR, 'overlays', 'patterns');
      await ensureOutroClipsForAllPatterns(
        {
          videoW: BRAND.video.width,
          videoH: BRAND.video.height,
          fps: BRAND.video.fps,
          duration: BRAND.outro.duration,
          crf: BRAND.video.crf,
          preset: BRAND.video.preset,
          audioBitrate: BRAND.video.audio_bitrate,
          originalLogoPath: resizedLogo,
          sloganPath,
          logoWidth: targetWidth,
          logoCenterY: pctY(BRAND.outro.logo_y_pct),
          logoFadeInDuration: BRAND.outro.logo_fade_in_duration,
          sloganFadeInStart: BRAND.outro.slogan_fade_in_start,
          sloganFadeInDuration: BRAND.outro.slogan_fade_in_duration,
          backdropColor: BRAND.outro.backdrop_color,
          shadowOffsetX: BRAND.outro.shadow_offset_x,
          shadowOffsetY: BRAND.outro.shadow_offset_y,
          shadowBlur: BRAND.outro.shadow_blur,
          shadowAlpha: BRAND.outro.shadow_alpha,
        },
        patternsDir,
        overlayPath,
        logger
      ).catch((e) => {
        logger.warn({ err: e.message }, 'outro clips per-pattern failed (reels saldran sin outro)');
      });
    }
  }

  logger.info('bootstrap completo (patterns + outro clips listos)');
}

// 1) Arrancar el server INMEDIATAMENTE (healthchecks pasan rapido).
app.listen(PORT, () => {
  logger.info(
    { port: PORT, sessionsRoot: SESSIONS_ROOT, fontDir: FONT_DIR },
    'ffmpeg-reel-worker listening (bootstrap en background)'
  );
});

// 2) Lanzar bootstrap en segundo plano (no bloquea el listen).
bootstrap().catch((e) => {
  logger.error({ err: e.message }, 'bootstrap failed (worker sigue corriendo, reels pueden tener fallbacks)');
});
