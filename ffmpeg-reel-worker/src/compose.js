/**
 * Composicion FFmpeg en 3 fases (cada una escribe a disco para facilitar debug):
 *
 *   1) Pre-procesar cada segmento -> seg_NN.mp4 (1080x1920, 30fps, sin audio)
 *      - Imagenes con Ken Burns variado (zoompan).
 *      - Videos centrados sobre fondo navy con scale + pad.
 *
 *   2) Concatenar segmentos con xfade -> concat.mp4
 *      visual_dur[i] = audio_dur[i] + xfade_dur     (si i < N-1)
 *      visual_dur[N-1] = audio_dur[N-1]
 *      offset xfade k = sum(audio_dur[0..k])
 *      => video total = sum(audio_dur)  (sincroniza con el audio)
 *
 *   3) Aplicar audio + subtitulos ASS + barra firma + (opcional) badge titulo
 *      -> output.mp4 (H.264 CRF 20, AAC 192k, faststart).
 */

import { spawn } from 'node:child_process';
import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BRAND,
  ffmpegColor,
  ffmpegColorAlpha,
  pctY,
} from './branding.js';
import { writeSubtitleFile } from './subtitles.js';
import { downloadToFile, extFromUrl } from './utils/download.js';
import { probeDuration } from './utils/probe.js';
import { listBackgroundPatterns } from './utils/background.js';

// Coordenadas derivadas del branding (en px, sistema FFmpeg con origen arriba-izquierda).
const ASSET_TOP_Y = pctY(BRAND.positions.asset_top_pct);
const ASSET_BOTTOM_Y = pctY(BRAND.positions.asset_bottom_pct);
const ASSET_AREA_HEIGHT = ASSET_BOTTOM_Y - ASSET_TOP_Y;
const SIG_BAR_Y = pctY(BRAND.positions.signature_bar_y_pct) - Math.floor(BRAND.signature.bar_height / 2);

// Path al PNG de fondo navy degradado (lo hornea utils/background.js al arranque).
const BG_GRADIENT_PATH = path.join(process.env.ASSETS_DIR || '/app/assets', 'overlays', 'bg_gradient.png');

// Cache de patterns disponibles (descubierto al primer compose).
let _bgPatternsCache = null;
async function loadBgPatterns() {
  if (_bgPatternsCache === null) {
    _bgPatternsCache = await listBackgroundPatterns(BG_GRADIENT_PATH);
  }
  return _bgPatternsCache;
}

/**
 * Elige UN pattern por sesion (todos los segmentos del reel comparten el
 * mismo fondo). El hash del sessionDir/sessionKey hace que reels distintos
 * obtengan fondos distintos pero el mismo reel sea consistente.
 */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}
async function pickBgForSession(sessionKey) {
  const patterns = await loadBgPatterns();
  if (patterns.length === 0) return BG_GRADIENT_PATH;
  return patterns[hashString(sessionKey) % patterns.length];
}

/**
 * Genera una imagen con Google AI Studio. Prueba varios modelos en orden
 * porque la disponibilidad de Imagen via AI Studio cambia y depende de la
 * cuenta/region. Devuelve destPath si OK, o lanza Error agregado si todos
 * fallan.
 *
 * Soporta dos tipos de endpoint:
 *  - generateContent (Gemini 2.0/2.5 Flash con image generation)
 *  - predict (Imagen via AI Studio o Vertex)
 */
