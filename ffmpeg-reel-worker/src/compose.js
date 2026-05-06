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
import { copyFile, stat, writeFile } from 'node:fs/promises';
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
 * Lista los MP3 disponibles en assets/music/ y elige uno determinístico por
 * sesion (mismo session_id => misma melodia, distintas sesiones => distintas
 * melodias). Devuelve null si no hay melodias o el directorio no existe.
 */
let _musicTracksCache = null;
async function pickMusicForSession(sessionKey) {
  if (!BRAND.background_music?.enabled) return null;
  if (_musicTracksCache === null) {
    const musicDir = path.join(process.env.ASSETS_DIR || '/app/assets', BRAND.background_music.music_dir);
    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(musicDir);
      _musicTracksCache = files
        .filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f))
        .map((f) => path.join(musicDir, f))
        .sort();
    } catch {
      _musicTracksCache = [];
    }
  }
  if (_musicTracksCache.length === 0) return null;
  return _musicTracksCache[hashString(sessionKey + '_music') % _musicTracksCache.length];
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

  // Ken Burns ligero: pre-escalo el asset un 30% mas grande que el area,
  // luego hago crop animado (pan o zoom) basado en el indice del segmento.
  // Mas barato computacionalmente que zoompan y visualmente equivalente.
  // 1.3 (antes 1.2) da un margen mayor para que el movimiento sea claramente
  // visible — con 1.2 el efecto pasaba casi inadvertido.
  const preScale = 1.3;
  const cropW = Math.round(W);
  const cropH = ASSET_AREA_HEIGHT;
  const scaledW = Math.round(W * preScale);
  const scaledH = Math.round(ASSET_AREA_HEIGHT * preScale);
  const dx = scaledW - cropW;   // margen horizontal para pan
  const dy = scaledH - cropH;   // margen vertical para pan
  const dur = Math.max(duration, 0.1);

  // 4 variantes alternadas por segIndex para variedad visual. Todas usan
  // el mismo patron crop con posicion variable. Variant 1 (que antes era
  // "zoom in centrado") la convertimos en pan vertical para tener movimiento
  // real — el crop con tamano variable + scale era inestable en runtime.
  const variant = segIndex % 4;
  let cropX, cropY;
  if (variant === 0) {
    // Pan izq -> der
    cropX = `${dx}*t/${dur}`;
    cropY = `${Math.round(dy / 2)}`;
  } else if (variant === 1) {
    // Pan vertical arriba -> abajo (sustituye al "zoom in" que estaba broken)
    cropX = `${Math.round(dx / 2)}`;
    cropY = `${dy}*t/${dur}`;
  } else if (variant === 2) {
    // Pan der -> izq
    cropX = `${dx}-${dx}*t/${dur}`;
    cropY = `${Math.round(dy / 2)}`;
  } else {
    // Drift diagonal (arriba-izq -> abajo-der)
    cropX = `${dx}*t/${dur}`;
    cropY = `${dy}*t/${dur}`;
  }
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
    introSilence = 0,        // segundos de silencio + freeze del primer frame al inicio
    segments = [],           // para detectar numeros y dibujar pops visuales
  },
  logger
) {
  const sigBarColor = ffmpegColorAlpha(BRAND.colors.bg_dark, BRAND.signature.bar_alpha);
  const sigTextColor = ffmpegColor(BRAND.signature.color || BRAND.colors.accent_gold);
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
      : null;
    const baseSize = BRAND.title_badge.font_size;
    const padH = BRAND.title_badge.horizontal_padding;
    const padV = BRAND.title_badge.vertical_padding;
    const lineSpacing = BRAND.title_badge.line_spacing ?? 1.15;
    const sideMargin = 40;
    const maxBadgeW = BRAND.video.width - 2 * sideMargin;
    const maxTextW = maxBadgeW - 2 * padH;
    const charWidthFactor = 0.58;
    const text = titleBadge.text;

    // Helper: estima ancho del texto en pixeles
    const estimateW = (str, size) => str.length * size * charWidthFactor;

    // Helper: parte un texto en 2 lineas equilibradas (sin cortar palabras).
    // Devuelve [line1, line2] o null si no se puede partir.
    function splitTwoLines(str) {
      const words = str.trim().split(/\s+/);
      if (words.length < 2) return null;
      let bestSplit = -1;
      let bestDiff = Infinity;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' ');
        const b = words.slice(i).join(' ');
        const diff = Math.abs(a.length - b.length);
        if (diff < bestDiff) { bestDiff = diff; bestSplit = i; }
      }
      if (bestSplit < 1) return null;
      return [words.slice(0, bestSplit).join(' '), words.slice(bestSplit).join(' ')];
    }

    // Decidir layout: 1 linea con baseSize, 2 lineas con baseSize, o
    // auto-shrink en 2 lineas (ultimo recurso).
    let lines;
    let fontSize = baseSize;
    if (estimateW(text, baseSize) <= maxTextW) {
      lines = [text];
    } else {
      const split = splitTwoLines(text);
      if (split && Math.max(estimateW(split[0], baseSize), estimateW(split[1], baseSize)) <= maxTextW) {
        lines = split;
      } else if (split) {
        // Reducir fontsize manteniendo 2 lineas
        const longest = Math.max(split[0].length, split[1].length);
        fontSize = Math.max(28, Math.floor(maxTextW / (longest * charWidthFactor)));
        lines = split;
      } else {
        // No se puede partir (1 sola palabra muy larga): shrink 1 linea
        fontSize = Math.max(28, Math.floor(maxTextW / (text.length * charWidthFactor)));
        lines = [text];
      }
    }

    const numLines = lines.length;
    const longestLineLen = Math.max(...lines.map((l) => l.length));
    const badgeWidth = Math.min(
      maxBadgeW,
      Math.round(longestLineLen * fontSize * charWidthFactor + padH * 2)
    );
    const lineGap = Math.round(fontSize * lineSpacing);
    const badgeHeight = fontSize * numLines + (numLines - 1) * (lineGap - fontSize) + padV * 2;
    const badgeY = pctY(BRAND.positions.title_badge_y_pct);
    const badgeX = Math.round((BRAND.video.width - badgeWidth) / 2);
    const enableClause = dur ? `:enable='lt(t,${dur})'` : '';

    // Halo difuminado alrededor de la caja: 3 drawbox concentricos mas grandes
    // y mas transparentes, simulan un blur gaussiano en los bordes (mismo
    // truco que el halo de los stat pops). De fuera a dentro.
    const haloLayers = [
      { offset: 16, alpha: 0.18 },
      { offset: 9,  alpha: 0.40 },
      { offset: 4,  alpha: 0.65 },
    ];
    for (const h of haloLayers) {
      filters.push(
        `drawbox=x=${badgeX - h.offset}:y=${badgeY - h.offset}:w=${badgeWidth + 2 * h.offset}:h=${badgeHeight + 2 * h.offset}:color=${ffmpegColorAlpha(BRAND.colors.bg_dark, h.alpha)}:t=fill${enableClause}`
      );
    }

    // Caja de fondo principal (opaca)
    filters.push(
      `drawbox=x=${badgeX}:y=${badgeY}:w=${badgeWidth}:h=${badgeHeight}:color=${navyColor}:t=fill${enableClause}`
    );
    // Un drawtext por cada linea (mas predecible que \\n dentro de drawtext)
    for (let i = 0; i < numLines; i++) {
      const lineY = badgeY + padV + i * lineGap;
      const drawtextParts = [
        `drawtext=fontfile='${escapeFilterSingleQuoted(titleFontFile)}'`,
        `text='${escapeFilterSingleQuoted(lines[i])}'`,
        `fontsize=${fontSize}`,
        `fontcolor=${goldColor}`,
        'x=(w-text_w)/2',
        `y=${lineY}`,
        'expansion=none',
      ];
      if (dur) drawtextParts.push(`enable='lt(t,${dur})'`);
      filters.push(drawtextParts.join(':'));
    }
  }

  // Capa 4: STAT POPS — flash grande del numero/% cuando se "habla" en cada
  // segmento. Aumenta retencion y crea un "screenshot moment" que se comparte.
  // Timing: estimado por posicion del char dentro del subtitle_text del
  // segmento (sin word timestamps de Whisper). Aproximado pero suficiente.
  // Layout: gran numero dorado con outline negro, en el centro de la imagen.
  // Fade in/out via expresion de alpha en drawtext.
  for (const seg of segments) {
    const text = String(seg.subtitle_text || '');
    if (!text || typeof seg.start !== 'number' || typeof seg.end !== 'number') continue;
    // Detectar numeros: 1-4 digitos opcionalmente con decimales y/o %.
    // Solo el PRIMER numero por segmento (evitar saturar la pantalla).
    const m = text.match(/(?<![\p{L}\d])\d{1,4}(?:[.,]\d{1,3})?%?(?![\p{L}\d])/u);
    if (!m) continue;
    const popRaw = m[0];
    const charIdx = m.index;
    const segDur = seg.end - seg.start;
    if (segDur < 0.5) continue;
    // Tiempo estimado de cuando se "habla" el numero (proporcional a la
    // posicion del char en el texto del segmento).
    const numberSpokenT = seg.start + (charIdx / Math.max(text.length, 1)) * segDur;
    const popDur = 1.2;        // duracion total del pop en pantalla
    const fadeDur = 0.22;      // fade in y fade out (~18% del total)
    let popStart = numberSpokenT - 0.1;
    let popEnd = popStart + popDur;
    // Asegurar que el pop cabe dentro del segmento
    if (popStart < seg.start + 0.05) popStart = seg.start + 0.05;
    if (popEnd > seg.end - 0.05) popEnd = seg.end - 0.05;
    if (popEnd - popStart < 0.4) continue; // demasiado corto, skip

    // Alpha animada: triangulo lineal con plateau plano.
    //   t < popStart           -> negativo  -> clip a 0
    //   popStart..+fadeDur     -> 0..1 (fade in)
    //   +fadeDur..popEnd-fadeDur -> 1 (hold)
    //   popEnd-fadeDur..popEnd -> 1..0 (fade out)
    //   t > popEnd             -> negativo  -> clip a 0
    // Forma compacta: clip(min(min(rampUp, rampDown), 1), 0, 1)
    // Sin escapes raros — los `,` dentro de '...' son literales para ffmpeg.
    const ps = popStart.toFixed(3);
    const pe = popEnd.toFixed(3);
    const fd = fadeDur.toFixed(3);
    const alphaExpr =
      `clip(min(min((t-${ps})/${fd},(${pe}-t)/${fd}),1),0,1)`;

    // Pop: numero MUY grande, dorado, centrado verticalmente en el area
    // del asset. Sombra DIFUMINADA simulada con stack de drawtext con
    // borderw progresivamente menor + alpha mayor (efecto halo soft).
    const popFontSize = 220;
    const popY = Math.round(ASSET_TOP_Y + ASSET_AREA_HEIGHT / 2 - popFontSize / 2);

    // Capas de halo (texto invisible, solo el border crea el efecto).
    // De fuera a dentro: borderw decrece, alpha aumenta.
    const haloLayers = [
      { borderw: 18, alpha: 0.18 },
      { borderw: 11, alpha: 0.32 },
      { borderw: 6,  alpha: 0.55 },
    ];
    for (const layer of haloLayers) {
      filters.push([
        `drawtext=fontfile='${escapeFilterSingleQuoted(titleFontFile)}'`,
        `text='${escapeFilterSingleQuoted(popRaw)}'`,
        `fontsize=${popFontSize}`,
        `fontcolor=black@0`,
        `borderw=${layer.borderw}`,
        `bordercolor=black@${layer.alpha}`,
        `x=(w-text_w)/2`,
        `y=${popY}`,
        `expansion=none`,
        `alpha='${alphaExpr}'`,
      ].join(':'));
    }

    // Capa final: el numero dorado en si mismo, con outline negro fino
    // para definicion. Va POR ENCIMA del halo difuminado.
    filters.push([
      `drawtext=fontfile='${escapeFilterSingleQuoted(titleFontFile)}'`,
      `text='${escapeFilterSingleQuoted(popRaw)}'`,
      `fontsize=${popFontSize}`,
      `fontcolor=${goldColor}`,
      `borderw=3`,
      `bordercolor=black@0.85`,
      `x=(w-text_w)/2`,
      `y=${popY}`,
      `expansion=none`,
      `alpha='${alphaExpr}'`,
    ].join(':'));
  }

  const vf = filters.join(',');

  // Si hay intro silence: tpad al video (freeze del primer frame N s) y
  // adelay al audio (silencio durante esos N s al inicio). La voz empieza
  // a tocar a t=N, pero el video tiene contenido (frame congelado) desde t=0.
  let filterComplex;
  let audioMap;
  if (introSilence > 0) {
    const ms = Math.round(introSilence * 1000);
    filterComplex = `[0:v]${vf},tpad=start_duration=${introSilence}:start_mode=clone[v];[1:a]adelay=${ms}|${ms},apad=pad_dur=0.1[a]`;
    audioMap = '[a]';
  } else {
    filterComplex = `[0:v]${vf}[v]`;
    audioMap = '1:a';
  }

  const args = [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-filter_complex', filterComplex,
    '-map', '[v]',
    '-map', audioMap,
    '-c:v', 'libx264',
    '-preset', BRAND.video.preset,
    '-crf', BRAND.video.crf.toString(),
    '-c:a', 'aac',
    '-b:a', BRAND.video.audio_bitrate,
    '-r', BRAND.video.fps.toString(),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ];
  await runFfmpeg(args, logger);
  return outputPath;
}

