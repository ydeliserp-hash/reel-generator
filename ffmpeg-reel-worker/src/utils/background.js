/**
 * Genera fondos para los reels: 15 PNGs distintos con patrones tech/network/medico
 * (plexus, hexagonos, ondas, constelacion, poligonos, circuit, holograma, ECG,
 * particulas, radar, grid 3D, ADN, topografico, red neuronal, ondas sonoras)
 * generados via Pollinations.ai.
 *
 * Compose elige 1 pattern por sesion (hash del sessionDir), asi todos los
 * segmentos del mismo reel comparten fondo y reels distintos obtienen
 * fondos distintos de forma deterministica.
 *
 * Si Pollinations no responde o no hay token, fallback a un PNG procedural
 * generado con FFmpeg geq (globo terraqueo).
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { BRAND, ffmpegColor } from '../branding.js';
import { downloadToFile } from './download.js';

// ---------------------------------------------------------------------------
// Cache persistente de assets generados
// ---------------------------------------------------------------------------
//
// Los assets pesados (15 patterns Pollinations + 11 outro_clips + logo
// redimensionado + bg_gradient) se regeneran en cada deploy del worker, lo
// que tarda 2-3 minutos. Si los persistimos en un volumen del host, los
// re-deploys siguientes los recuperan en ~2 segundos.
//
// Estrategia: para cada asset, antes de generarlo verificamos si existe en
// el directorio de cache. Si si, lo copiamos al working dir (rapido). Si
// no, lo generamos en working dir y dejamos copia en cache para futuros
// deploys.
//
// Para invalidar el cache (ej: al cambiar prompts), poner CACHE_BUST=1 en
// las env vars del worker. Vuelve a generar todo.
const CACHE_DIR = process.env.ASSETS_CACHE_DIR || '/tmp/reel-sessions/.assets-cache';
const CACHE_BUST = process.env.CACHE_BUST === '1';

function _cachePathFor(workingPath) {
  // /app/assets/overlays/foo.png -> {CACHE_DIR}/overlays/foo.png
  // Mantenemos la estructura relativa al ASSETS_DIR para que el cache sea
  // espejo del working dir.
  const assetsDir = process.env.ASSETS_DIR || '/app/assets';
  const rel = path.relative(assetsDir, workingPath);
  return path.join(CACHE_DIR, rel);
}

async function _existsAndValid(filePath, minSize = 100) {
  try {
    const s = await stat(filePath);
    return s.size >= minSize;
  } catch {
    return false;
  }
}

/**
 * Si el asset ya esta en el cache persistente, lo copia al working dir y
 * devuelve true. Si no, devuelve false (caller debe generar el asset).
 * Si CACHE_BUST=1, siempre devuelve false.
 */
async function tryRestoreFromCache(workingPath, logger, label) {
  if (CACHE_BUST) return false;
  const cPath = _cachePathFor(workingPath);
  if (!(await _existsAndValid(cPath))) return false;
  try {
    await mkdir(path.dirname(workingPath), { recursive: true });
    await copyFile(cPath, workingPath);
    logger?.info?.({ workingPath, cachePath: cPath, label }, 'asset restored from cache');
    return true;
  } catch (e) {
    logger?.warn?.({ err: e.message, label }, 'restore from cache failed');
    return false;
  }
}

/**
 * Tras generar un asset en el working dir, copia al cache persistente para
 * futuros deploys. Best-effort: si falla, no rompe el flujo.
 */
