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
import { ensureGradientBackground, ensureResizedLogo, ensureOutroPhrasePng, ensureOutroClipsForAllPatterns } from './utils/background.js';
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
    const cursiveFontFile = path.join(FONT_DIR, BRAND.fonts.file_cursive);
    const phrasePngPath = path.join(ASSETS_DIR, 'overlays', 'outro_phrase.png');
    const phraseInfo = await ensureOutroPhrasePng({
      outputPath: phrasePngPath,
      videoW: BRAND.video.width,
      fontFile: cursiveFontFile,
      phraseText: BRAND.outro.phrase_text,
      phraseFontSize: BRAND.outro.phrase_font_size,
      phraseColor: BRAND.outro.phrase_color,
      shadowOffsetX: BRAND.outro.shadow_offset_x,
      shadowOffsetY: BRAND.outro.shadow_offset_y,
      shadowBlur: BRAND.outro.shadow_blur,
      shadowAlpha: BRAND.outro.shadow_alpha,
    }, logger).catch((e) => {
      logger.warn({ err: e.message }, 'outro phrase PNG failed');
      return null;
    });
    if (phraseInfo) {
      // Genera UN outro_clip por pattern (continuidad visual con el reel).
      // El path es {ASSETS_DIR}/overlays/patterns/outro_clip_N.mp4 — composeReel
      // calcula N a partir del sessionBgPath y carga el correspondiente.
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
          phrasePngPath: phraseInfo.path,
          phrasePngHeight: phraseInfo.height,
          logoWidth: targetWidth,
          logoY: pctY(BRAND.outro.logo_y_pct),
          logoFadeInDuration: BRAND.outro.logo_fade_in_duration,
          phraseY: pctY(BRAND.outro.phrase_y_pct),
          phraseTypingStart: BRAND.outro.phrase_typing_start,
          phraseTypingDuration: BRAND.outro.phrase_typing_duration,
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