/**
 * Genera una imagen de portada (cover.png) para el reel: 1080x1350 con
 *   - Fondo: pattern del reel (mismo bg que se usa en los segmentos)
 *   - Imagen Gemini destacada en la parte superior (1000x740, cover-fit)
 *   - Titulo XXL en dorado, debajo
 *   - Gancho (primera frase) en blanco, debajo del titulo
 *   - @signature dorada en esquina inferior izquierda
 *   - Logo turquesa pequeno en esquina inferior derecha
 *
 * Util para subir como portada del reel en Instagram (cuadricula del feed).
 */
async function generateCoverImage({
  outputPath, bgPath, geminiImagePath,
  title, hook, fontDir,
}, logger) {
  const W = BRAND.video.width;     // 1080
  const H = BRAND.video.height;    // 1350
  const goldHex = ffmpegColor(BRAND.colors.accent_gold);   // 0xF1C40F
  const whiteHex = ffmpegColor(BRAND.colors.text_primary); // 0xFFFFFF
  const navyAlpha = ffmpegColorAlpha(BRAND.colors.bg_dark, 0.55);
  const titleFontFile = path.posix.join(fontDir.replace(/\\/g, '/'), BRAND.fonts.file_title);
  const sigFontFile = path.posix.join(fontDir.replace(/\\/g, '/'), BRAND.fonts.file_signature);

  // Limpiar y truncar el gancho a una linea legible
  const hookText = String(hook || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const titleText = String(title || '').trim();

  // Layout (en pixels):
  //   imagen Gemini: y=80 → y=820, ancho 1000 (centrado)
  //   titulo:        centro vertical y=920 (font 80, max 2 lineas)
  //   gancho:        centro vertical y=1110 (font 40)
  //   firma + logo:  y=1280 (firma izq, logo der)

  // Wrap balanceado en N lineas. Brute-force: prueba cada particion posible
  // de las palabras y elige la que minimiza la longitud de la linea mas larga.
  // Para N<=3 y titulos de hasta ~12 palabras, son <100 combinaciones — barato.
  function splitNLines(str, n) {
    const words = str.trim().split(/\s+/).filter(Boolean);
    if (words.length < n) return null;
    let best = null;
    let bestMax = Infinity;
    function rec(start, splitsLeft, splits) {
      if (splitsLeft === 0) {
        const all = [0, ...splits, words.length];
        const lines = [];
        let maxLen = 0;
        for (let i = 0; i < all.length - 1; i++) {
          const line = words.slice(all[i], all[i + 1]).join(' ');
          lines.push(line);
          if (line.length > maxLen) maxLen = line.length;
        }
        if (maxLen < bestMax) { bestMax = maxLen; best = lines; }
        return;
      }
      for (let i = start; i <= words.length - splitsLeft; i++) {
        splits.push(i);
        rec(i + 1, splitsLeft - 1, splits);
        splits.pop();
      }
    }
    rec(1, n - 1, []);
    return best;
  }

  // 0.58 es el factor real promedio de Montserrat Bold (testeado: 0.50 hacia
  // que el titulo se desbordase del canvas). maxTitleW deja un margen seguro.
  const charWidthFactor = 0.58;
  const baseTitleSize = 140;
  const maxTitleW = W - 80; // margen 40 a cada lado, suficiente para no rozar
  // Algoritmo: probar 1 linea, 2 lineas, 3 lineas en ese orden con baseTitleSize.
  // Usar la primera que quepa entera. Si NINGUNA cabe en 3 lineas a baseTitleSize,
  // hacer auto-shrink con 3 lineas (mejor que 2 muy pequenas).
  function fitsAt(lines, size) {
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    return longest * size * charWidthFactor <= maxTitleW;
  }
  let titleLines;
  let titleSize = baseTitleSize;
  const oneLine = [titleText];
  const twoLines = splitNLines(titleText, 2);
  const threeLines = splitNLines(titleText, 3);
  if (fitsAt(oneLine, baseTitleSize)) {
    titleLines = oneLine;
  } else if (twoLines && fitsAt(twoLines, baseTitleSize)) {
    titleLines = twoLines;
  } else if (threeLines && fitsAt(threeLines, baseTitleSize)) {
    titleLines = threeLines;
  } else {
    // Auto-shrink con 3 lineas (o 2 si no hay suficientes palabras).
    const fallback = threeLines || twoLines || oneLine;
    const longest = fallback.reduce((m, l) => Math.max(m, l.length), 0);
    titleSize = Math.max(56, Math.floor(maxTitleW / (longest * charWidthFactor)));
    titleLines = fallback;
  }

  // Escapado para drawtext text='...' :
  //   - \  -> \\\\ (doble: una vez para JS string, otra para ffmpeg)
  //   - '  -> \\\' (lo mismo, debe quedar \' en el filter)
  //   - :  -> \\:  (opcional: dentro de '...' es seguro, pero algunas versiones
  //                  de ffmpeg lo interpretan, asi que lo escapamos por seguridad)
  //   - %  -> \\%  (idem)
  const escapeArg = (s) =>
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/:/g, '\\:')
      .replace(/%/g, '\\%');

  // Posicionar el bloque de titulo PEGADO debajo de la imagen (acaba en y=820)
  // con un gap de ~30px. La doctora prefiere el titulo arriba.
  const titleLineHeight = Math.round(titleSize * 1.15);
  const titleStartY = 850;

  // Tecnica de sombra DIFUMINADA (gaussian blur real, no outline ni shadowx/y):
  //   1) crear un canvas transparente (color filter source)
  //   2) drawtext del titulo en negro opaco sobre ese canvas
  //   3) gblur con sigma alto -> halo difuso negro
  //   4) overlay del halo sobre [withImg] con offset vertical pequeno (drop shadow)
  //   5) drawtext del titulo en dorado encima del halo
  //
  // Esto produce un sombreado suave/difuminado que rodea las letras, en lugar
  // del outline duro o shadowx/y rigido que ofrece drawtext nativo.
  // Bordes difuminados de la imagen Gemini: usamos geq para escribir un canal
  // alpha que se desvanece desde transparente (alpha=0) en el borde hasta
  // opaco (alpha=255) tras `featherPx` pixels hacia adentro. Resultado: la
  // imagen se funde suavemente con el fondo en lugar de tener bordes rectos.
  // \\, escapa la coma dentro de la expresion (en filter_complex la coma
  // separa filtros, asi que en expresiones dentro de un filtro hay que escaparla).
  const featherPx = 50;
  const geqAlpha = `clip(min(min(X\\,W-X)\\,min(Y\\,H-Y))*255/${featherPx}\\,0\\,255)`;
  const filterParts = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuv420p[bg]`,
    `[1:v]scale=1000:740:force_original_aspect_ratio=increase,crop=1000:740,format=rgba,` +
      `geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='${geqAlpha}'[gemini]`,
    `[bg][gemini]overlay=x=(W-w)/2:y=80[withImg]`,
    // Canvas transparente del mismo tamano que el cover (fuente: filter source)
    `color=color=black@0.0:size=${W}x${H}:duration=1:rate=1,format=yuva420p[blank]`,
  ];

  // Capa 1: drawtext en negro opaco sobre canvas transparente (una linea por iter)
  let shadowLast = 'blank';
  for (let i = 0; i < titleLines.length; i++) {
    const lineY = titleStartY + i * titleLineHeight;
    const outLabel = `sh${i}`;
    filterParts.push(
      `[${shadowLast}]drawtext=fontfile='${escapeArg(titleFontFile)}':text='${escapeArg(titleLines[i])}':fontsize=${titleSize}:fontcolor=black@0.95:x=(w-text_w)/2:y=${lineY}:expansion=none[${outLabel}]`
    );
    shadowLast = outLabel;
  }

  // Capa 2: gaussian blur sigma alto -> halo difuso. sigma=12 da un
  // "difuminado" notable sin perder la silueta del texto.
  filterParts.push(`[${shadowLast}]gblur=sigma=12[blurredShadow]`);

  // Capa 3: overlay del halo bajo el titulo. Offset vertical 5 = drop shadow leve.
  filterParts.push(`[withImg][blurredShadow]overlay=0:5[withShadow]`);

  // Capa 4: drawtext en dorado del titulo encima (sin border, sin shadow propio
  // — el difuminado ya esta abajo).
  let lastV = 'withShadow';
  for (let i = 0; i < titleLines.length; i++) {
    const lineY = titleStartY + i * titleLineHeight;
    const outLabel = `withTitle${i}`;
    filterParts.push(
      `[${lastV}]drawtext=fontfile='${escapeArg(titleFontFile)}':text='${escapeArg(titleLines[i])}':fontsize=${titleSize}:fontcolor=${goldHex}:x=(w-text_w)/2:y=${lineY}:expansion=none[${outLabel}]`
    );
    lastV = outLabel;
  }
  // Firma centrada al pie (sin gancho ni logo, diseno limpio)
  filterParts.push(
    `[${lastV}]drawtext=fontfile='${escapeArg(sigFontFile)}':text='${escapeArg('@' + (BRAND.signature.text || '').replace(/^@/, ''))}':fontsize=32:fontcolor=${goldHex}:x=(w-text_w)/2:y=H-text_h-50:expansion=none[out]`
  );

  const filter = filterParts.join(';');

  await runFfmpeg([
    '-y',
    '-loop', '1', '-t', '1', '-i', bgPath,
    '-loop', '1', '-t', '1', '-i', geminiImagePath,
    '-filter_complex', filter,
    '-map', '[out]',
    '-frames:v', '1',
    outputPath,
  ], logger, 'cover-image');
  logger?.info?.({ outputPath, titleLines: titleLines.length }, 'cover image generated');
  return outputPath;
}

/**
 * Concatena el video principal con el clip outro pre-renderizado aplicando
 * xfade (transicion fade suave) entre ambos. Requiere reencode (no se puede
 * aplicar xfade con concat demuxer + -c copy), pero solo es un encode rapido
 * porque ambos inputs ya estan codificados.
 *
 * - mainDuration: duracion exacta del video principal (necesaria para offset)
 * - transitionDuration: segundos del crossfade (default 0.5)
 */
async function concatWithOutro(mainVideoPath, outroClipPath, outputPath, mainDuration, transitionDuration, outroDuration, musicPath, logger) {
  // El xfade arranca en (mainDuration - transitionDuration) y dura
  // transitionDuration segundos. El video resultante dura
  // mainDuration + outroDuration - transitionDuration.
  const offset = Math.max(0, mainDuration - transitionDuration);
  const totalDuration = mainDuration + outroDuration - transitionDuration;

  // Si hay musica de fondo, la mezclamos AQUI sobre el audio total (voz del
  // reel + silencio del outro). Asi la musica sigue sonando durante los 3.5s
  // del outro y hace fade-out al final.
  const useMusic = !!musicPath;
  const m = BRAND.background_music || {};
  const musicVol = m.volume ?? 0.10;
  const voiceBoost = m.voice_boost ?? 1.0;
  const voiceNorm = m.voice_normalize || null;
  const fadeIn = m.fade_in_duration ?? 1.0;
  const fadeOut = m.fade_out_duration ?? 1.5;
  const fadeOutStart = Math.max(0, totalDuration - fadeOut);

  // Cadena de procesado de la voz: boost + normalizacion dinamica opcional.
  const voiceChain = voiceNorm
    ? `volume=${voiceBoost},${voiceNorm}`
    : `volume=${voiceBoost}`;

  // Loop perfecto: fade in/out a negro en los bordes del video final.
  // Cuando IG hace loop, negro → negro = transicion invisible y el reel
  // suma segundos de retencion automaticos (el algoritmo lo premia).
  const loopFadeDur = 0.4;
  const loopFadeOutStart = Math.max(0, totalDuration - loopFadeDur);
  const filterParts = [
    `[0:v][1:v]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(3)}[vmix]`,
    `[vmix]fade=t=in:st=0:d=${loopFadeDur},fade=t=out:st=${loopFadeOutStart.toFixed(3)}:d=${loopFadeDur}[v]`,
    `[0:a][1:a]acrossfade=d=${transitionDuration}[avoice]`,
  ];
  if (useMusic) {
    // Input 2 = musica (con loop infinito por -stream_loop -1).
    // amix con normalize=0 NO baja el volumen de los inputs.
    // dynaudnorm sobre la voz iguala dinamicamente el volumen (sube partes
    // bajas, mantiene altas) — compensa ElevenLapse que decrece la voz.
    filterParts.push(
      `[avoice]${voiceChain}[avoice_amp]`,
      `[2:a]volume=${musicVol},afade=in:st=0:d=${fadeIn},afade=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut}[music_q]`,
      `[avoice_amp][music_q]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
    );
  } else {
    // Sin musica: aplicamos voice chain directo a la voz
    filterParts.push(`[avoice]${voiceChain}[a]`);
  }
  const filter = filterParts.join(';');

  const args = [
    '-y',
    '-i', mainVideoPath,
    '-i', outroClipPath,
  ];
  if (useMusic) {
    args.push('-stream_loop', '-1', '-i', musicPath);
  }
  args.push(
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-preset', BRAND.video.preset,
    '-crf', BRAND.video.crf.toString(),
    '-c:a', 'aac',
    '-b:a', BRAND.video.audio_bitrate,
    '-r', BRAND.video.fps.toString(),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  );
  await runFfmpeg(args, logger, 'concat-outro-xfade');
  return outputPath;
}