async function generateImageWithGemini(prompt, destPath, logger) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurado en el worker');

  // Lista de modelos candidatos en orden de preferencia (probados en cascada).
  // Se puede sobrescribir con env GEMINI_IMAGEN_MODEL para forzar uno especifico.
  // Confirmados disponibles en AI Studio paid tier (mayo 2026).
  // Orden: primero modelos Gemini multimodales (disponibles en Nivel 1 paid),
  // luego Imagen (que pueden requerir Nivel 2+ y devolver "Imagen 3 is only
  // available on paid plans" incluso estando en paid).
  const candidates = [
    process.env.GEMINI_IMAGEN_MODEL,
    'gemini-2.5-flash-image',                 // Gemini 2.5 multimodal (estable, Nivel 1 OK)
    'gemini-3.1-flash-image-preview',         // Gemini 3.1 preview
    'gemini-3-pro-image-preview',             // Gemini 3 Pro preview
    'imagen-4.0-fast-generate-001',          // Imagen 4 fast (puede requerir Nivel 2)
    'imagen-4.0-generate-001',                // Imagen 4 standard
    'imagen-4.0-ultra-generate-001',          // Imagen 4 ultra
  ].filter(Boolean);

  const errors = [];
  for (const model of candidates) {
    const isImagenPredict = model.startsWith('imagen-');
    const method = isImagenPredict ? 'predict' : 'generateContent';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}?key=${apiKey}`;

    let body;
    if (isImagenPredict) {
      body = {
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: '3:4', personGeneration: 'allow_adult' },
      };
    } else {
      // Gemini 2.x con image generation: usa generateContent con responseModalities
      body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      };
    }

    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errors.push(`${model}:${res.status}:${text.slice(0, 100)}`);
        continue;
      }

      const data = await res.json();

      // Extraer base64 segun el formato de respuesta del modelo
      let b64;
      if (isImagenPredict) {
        b64 = data?.predictions?.[0]?.bytesBase64Encoded;
      } else {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
        b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
      }

      if (!b64) {
        errors.push(`${model}:no-image:${JSON.stringify(data).slice(0, 100)}`);
        continue;
      }

      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length < 1000) {
        errors.push(`${model}:tiny:${buffer.length}`);
        continue;
      }

      await writeFile(destPath, buffer);
      logger?.info?.({ destPath, model, bytes: buffer.length, elapsedMs: Date.now() - t0 }, 'gemini image generated');
      return destPath;
    } catch (e) {
      errors.push(`${model}:exception:${e.message?.slice(0, 100)}`);
    }
  }

  throw new Error(`gemini todos los modelos fallaron: ${errors.join(' | ')}`);
}

/**
 * Ejecuta ffmpeg con los args dados. Resuelve con stderr al exit 0,
 * rechaza con tail de stderr al exit != 0.
 */
function runFfmpeg(args, logger, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    logger?.info?.({ label }, 'spawning ffmpeg');
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const elapsedMs = Date.now() - t0;
      if (code === 0) {
        logger?.info?.({ label, elapsedMs }, 'ffmpeg done');
        resolve({ stderr });
      } else {
        const tail = stderr.split('\n').slice(-40).join('\n');
        logger?.error?.({ label, code, elapsedMs }, 'ffmpeg failed');
        reject(new Error(`ffmpeg exited with code ${code}\n${tail}`));
      }
    });
  });
}

/**
 * Ejecuta `tasks` en lotes de `concurrency`, no todos en paralelo.
 * Devuelve un array con los resultados en el mismo orden.
 */
async function runWithConcurrency(tasks, concurrency = 2) {
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/**
 * Escapa una cadena para meterla DENTRO de un argumento `key='valor'`
 * de un filtro FFmpeg (drawtext, ass, etc). Solo necesitamos escapar
 * la propia comilla simple y el backslash.
 */
function escapeFilterSingleQuoted(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/**
 * Variantes de Ken Burns: alterna por indice de segmento para evitar
 * sensacion mecanica. El `hint` opcional del spec puede forzar una variante.
 */
function kenBurnsExpr(segIndex, durationFrames, hint) {
  const denom = Math.max(durationFrames - 1, 1);
  const variants = [
    // 0: zoom in centrado
    {
      z: `min(1.15,1+0.15*on/${denom})`,
      x: 'iw/2-(iw/zoom/2)',
      y: 'ih/2-(ih/zoom/2)',
    },
    // 1: pan horizontal izq -> der con leve zoom
    {
      z: `min(1.10,1+0.10*on/${denom})`,
      x: `(iw-iw/zoom)*on/${denom}`,
      y: 'ih/2-(ih/zoom/2)',
    },
    // 2: zoom in con drift hacia arriba
    {
      z: `min(1.12,1+0.12*on/${denom})`,
      x: 'iw/2-(iw/zoom/2)',
      y: `(ih-ih/zoom)*(1-on/${denom})`,
    },
  ];
  if (hint?.to === 'zoom_in') return variants[0];
  if (hint?.to === 'pan_right') return variants[1];
  if (hint?.to === 'drift_up') return variants[2];
  return variants[segIndex % variants.length];
}

/**
 * Fase 1: pre-procesa una imagen estatica con Ken Burns sutil.
 */
async function buildImageSegment(
  { assetPath, duration, outputPath, segIndex, kenBurnsHint, bgPath },
  logger
) {
  const fps = BRAND.video.fps;
  const frames = Math.max(Math.round(duration * fps), 1);
  const kb = kenBurnsExpr(segIndex, frames, kenBurnsHint);
  const padColor = ffmpegColor(BRAND.colors.bg_dark);
  const W = BRAND.video.width;
  const H = BRAND.video.height;

  // Ken Burns ligero: pre-escalo el asset un 20% mas grande que el area,
  // luego hago crop animado (pan o zoom) basado en el indice del segmento.
  // Mas barato computacionalmente que zoompan y visualmente equivalente.
  const preScale = 1.2;
  const cropW = Math.round(W);
  const cropH = ASSET_AREA_HEIGHT;
  const scaledW = Math.round(W * preScale);
  const scaledH = Math.round(ASSET_AREA_HEIGHT * preScale);
  const dx = scaledW - cropW;   // margen horizontal para pan
  const dy = scaledH - cropH;   // margen vertical para pan
  const dur = Math.max(duration, 0.1);

  // 4 variantes alternadas por segIndex para variedad visual
  const variant = segIndex % 4;
  let cropX, cropY;
  if (variant === 0) {
    // Pan izq -> der
    cropX = `${dx}*t/${dur}`;
    cropY = `${Math.round(dy / 2)}`;
  } else if (variant === 1) {
    // Zoom in (centrado)
    cropX = `${Math.round(dx / 2)}`;
    cropY = `${Math.round(dy / 2)}`;
    // Para zoom usamos scale animada en vez de crop
  } else if (variant === 2) {
    // Pan der -> izq
    cropX = `${dx}-${dx}*t/${dur}`;
    cropY = `${Math.round(dy / 2)}`;
  } else {
    // Drift diagonal (arriba-izq -> abajo-der)
    cropX = `${dx}*t/${dur}`;
    cropY = `${dy}*t/${dur}`;
  }

  // Filter complex: bg_gradient como base, asset con Ken Burns superpuesto
  // en el area de asset (centrado horizontal, en ASSET_TOP_Y vertical).
  const assetFilter = [
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase`,
    `crop=${scaledW}:${scaledH}`,
    `crop=${cropW}:${cropH}:'${cropX}':'${cropY}'`,
  ].join(',');
  const filterComplex = [
    `[0:v]scale=${W}:${H}[bg]`,
    `[1:v]${assetFilter}[asset]`,
    `[bg][asset]overlay=(W-overlay_w)/2:${ASSET_TOP_Y}+(${ASSET_AREA_HEIGHT}-overlay_h)/2[v]`,
    `[v]fps=${fps},format=yuv420p[vout]`,
  ].join(';');

  const args = [
    '-y',
    '-loop', '1', '-i', bgPath,
    '-loop', '1', '-i', assetPath,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-t', duration.toString(),
    '-r', fps.toString(),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '21',
    '-an',
    outputPath,
  ];
  await runFfmpeg(args, logger);
  return outputPath;
}