async function saveToCache(workingPath, logger, label) {
  const cPath = _cachePathFor(workingPath);
  try {
    await mkdir(path.dirname(cPath), { recursive: true });
    await copyFile(workingPath, cPath);
    logger?.info?.({ workingPath, cachePath: cPath, label }, 'asset saved to cache');
  } catch (e) {
    logger?.warn?.({ err: e.message, label }, 'save to cache failed (asset still works for this session)');
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err += c.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

/**
 * Genera 5 fondos con Pollinations.ai. Devuelve array de paths.
 * Si alguno falla, ese se omite. Si todos fallan devuelve array vacio.
 */
async function bakePollinationsPatterns(patternsDir, w, h, logger) {
  const POLLINATIONS_TOKEN = process.env.POLLINATIONS_TOKEN || '';
  // Set curado: 8 favoritos confirmados + 5 nuevos en tonos navy/teal/verdeazul,
  // con lineas suaves y puntos tenues (low contrast). Eliminados de iteraciones
  // previas: hexagonos, ondas fluidas, circuit board, holograma, ECG, radar,
  // topografico, ondas sonoras, constelacion brillante, nebulosa, cristal 3D,
  // estructura atomica.
  const PATTERN_PROMPTS = [
    // 0 - Plexus
    'minimalist plexus network of connected dots and bright thin lines floating in space, deep navy blue gradient background, cyan and electric blue accent dots, abstract tech aesthetic, minimal composition',
    // 1 - Poligonos
    'abstract geometric polygon network triangles and dots, deep navy and teal gradient background, soft green and cyan accent lines, minimalist science visualization',
    // 2 - Grid 3D perspectiva
    'subtle 3D perspective grid lines fading into distance with light points at intersections, deep navy gradient background, electric blue glow, retrofuturistic tech wallpaper, clean minimalist',
    // 3 - ADN doble helice
    'abstract DNA double helix pattern with connected dots and thin curved lines, deep navy gradient background, soft teal and cyan accents, biotech minimalist wallpaper',
    // 4 - Particulas bioluminiscentes
    'soft bioluminescent particles drifting in deep navy gradient space, glowing teal and emerald orbs of varying size, organic medical aesthetic, ethereal minimalist composition',
    // 5 - Sinapsis fluidas
    'flowing synaptic connections with bright pulse points and curved thin lines, deep navy gradient background, electric blue and white glow, neural medical aesthetic, minimalist abstract',
    // 6 - Lluvia digital tenue
    'soft vertical digital rain lines descending slowly with small dim dots, deep navy blue gradient background, muted teal-green accents, low contrast minimalist tech aesthetic, calm wallpaper',
    // 7 - Malla organica curva
    'soft organic curved mesh pattern with thin flowing lines and small subtle dim dots at intersections, deep navy and dark blue-green gradient background, muted teal accents, calm minimalist composition, low contrast',
    // 8 - Capas de ondas profundas
    'overlapping deep wave layers with thin curved lines and small dim particles, deep navy and dark teal gradient, soft turquoise accents, low contrast minimalist abstract, oceanic depth wallpaper',
    // 9 - Lineas topograficas suaves
    'abstract topographic depth lines curving softly across the canvas with small subtle dim dots, deep midnight blue background with soft teal-green undertones, muted cyan accents, calm minimalist wallpaper, low contrast',
    // 10 - Constelacion tenue
    'loose network of dim stars connected by thin soft lines, deep navy blue gradient with muted teal undertones, small low brightness dots, calm minimalist celestial aesthetic, low contrast wallpaper',
  ];

  await mkdir(patternsDir, { recursive: true });
  const generatedPaths = [];

  for (let i = 0; i < PATTERN_PROMPTS.length; i++) {
    const dest = path.join(patternsDir, `bg_pattern_${i}.png`);

    // Cache: si ya existe en working o en persistent cache, skip Pollinations
    if (await _existsAndValid(dest, 5000)) {
      generatedPaths.push(dest);
      logger?.info?.({ idx: i, dest }, 'pattern already in working dir, skip');
      continue;
    }
    if (await tryRestoreFromCache(dest, logger, `bg_pattern_${i}`)) {
      generatedPaths.push(dest);
      continue;
    }

    const prompt = PATTERN_PROMPTS[i];
    const seed = 5000 + i * 137;
    let url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&model=flux&seed=${seed}&nologo=true&enhance=true`;
    if (POLLINATIONS_TOKEN) url += `&token=${encodeURIComponent(POLLINATIONS_TOKEN)}`;

    try {
      await downloadToFile(url, dest, { timeoutMs: 90000, maxRetries: 3 });
      generatedPaths.push(dest);
      logger?.info?.({ idx: i, dest }, 'pattern background baked from pollinations');
      await saveToCache(dest, logger, `bg_pattern_${i}`);
    } catch (e) {
      logger?.warn?.({ idx: i, err: e.message?.slice(0, 200) }, 'pattern bg failed, will skip');
    }
    // Pequeno delay para respetar rate limit de Pollinations
    await new Promise((r) => setTimeout(r, 1500));
  }

  return generatedPaths;
}

/**
 * Genera el PNG procedural de fallback (globo terraqueo: circulos + radiales).
 * Se usa si Pollinations no genera ninguno o como base unica si no hay token.
 */
async function bakeProceduralGradient(outputPath, logger) {
  // Cache: si ya existe en working o en persistent cache, no regenerar
  if (await _existsAndValid(outputPath)) {
    logger?.info?.({ outputPath }, 'gradient already in working dir, skip');
    return outputPath;
  }
  if (await tryRestoreFromCache(outputPath, logger, 'bg_gradient')) return outputPath;

  const w = BRAND.video.width;
  const h = BRAND.video.height;
  const cDark = '0x050E22';
  const cBright = '0x3578D5';
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  const circleStep = 90;
  const angleStep = 15;
  const lineThickness = 2;
  const onCircleExpr = `lt(abs(mod(hypot(X-${cx},Y-${cy}),${circleStep})-${circleStep}/2),${lineThickness})`;
  const onRadialExpr = `lt(abs(mod(abs(atan2(Y-${cy},X-${cx})*180/PI),${angleStep})-${angleStep}/2),0.5)`;
  const onLineExpr = `gt(${onCircleExpr}+${onRadialExpr},0)`;
  const globeGridFilter = `format=rgba,geq=r=111:g=168:b=220:a='if(${onLineExpr},220,0)'`;

  try {
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `gradients=size=${w}x${h}:c0=${cDark}:c1=${cBright}:x0=0:y0=0:x1=${w}:y1=${h}:type=linear:duration=1:rate=1`,
      '-f', 'lavfi',
      '-i', `color=c=black@0:s=${w}x${h},${globeGridFilter}`,
      '-filter_complex', '[0:v][1:v]overlay=0:0,format=rgb24[out]',
      '-map', '[out]',
      '-frames:v', '1',
      outputPath,
    ]);
    logger?.info?.({ outputPath }, 'procedural gradient baked (globe pattern)');
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'procedural gradient con geq falla, intentando drawgrid');
    try {
      await runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `gradients=size=${w}x${h}:c0=${cDark}:c1=${cBright}:x0=0:y0=0:x1=${w}:y1=${h}:type=linear:duration=1:rate=1`,
        '-vf', 'drawgrid=width=80:height=80:thickness=2:color=0x6FA8DC',
        '-frames:v', '1',
        outputPath,
      ]);
      logger?.info?.({ outputPath }, 'procedural gradient baked (simple grid)');
    } catch (e2) {
      logger?.warn?.({ err: e2.message }, 'todo falla, color solido');
      await runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `color=c=${cDark}:s=${w}x${h}`,
        '-frames:v', '1',
        outputPath,
      ]);
    }
  }
  await saveToCache(outputPath, logger, 'bg_gradient');
  return outputPath;
}

/**
 * Punto de entrada. Llama desde server.js al arrancar.
 *
 *   - outputPath: path del bg unico fallback (compatibilidad con codigo existente)
 *   - tambien genera 5 patterns en {dir(outputPath)}/patterns/
 *
 * Compose.js descubre los patterns dinamicamente y rota entre ellos.
 */
export async function ensureGradientBackground(outputPath, logger) {
  const w = BRAND.video.width;
  const h = BRAND.video.height;

  // Siempre garantizamos el bg unico procedural (es rapido y sirve de fallback)
  await bakeProceduralGradient(outputPath, logger);

  // Si hay token Pollinations, intentamos generar 5 patterns para alternar
  const patternsDir = path.join(path.dirname(outputPath), 'patterns');
  const POLLINATIONS_TOKEN = process.env.POLLINATIONS_TOKEN || '';
  if (POLLINATIONS_TOKEN) {
    try {
      const generated = await bakePollinationsPatterns(patternsDir, w, h, logger);
      if (generated.length > 0) {
        logger?.info?.({ count: generated.length, dir: patternsDir }, 'pattern backgrounds ready for rotation');
      } else {
        logger?.warn?.('no pattern backgrounds generated, compose usara solo el procedural');
      }
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'pattern bake failed entirely');
    }
  } else {
    logger?.info?.('POLLINATIONS_TOKEN no esta definido, sin patrones alternantes');
  }

  return outputPath;
}

/**
 * Pre-renderiza el CLIP MP4 outro completo:
 *   - Fondo: bg pattern del reel (mismo estilo, continuidad visual)
 *   - Logo: PNG resized con fade-in alpha animado y drop shadow blureado
 *   - Slogan: PNG pre-disenado por la doctora con fade-in alpha
 *   - Audio: silencio
 *
 * Tanto logo como slogan se posicionan por su CENTRO vertical (logoY y
 * sloganY son las coordenadas del centro, no del top-left).
 *
 * Mismos codec/fps/profile que el video principal para que el xfade del
 * paso final pueda concatenarlos limpiamente.
 */
export async function ensureOutroClip(params, logger) {
  const {
    outputPath, videoW, videoH, fps, duration, crf, preset, audioBitrate,
    bgPath, originalLogoPath, sloganPath,
    logoWidth, logoCenterY, logoFadeInDuration,
    sloganFadeInStart, sloganFadeInDuration,
    backdropColor,
  } = params;

  // Cache: si ya existe en working o en cache persistente, skip generation
  if (await _existsAndValid(outputPath, 10000)) {
    logger?.info?.({ outputPath }, 'outro clip already in working dir, skip');
    return outputPath;
  }
  const cacheLabel = `outro_clip_${path.basename(outputPath, '.mp4')}`;
  if (await tryRestoreFromCache(outputPath, logger, cacheLabel)) {
    return outputPath;
  }

  const navyColor = `0x${backdropColor.replace('#', '').toUpperCase()}`;
  const shadowOffsetX = params.shadowOffsetX ?? 6;
  const shadowOffsetY = params.shadowOffsetY ?? 6;
  const shadowBlur = params.shadowBlur ?? 14;
  const shadowAlpha = params.shadowAlpha ?? 0.65;

  // Filter complex:
  // - Input 0: fondo (bg pattern del reel) (loop)
  // - Input 1: logo PNG (loop)
  // - Input 2: slogan PNG (loop, ya disenado por la doctora)
  // - Input 3: audio silencio
  //
  // Drop shadow del logo: split del logo en 2 streams. Uno se convierte a
  // negro (manteniendo alpha) y se aplica boxblur — esa es la sombra. Se
  // overlayea con offset detras del logo original.
  //
  // Posicionamiento: en overlay, h se refiere a la altura del overlay
  // (input secundario), asi 'y=${centerY}-h/2' centra verticalmente el
  // overlay en centerY.
  const filter = [
    // Fondo: escalar para llenar 1080x1350 manteniendo aspect ratio (cover)
    `[0:v]scale=${videoW}:${videoH}:force_original_aspect_ratio=increase,crop=${videoW}:${videoH},format=yuv420p[bg]`,
    // Logo: split en 2. shadow = negro + blur. logo_main = original con fade-in.
    `[1:v]scale=${logoWidth}:-1,format=rgba,split=2[logo_pre_shadow][logo_pre_main]`,
    `[logo_pre_shadow]colorchannelmixer=rr=0:gg=0:bb=0:aa=${shadowAlpha},boxblur=${shadowBlur}:1[logo_shadow]`,
    `[logo_pre_main]fade=in:st=0:d=${logoFadeInDuration}:alpha=1[logo_main]`,
    // Slogan: PNG fullscreen (mismo tamano que el video) con fade-in alpha
    // — diseno y posicion del texto van dentro del propio PNG.
    `[2:v]format=rgba,fade=in:st=${sloganFadeInStart}:d=${sloganFadeInDuration}:alpha=1[slogan]`,
    // Composicion: bg → shadow logo (con offset) → logo → slogan
    `[bg][logo_shadow]overlay=x=(W-w)/2+${shadowOffsetX}:y=${logoCenterY}-h/2+${shadowOffsetY}:format=auto[bg_with_shadow]`,
    `[bg_with_shadow][logo_main]overlay=x=(W-w)/2:y=${logoCenterY}-h/2:format=auto[withlogo]`,
    `[withlogo][slogan]overlay=x=0:y=0:enable='gte(t,${sloganFadeInStart})':format=auto,format=yuv420p[vout]`,
  ].join(';');

  try {
    await runFfmpeg([
      '-y',
      // Input 0: bg_gradient.png loopeado por `duration` segundos
      '-loop', '1',
      '-t', duration.toString(),
      '-i', bgPath,
      // Input 1: logo PNG
      '-loop', '1',
      '-t', duration.toString(),
      '-i', originalLogoPath,
      // Input 2: slogan PNG (disenado por la doctora)
      '-loop', '1',
      '-t', duration.toString(),
      '-i', sloganPath,
      // Input 3: silencio
      '-f', 'lavfi',
      '-t', duration.toString(),
      '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
      '-filter_complex', filter,
      '-map', '[vout]',
      '-map', '3:a',
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', crf.toString(),
      '-r', fps.toString(),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', audioBitrate,
      '-movflags', '+faststart',
      outputPath,
    ]);
    const s = await stat(outputPath);
    logger?.info?.({ outputPath, bytes: s.size, duration, videoW, videoH }, 'outro clip MP4 pre-rendered');
    await saveToCache(outputPath, logger, cacheLabel);
    return outputPath;
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'outro clip pre-render failed, reels saldran sin outro');
    // Si quedo un archivo parcial corrupto (sin moov atom), borrarlo para que
    // composeReel no lo intente usar.
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(outputPath);
    } catch { /* no existia o ya borrado */ }
    return null;
  }
}

/**
 * Pre-genera UN outro_clip por cada pattern disponible. composeReel elige
 * el que corresponde al pattern del reel actual, asi el outro tiene
 * continuidad visual con el resto del video.
 *
 * Recibe los mismos params que ensureOutroClip pero sin bgPath ni outputPath
 * (los calcula internamente para cada pattern).
 *
 * Devuelve un array con los paths de outro_clip generados (en el mismo orden
 * que los patterns devueltos por listBackgroundPatterns).
 */
export async function ensureOutroClipsForAllPatterns(commonParams, patternsBaseDir, fallbackBgPath, logger) {
  const patterns = await listBackgroundPatterns(fallbackBgPath, logger);
  const generated = [];
  for (let i = 0; i < patterns.length; i++) {
    const bgPath = patterns[i];
    // Nombrar outro_clip_N.mp4 con el MISMO numero del bg_pattern_N.png
    // (no con el indice del array). El sort lexicografico ponia bg_pattern_10
    // antes de bg_pattern_2, asi que el indice del array NO coincide con el
    // numero en el filename. composeReel busca outro_clip_<numero>.mp4 segun
    // el nombre del bg que toco, asi debe coincidir.
    const bgBaseName = path.basename(bgPath);
    const idxMatch = bgBaseName.match(/bg_pattern_(\d+)\.png$/);
    const outroIdx = idxMatch ? idxMatch[1] : String(i);
    const outroOutputPath = path.join(patternsBaseDir, `outro_clip_${outroIdx}.mp4`);
    try {
      const result = await ensureOutroClip({
        ...commonParams,
        bgPath,
        outputPath: outroOutputPath,
      }, logger);
      if (result) generated.push(result);
    } catch (e) {
      logger?.warn?.({ idx: i, err: e.message }, 'outro clip generation failed for pattern');
    }
  }
  logger?.info?.({ count: generated.length, total: patterns.length }, 'outro clips generated for patterns');
  return generated;
}

/**
 * Pre-redimensiona el logo del outro a su tamano final (594 px de ancho)
 * UNA SOLA VEZ al arrancar el worker. Asi FFmpeg no tiene que decodificar
 * el PNG original (~2870x1472, ~5MB) ni reescalarlo cada frame del video.
 * Si el redimensionado falla, devuelve null y compose.js usara el original.
 */
export async function ensureResizedLogo(originalLogoPath, resizedLogoPath, targetWidth, logger) {
  // Cache: si ya existe en working o en persistent cache, skip
  if (await _existsAndValid(resizedLogoPath)) {
    logger?.info?.({ resizedLogoPath }, 'logo resized already in working, skip');
    return resizedLogoPath;
  }
  if (await tryRestoreFromCache(resizedLogoPath, logger, 'logo_resized')) {
    return resizedLogoPath;
  }
  try {
    await runFfmpeg([
      '-y',
      '-i', originalLogoPath,
      '-vf', `scale=${targetWidth}:-1:flags=lanczos,format=rgba`,
      '-frames:v', '1',
      resizedLogoPath,
    ]);
    const s = await stat(resizedLogoPath);
    logger?.info?.({ resizedLogoPath, bytes: s.size, targetWidth }, 'logo resized for outro');
    await saveToCache(resizedLogoPath, logger, 'logo_resized');
    return resizedLogoPath;
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'logo resize failed, compose usara el PNG original');
    return null;
  }
}

/**
 * Devuelve la lista de paths de bg patterns disponibles para rotar.
 * Si no hay (no se generaron o no hay token), devuelve [outputPath] como
 * unico fallback. Compose.js usa modulo sobre esta lista.
 */
export async function listBackgroundPatterns(singleFallbackPath, logger) {
  const patternsDir = path.join(path.dirname(singleFallbackPath), 'patterns');
  try {
    const files = await readdir(patternsDir);
    // Sort NUMERICO por el indice del archivo (bg_pattern_2 antes que
    // bg_pattern_10, no al reves como hacia el sort lexicografico).
    const pngs = files
      .filter((f) => f.endsWith('.png'))
      .map((f) => path.join(patternsDir, f))
      .sort((a, b) => {
        const numA = parseInt(path.basename(a).match(/(\d+)/)?.[1] || '0', 10);
        const numB = parseInt(path.basename(b).match(/(\d+)/)?.[1] || '0', 10);
        return numA - numB;
      });
    if (pngs.length > 0) return pngs;
  } catch (e) {
    /* directorio no existe */
  }
  return [singleFallbackPath];
}