/**
 * Caso edge: outro deshabilitado pero hay musica. Aplicamos la musica al
 * video principal en una pasada separada (sin concat). Si NO hay musica,
 * basta con copiar el archivo.
 */
async function applyMusicOnly(mainVideoPath, outputPath, mainDuration, musicPath, logger) {
  const m = BRAND.background_music || {};
  const musicVol = m.volume ?? 0.10;
  const voiceBoost = m.voice_boost ?? 1.0;
  const voiceNorm = m.voice_normalize || null;
  const fadeIn = m.fade_in_duration ?? 1.0;
  const fadeOut = m.fade_out_duration ?? 1.5;
  const fadeOutStart = Math.max(0, mainDuration - fadeOut);
  const voiceChain = voiceNorm ? `volume=${voiceBoost},${voiceNorm}` : `volume=${voiceBoost}`;
  await runFfmpeg([
    '-y',
    '-i', mainVideoPath,
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex',
    `[0:a]${voiceChain}[avoice];[1:a]volume=${musicVol},afade=in:st=0:d=${fadeIn},afade=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut}[music_q];[avoice][music_q]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', BRAND.video.audio_bitrate,
    '-movflags', '+faststart',
    outputPath,
  ], logger, 'apply-music-only');
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
  // El filtro ass se aplica ANTES del tpad (que añade introSilence al
  // video), asi que los subtitulos se desplazan automaticamente con el
  // video. NO sumamos offsetSeconds para evitar doble shift.
  const introSilence = BRAND.video.intro_silence_duration ?? 0;
  const subtitlePath = path.join(sessionDir, 'subtitles.ass');
  await writeSubtitleFile(spec.segments, subtitlePath, 0);

  // Paso 3: concat con xfade.
  const concatPath = path.join(sessionDir, 'concat.mp4');
  await concatenateWithXfade(
    { segmentPaths, audioDurations, outputPath: concatPath },
    logger
  );

  // Paso 4: overlays + audio. Si hay outro habilitado y clip pre-renderizado,
  // applyOverlays escribe a main.mp4 y luego se concatena con el outro;
  // si no, escribe directo a output.mp4.
  // El outro_clip que usamos corresponde al MISMO pattern del reel (continuidad
  // visual). bootstrap pre-genero outro_clip_N.mp4 (uno por pattern); aqui
  // elegimos N segun el sessionBgPath usado en phase 1.
  const finalOutputPath = path.join(sessionDir, 'output.mp4');
  let outroClipPath = null;
  if (BRAND.outro?.enabled) {
    // Extraer el indice del pattern del nombre del bg (bg_pattern_N.png → N).
    const bgBaseName = path.basename(sessionBgPath);
    const idxMatch = bgBaseName.match(/bg_pattern_(\d+)\.png$/);
    const overlaysDir = path.join(process.env.ASSETS_DIR || '/app/assets', 'overlays');
    const candidates = [];
    if (idxMatch) {
      candidates.push(path.join(overlaysDir, 'patterns', `outro_clip_${idxMatch[1]}.mp4`));
    }
    // Fallback si el bg no es uno de los patterns con outro pre-generado
    candidates.push(path.join(overlaysDir, 'patterns', 'outro_clip_0.mp4'));
    for (const c of candidates) {
      try {
        await stat(c);
        outroClipPath = c;
        break;
      } catch { /* probar siguiente */ }
    }
    if (!outroClipPath) {
      logger?.warn?.('ningun outro_clip pre-generado encontrado, reel saldra sin outro');
    }
  }

  const useOutro = !!outroClipPath;
  // Musica de fondo: elegida deterministicamente por sesion. Se aplica EN el
  // concatWithOutro (cubre voz + outro) o, si no hay outro, en applyMusicOnly.
  const musicPath = await pickMusicForSession(path.basename(sessionDir));
  const useMusic = !!musicPath;
  if (useMusic) logger?.info?.({ musicPath }, 'background music picked for session');

  // Si hay outro o musica → applyOverlays escribe a un archivo intermedio
  // (sin musica). Despues concatWithOutro o applyMusicOnly producen el final.
  // Si no hay nada, applyOverlays escribe directo al final.
  const needsExtraStep = useOutro || useMusic;
  const mainVideoPath = needsExtraStep ? path.join(sessionDir, 'main.mp4') : finalOutputPath;
  await applyOverlays(
    {
      videoPath: concatPath,
      audioPath,
      subtitlePath,
      signatureText: spec.signature || BRAND.signature.text,
      titleBadge: spec.title_badge,
      fontDir,
      outputPath: mainVideoPath,
      introSilence,
      segments: spec.segments,
    },
    logger
  );

  // Paso 5: combinacion final (outro + musica + fade out).
  // Si el outro_clip esta corrupto, fallback a copy de main.
  // mainDuration incluye el introSilence (el video y audio del main.mp4
  // ya tienen los N segundos extra al inicio).
  const audioDur = audioDurationProbed && audioDurationProbed > 0
    ? audioDurationProbed
    : audioDurations.reduce((acc, d) => acc + d, 0);
  const mainDuration = audioDur + introSilence;
  if (useOutro) {
    try {
      await concatWithOutro(
        mainVideoPath,
        outroClipPath,
        finalOutputPath,
        mainDuration,
        BRAND.outro.transition_duration,
        BRAND.outro.duration,
        useMusic ? musicPath : null,
        logger
      );
      logger?.info?.({ outputPath: finalOutputPath, outroClipPath, mainDuration, withMusic: useMusic }, 'outro xfade-concatenated (with music)');
    } catch (concatErr) {
      logger?.warn?.({ err: concatErr.message?.slice(0, 200), outroClipPath }, 'concat con outro fallo, fallback a main');
      // Fallback: si hay musica intentamos solo musica; si no, copy
      if (useMusic) {
        try {
          await applyMusicOnly(mainVideoPath, finalOutputPath, mainDuration, musicPath, logger);
        } catch (e) {
          await copyFile(mainVideoPath, finalOutputPath);
        }
      } else {
        await copyFile(mainVideoPath, finalOutputPath);
      }
    }
  } else if (useMusic) {
    // No hay outro pero si musica
    try {
      await applyMusicOnly(mainVideoPath, finalOutputPath, mainDuration, musicPath, logger);
      logger?.info?.({ outputPath: finalOutputPath, musicPath }, 'background music applied to main');
    } catch (e) {
      logger?.warn?.({ err: e.message?.slice(0, 200) }, 'apply music fallo, devolviendo reel sin musica');
      await copyFile(mainVideoPath, finalOutputPath);
    }
  }
  // Si !useOutro && !useMusic, applyOverlays ya escribio en finalOutputPath.
  const outputPath = finalOutputPath;

  // Paso 6: generar imagen de portada (cover.png) para subir a Instagram.
  // Toma el bg pattern del reel + la imagen del segundo segmento (suele ser
  // la mas representativa) + titulo XXL + gancho. Best-effort: si falla,
  // el reel se entrega igual sin cover.
  logger?.info?.('phase 6: generando portada cover.png');
  const coverPath = path.join(sessionDir, 'cover.png');
  try {
    const coverGeminiIdx = spec.segments.length > 1 ? 1 : 0;
    const coverGeminiPath = spec.segments[coverGeminiIdx]?._localPath;
    const titleText = spec.title_badge?.text || '';
    const hookText = (spec.segments[0]?.subtitle_text || '').trim();
    if (!coverGeminiPath) {
      logger?.warn?.('cover skip: no hay imagen Gemini disponible para el segmento');
    } else if (!titleText) {
      logger?.warn?.('cover skip: spec sin title_badge.text');
    } else {
      await generateCoverImage({
        outputPath: coverPath,
        bgPath: sessionBgPath,
        geminiImagePath: coverGeminiPath,
        title: titleText,
        hook: hookText,
        fontDir,
      }, logger);
    }
  } catch (e) {
    // NO truncar: necesitamos el stderr de ffmpeg completo para diagnosticar.
    logger?.warn?.({ err: e.message }, 'cover image generation failed (reel sigue OK)');
  }

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