/**
 * Fase 1: pre-procesa un video, recortado a `duration` segundos a partir
 * de `trimStart`. Si el video original es mas corto, hace loop.
 */
async function buildVideoSegment(
  { assetPath, duration, trimStart = 0, outputPath, segIndex = 0, bgPath },
  logger
) {
  const fps = BRAND.video.fps;
  const padColor = ffmpegColor(BRAND.colors.bg_dark);
  const W = BRAND.video.width;
  const H = BRAND.video.height;

  // Filter complex: bg_gradient como base, video escalado superpuesto en asset_area.
  const safeAreaW = W - 2;
  const safeAreaH = ASSET_AREA_HEIGHT - 2;
  const assetFilter = `scale=${safeAreaW}:${safeAreaH}:force_original_aspect_ratio=decrease`;
  const filterComplex = [
    `[0:v]scale=${W}:${H}[bg]`,
    `[1:v]${assetFilter}[asset]`,
    `[bg][asset]overlay=(W-overlay_w)/2:${ASSET_TOP_Y}+(${ASSET_AREA_HEIGHT}-overlay_h)/2[v]`,
    `[v]fps=${fps},format=yuv420p[vout]`,
  ].join(';');

  const args = [
    '-y',
    '-loop', '1', '-i', bgPath,               // input 0: bg gradient (1 por sesion)
    '-stream_loop', '-1',                     // loop input 1 (video)
    '-ss', trimStart.toString(),
    '-i', assetPath,                          // input 1: video asset
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-t', duration.toString(),
    '-r', fps.toString(),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '21',
    '-an',
    outputPath,
  ];
  await runFfmpeg(args, logger);
  return outputPath;
}

/**
 * Fase 2: concatena los segmentos con xfade.
 * Para N segmentos calcula offsets como cumsum(audioDur).
 */
async function concatenateWithXfade(
  { segmentPaths, audioDurations, outputPath },
  logger
) {
  if (segmentPaths.length === 0) {
    throw new Error('concatenateWithXfade: no segments');
  }
  if (segmentPaths.length === 1) {
    // Caso trivial: copia directa.
    const args = ['-y', '-i', segmentPaths[0], '-c', 'copy', outputPath];
    await runFfmpeg(args, logger);
    return outputPath;
  }

  const xfadeDur = BRAND.video.xfade_duration;
  const xfadeName = BRAND.video.xfade_transition;

  const inputs = segmentPaths.flatMap((p) => ['-i', p]);
  const filters = [];
  let prevLabel = '[0:v]';
  let cumulative = 0;
  for (let i = 1; i < segmentPaths.length; i++) {
    cumulative += audioDurations[i - 1];
    const outLabel = i === segmentPaths.length - 1 ? '[vout]' : `[v${i}]`;
    filters.push(
      `${prevLabel}[${i}:v]xfade=transition=${xfadeName}:duration=${xfadeDur}:offset=${cumulative.toFixed(3)}${outLabel}`
    );
    prevLabel = outLabel;
  }

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '21',
    '-an',
    outputPath,
  ];
  await runFfmpeg(args, logger);
  return outputPath;
}

/**
 * Fase 3: aplica audio + subtitulos + firma + badge sobre el video concatenado.
 */
async function applyOverlays(
  {
    videoPath,
    audioPath,
    subtitlePath,
    signatureText,
    titleBadge,
    fontDir,
    outputPath,
  },
  logger
) {
  const sigBarColor = ffmpegColorAlpha(BRAND.colors.bg_dark, BRAND.signature.bar_alpha);
  const sigTextColor = ffmpegColor(BRAND.colors.text_primary);
  const goldColor = ffmpegColor(BRAND.colors.accent_gold);
  const navyColor = ffmpegColor(BRAND.colors.bg_dark);

  // FFmpeg en Linux usa rutas POSIX. Normalizamos `\` a `/` por si el worker
  // se ejecuta en Windows durante desarrollo local.
  const sigFontFile = path.posix.join(fontDir.replace(/\\/g, '/'), BRAND.fonts.file_signature);
  const titleFontFile = path.posix.join(fontDir.replace(/\\/g, '/'), BRAND.fonts.file_title);
  const subtitlePathPosix = subtitlePath.replace(/\\/g, '/');

  const filters = [];

  // Capa 1: subtitulos quemados (renderer libass via filtro `ass`).
  filters.push(`ass='${escapeFilterSingleQuoted(subtitlePathPosix)}'`);

  // Capa 2: barra navy semitransparente al pie + firma centrada.
  filters.push(
    `drawbox=x=0:y=${SIG_BAR_Y}:w=${BRAND.video.width}:h=${BRAND.signature.bar_height}:color=${sigBarColor}:t=fill`
  );
  const sigTextY = SIG_BAR_Y + Math.round((BRAND.signature.bar_height - BRAND.signature.font_size) / 2) - 4;
  filters.push(
    [
      `drawtext=fontfile='${escapeFilterSingleQuoted(sigFontFile)}'`,
      `text='${escapeFilterSingleQuoted(signatureText || BRAND.signature.text)}'`,
      `fontsize=${BRAND.signature.font_size}`,
      `fontcolor=${sigTextColor}`,
      'x=(w-text_w)/2',
      `y=${sigTextY}`,
    ].join(':')
  );

  // Capa 3 (opcional): badge titulo dorado.
  // Por defecto se muestra DURANTE TODO el video. Si titleBadge.duration es
  // un numero positivo, solo aparece esos segundos iniciales.
  // TODO: esquinas redondeadas con PNG alpha pre-renderizado.
  if (titleBadge?.show && titleBadge.text) {
    const dur = typeof titleBadge.duration === 'number' && titleBadge.duration > 0
      ? titleBadge.duration
      : null; // null = siempre visible
    const fontSize = BRAND.title_badge.font_size;
    const padH = BRAND.title_badge.horizontal_padding;
    const padV = BRAND.title_badge.vertical_padding;
    const approxBadgeWidth = Math.min(
      BRAND.video.width - 80,
      Math.round(titleBadge.text.length * fontSize * 0.55 + padH * 2)
    );
    const approxBadgeHeight = fontSize + padV * 2;
    const badgeY = pctY(BRAND.positions.title_badge_y_pct);
    const badgeX = Math.round((BRAND.video.width - approxBadgeWidth) / 2);
    const enableClause = dur ? `:enable='lt(t,${dur})'` : '';
    filters.push(
      `drawbox=x=${badgeX}:y=${badgeY}:w=${approxBadgeWidth}:h=${approxBadgeHeight}:color=${navyColor}:t=fill${enableClause}`
    );
    const drawtextParts = [
      `drawtext=fontfile='${escapeFilterSingleQuoted(titleFontFile)}'`,
      `text='${escapeFilterSingleQuoted(titleBadge.text)}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${goldColor}`,
      'x=(w-text_w)/2',
      `y=${badgeY + padV}`,
    ];
    if (dur) drawtextParts.push(`enable='lt(t,${dur})'`);
    filters.push(drawtextParts.join(':'));
  }

  const vf = filters.join(',');

  const args = [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-filter_complex', `[0:v]${vf}[v]`,
    '-map', '[v]',
    '-map', '1:a',
    '-c:v', 'libx264',
    '-preset', BRAND.video.preset,
    '-crf', BRAND.video.crf.toString(),
    '-c:a', 'aac',
    '-b:a', BRAND.video.audio_bitrate,
    '-r', BRAND.video.fps.toString(),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    // Sin -shortest: el output dura lo del stream mas largo. Asi el audio
    // siempre se reproduce hasta el final, aunque el video acabe antes
    // (en cuyo caso se queda en frame congelado el ultimo instante).
    outputPath,
  ];
  await runFfmpeg(args, logger);
  return outputPath;
}

/**
 * Orquestador principal. Descarga assets, ejecuta las 3 fases, devuelve
 * la ruta del MP4 final + metadata.
 *
 * @param {object}   params
 * @param {object}   params.spec        Especificacion JSON ya validada.
 * @param {string}   params.sessionDir  Directorio de trabajo creado por el caller.
 * @param {string}   params.fontDir     Directorio donde estan las TTF Montserrat.
 * @param {object}   [params.logger]    Pino logger opcional.
 * @returns {Promise<{outputPath:string, metadata:object}>}
 */
export async function composeReel({ spec, sessionDir, fontDir, logger, audioFilePath, assetFilePaths = {} }) {
  const t0 = Date.now();

  // Paso 0: preparar audio. Si el caller paso un fichero local (modo
  // multipart desde n8n), lo copiamos al sessionDir; en otro caso lo
  // descargamos desde spec.audio_url.
  const audioExt = audioFilePath
    ? path.extname(audioFilePath) || '.mp3'
    : extFromUrl(spec.audio_url, '.mp3');
  const audioPath = path.join(sessionDir, `audio${audioExt}`);

  const audioDurations = spec.segments.map((s) => s.end - s.start);
  const xfadeDur = BRAND.video.xfade_duration;

  // Descargas en paralelo (audio + todos los assets cuando proceda).
  const segmentPaths = new Array(spec.segments.length);

  const audioTask = audioFilePath
    ? copyFile(audioFilePath, audioPath)
    : downloadToFile(spec.audio_url, audioPath);

  // Audio en paralelo a las descargas de assets
  // Assets se descargan con concurrencia limitada para no saturar Pollinations.ai
  // (que devuelve 429 si pides muchas imagenes simultaneas).
  const downloadConcurrency = 2;
  const downloadTasks = spec.segments.map((seg, i) => async () => {
    if (assetFilePaths[i]) {
      const ext = path.extname(assetFilePaths[i]) || (seg.asset.type === 'image' ? '.jpg' : '.mp4');
      const dest = path.join(sessionDir, `asset_${String(i).padStart(2, '0')}${ext}`);
      await copyFile(assetFilePaths[i], dest);
      seg._localPath = dest;
      return;
    }
    // Cascada en 3 niveles: Gemini Imagen → Pollinations → Pexels
    // El primero que tenga éxito gana; el resto se ignora.
    const errors = [];

    // NIVEL 1: Gemini Imagen 3 (calidad maxima, anatomia decente)
    if (seg.asset.gemini_prompt && process.env.GEMINI_API_KEY) {
      const destGemini = path.join(sessionDir, `asset_${String(i).padStart(2, '0')}_gemini.png`);
      try {
        await generateImageWithGemini(seg.asset.gemini_prompt, destGemini, logger);
        seg._localPath = destGemini;
        return;
      } catch (err) {
        errors.push({ src: 'gemini', msg: err.message?.slice(0, 200) });
        logger?.warn?.({ idx: i, err: err.message?.slice(0, 200) }, 'gemini failed, trying pollinations');
      }
    }

    // NIVEL 2: URL principal (Pollinations.ai u otra)
    const ext = extFromUrl(seg.asset.url, seg.asset.type === 'image' ? '.jpg' : '.mp4');
    const assetPath = path.join(sessionDir, `asset_${String(i).padStart(2, '0')}${ext}`);
    const isPollinations = seg.asset.url?.includes('pollinations.ai');
    if (seg.asset.url) {
      try {
        await downloadToFile(seg.asset.url, assetPath, {
          timeoutMs: isPollinations ? 120000 : 60000,
          maxRetries: isPollinations ? 4 : 3,
        });
        seg._localPath = assetPath;
        return;
      } catch (errUrl) {
        errors.push({ src: isPollinations ? 'pollinations' : 'url', msg: errUrl.message?.slice(0, 200) });
        logger?.warn?.({ idx: i, err: errUrl.message?.slice(0, 200) }, 'url failed, trying fallback');
      }
    }

    // NIVEL 3: URL fallback (Pexels)
    if (seg.asset.url_fallback) {
      const extFb = extFromUrl(seg.asset.url_fallback, '.jpg');
      const assetPathFb = path.join(sessionDir, `asset_${String(i).padStart(2, '0')}_fb${extFb}`);
      try {
        await downloadToFile(seg.asset.url_fallback, assetPathFb, {
          timeoutMs: 60000,
          maxRetries: 3,
        });
        seg._localPath = assetPathFb;
        return;
      } catch (errFb) {
        errors.push({ src: 'pexels_fb', msg: errFb.message?.slice(0, 200) });
      }
    }

    throw new Error(`Asset segmento ${i}: todas las fuentes fallaron: ${JSON.stringify(errors)}`);
  });

  await Promise.all([
    audioTask,
    runWithConcurrency(downloadTasks, downloadConcurrency),
  ]);

  const audioDurationProbed = await probeDuration(audioPath).catch(() => null);
  logger?.info?.(
    { audioDurationProbed, audioDurationSpec: spec.duration },
    'audio downloaded and probed'
  );

  // FIX corte audio: si el audio probed es mas largo que la suma de los
  // segments (Whisper deja silencios fuera de sus segments), extendemos
  // el ultimo segmento para cubrir esa diferencia. Asi el video final
  // dura exactamente lo mismo que el audio.
  if (audioDurationProbed && audioDurations.length > 0) {
    const sumSeg = audioDurations.reduce((a, b) => a + b, 0);
    // Anadir margen extra de 0.5s al final para asegurar que el audio se
    // reproduce completo (incluido cualquier silencio o respiracion final).
    const targetTotal = audioDurationProbed + 0.5;
    if (targetTotal > sumSeg) {
      const extra = targetTotal - sumSeg;
      audioDurations[audioDurations.length - 1] += extra;
      logger?.info?.({ extra, sumSegBefore: sumSeg, audioDurationProbed, targetTotal }, 'extended last segment to cover trailing audio');
    }
  }

  // Paso 1: pre-procesar segmentos con paralelismo limitado.
  // Saturar la CPU con N ffmpeg simultaneos en un VPS pequeno provoca
  // timeouts y OOMs. max_parallel_segments controla el lote.
  // Un solo bgPath por sesion: todos los segmentos del reel comparten fondo
  // (consistencia visual). Reels distintos obtienen fondos distintos via hash.
  const sessionBgPath = await pickBgForSession(path.basename(sessionDir));
  logger?.info?.({ sessionBgPath }, 'session background pattern picked');
  const maxParallel = BRAND.video.max_parallel_segments || 2;
  logger?.info?.({ count: spec.segments.length, maxParallel }, 'starting phase 1: per-segment render');
  const segmentTasks = spec.segments.map((seg, i) => async () => {
      const audioDur = audioDurations[i];
      const isLast = i === spec.segments.length - 1;
      const visualDur = isLast ? audioDur : audioDur + xfadeDur;
      const segOut = path.join(sessionDir, `seg_${String(i).padStart(2, '0')}.mp4`);

      if (seg.asset.type === 'image') {
        await buildImageSegment(
          {
            assetPath: seg._localPath,
            duration: visualDur,
            outputPath: segOut,
            segIndex: i,
            kenBurnsHint: seg.asset.ken_burns,
            bgPath: sessionBgPath,
          },
          logger
        );
      } else if (seg.asset.type === 'video') {
        await buildVideoSegment(
          {
            assetPath: seg._localPath,
            duration: visualDur,
            trimStart: seg.asset.trim_start ?? 0,
            outputPath: segOut,
            segIndex: i,
            bgPath: sessionBgPath,
          },
          logger
        );
      } else {
        throw new Error(`Tipo de asset desconocido en segmento ${i}: ${seg.asset.type}`);
      }
      segmentPaths[i] = segOut;
    });
  await runWithConcurrency(segmentTasks, maxParallel);
  logger?.info?.({ count: spec.segments.length }, 'phase 1 done');

  // Paso 2: subtitulos .ass.
  const subtitlePath = path.join(sessionDir, 'subtitles.ass');
  await writeSubtitleFile(spec.segments, subtitlePath);

  // Paso 3: concat con xfade.
  const concatPath = path.join(sessionDir, 'concat.mp4');
  await concatenateWithXfade(
    { segmentPaths, audioDurations, outputPath: concatPath },
    logger
  );

  // Paso 4: overlays + audio.
  const outputPath = path.join(sessionDir, 'output.mp4');
  await applyOverlays(
    {
      videoPath: concatPath,
      audioPath,
      subtitlePath,
      signatureText: spec.signature || BRAND.signature.text,
      titleBadge: spec.title_badge,
      fontDir,
      outputPath,
    },
    logger
  );

  const elapsedMs = Date.now() - t0;
  return {
    outputPath,
    metadata: {
      session_dir: sessionDir,
      audio_duration: audioDurationProbed ?? spec.duration ?? null,
      segment_count: spec.segments.length,
      elapsed_ms: elapsedMs,
    },
  };
}
