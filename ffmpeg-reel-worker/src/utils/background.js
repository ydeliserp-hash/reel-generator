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
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { BRAND, ffmpegColor } from '../branding.js';
import { downloadToFile } from './download.js';

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
    // 2 - Particulas flotantes
    'soft floating particles and tiny glowing orbs scattered across deep navy gradient background, cyan and white bokeh accents, ethereal minimalist composition, abstract science wallpaper',
    // 3 - Grid 3D perspectiva
    'subtle 3D perspective grid lines fading into distance with light points at intersections, deep navy gradient background, electric blue glow, retrofuturistic tech wallpaper, clean minimalist',
    // 4 - ADN doble helice
    'abstract DNA double helix pattern with connected dots and thin curved lines, deep navy gradient background, soft teal and cyan accents, biotech minimalist wallpaper',
    // 5 - Red neuronal
    'abstract neural network with layers of connected nodes and bright synaptic lines, deep navy blue gradient background, cyan and electric blue accents, AI science minimalist wallpaper',
    // 6 - Particulas bioluminiscentes
    'soft bioluminescent particles drifting in deep navy gradient space, glowing teal and emerald orbs of varying size, organic medical aesthetic, ethereal minimalist composition',
    // 7 - Sinapsis fluidas
    'flowing synaptic connections with bright pulse points and curved thin lines, deep navy gradient background, electric blue and white glow, neural medical aesthetic, minimalist abstract',
    // 8 - Lluvia digital tenue
    'soft vertical digital rain lines descending slowly with small dim dots, deep navy blue gradient background, muted teal-green accents, low contrast minimalist tech aesthetic, calm wallpaper',
    // 9 - Malla organica curva
    'soft organic curved mesh pattern with thin flowing lines and small subtle dim dots at intersections, deep navy and dark blue-green gradient background, muted teal accents, calm minimalist composition, low contrast',
    // 10 - Capas de ondas profundas
    'overlapping deep wave layers with thin curved lines and small dim particles, deep navy and dark teal gradient, soft turquoise accents, low contrast minimalist abstract, oceanic depth wallpaper',
    // 11 - Lineas topograficas suaves
    'abstract topographic depth lines curving softly across the canvas with small subtle dim dots, deep midnight blue background with soft teal-green undertones, muted cyan accents, calm minimalist wallpaper, low contrast',
    // 12 - Constelacion tenue
    'loose network of dim stars connected by thin soft lines, deep navy blue gradient with muted teal undertones, small low brightness dots, calm minimalist celestial aesthetic, low contrast wallpaper',
  ];

  await mkdir(patternsDir, { recursive: true });
  const generatedPaths = [];

  for (let i = 0; i < PATTERN_PROMPTS.length; i++) {
    const prompt = PATTERN_PROMPTS[i];
    const seed = 5000 + i * 137;
    let url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&model=flux&seed=${seed}&nologo=true&enhance=true`;
    if (POLLINATIONS_TOKEN) url += `&token=${encodeURIComponent(POLLINATIONS_TOKEN)}`;

    const dest = path.join(patternsDir, `bg_pattern_${i}.png`);
    try {
      await downloadToFile(url, dest, { timeoutMs: 90000, maxRetries: 3 });
      generatedPaths.push(dest);
      logger?.info?.({ idx: i, dest }, 'pattern background baked from pollinations');
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
 * Pre-renderiza un PNG con la frase cursiva sobre fondo transparente, del
 * mismo ancho que el video (asi el centrado se hereda automaticamente al
 * overlayar). Lo usa ensureOutroClip para hacer el efecto typing via crop
 * dinamico (mas barato que apilar 50 drawtexts).
 *
 * Drop shadow integrado: el shadow se renderiza primero (texto en negro con
 * boxblur) y luego el texto en color encima. Esto garantiza legibilidad
 * sobre cualquier fondo.
 */
export async function ensureOutroPhrasePng(params, logger) {
  const {
    outputPath, videoW, fontFile, phraseText, phraseFontSize, phraseColor,
    shadowOffsetX, shadowOffsetY, shadowBlur, shadowAlpha,
  } = params;
  const textColor = `0x${phraseColor.replace('#', '').toUpperCase()}`;
  const fontFilePosix = fontFile.replace(/\\/g, '/');
  const escapeArg = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Alto del PNG: amplio para incluir el blur del shadow (puede salirse del
  // texto). 2x el fontsize cubre fontsize + descender + blur sin recortar.
  const phraseH = Math.round(phraseFontSize * 2);
  // drawtext soporta shadowx/shadowy/shadowcolor nativamente. La sombra de
  // drawtext NO esta blureada — para conseguir blur de verdad usamos un
  // segundo drawtext en negro detras y le aplicamos boxblur, luego dibujamos
  // el texto en blanco encima.
  const shadowColor = `black@${shadowAlpha}`;
  const filter = [
    // Capa 1: sombra (texto en negro semitransparente, blureada)
    `[0:v]drawtext=fontfile='${escapeArg(fontFilePosix)}':text='${escapeArg(phraseText)}':fontsize=${phraseFontSize}:fontcolor=${shadowColor}:x=(w-text_w)/2+${shadowOffsetX}:y=(h-text_h)/2+${shadowOffsetY},boxblur=${shadowBlur}:1[shadow]`,
    // Capa 2: texto en color encima
    `[shadow]drawtext=fontfile='${escapeArg(fontFilePosix)}':text='${escapeArg(phraseText)}':fontsize=${phraseFontSize}:fontcolor=${textColor}:x=(w-text_w)/2:y=(h-text_h)/2,format=rgba[out]`,
  ].join(';');
  try {
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=black@0:s=${videoW}x${phraseH}:r=1:d=1`,
      '-filter_complex', filter,
      '-map', '[out]',
      '-frames:v', '1',
      outputPath,
    ]);
    const s = await stat(outputPath);
    logger?.info?.({ outputPath, bytes: s.size, videoW, phraseH }, 'outro phrase PNG pre-rendered with shadow');
    return { path: outputPath, height: phraseH };
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'outro phrase PNG pre-render failed');
    return null;
  }
}

/**
 * Pre-renderiza el CLIP MP4 outro completo:
 *   - Fondo: bg_gradient.png (mismo estilo del reel) escalado y loopeado
 *   - Logo: PNG resized con fade-in alpha animado (0 → logo_fade_in_duration)
 *   - Frase: PNG pre-renderizado con crop horizontal dinamico (efecto typing)
 *   - Audio: silencio
 *
 * Mismos codec/fps/profile que el video principal para que el xfade del
 * paso final pueda concatenarlos limpiamente.
 *
 * Se ejecuta UNA SOLA VEZ al arrancar el worker.
 */
export async function ensureOutroClip(params, logger) {
  const {
    outputPath, videoW, videoH, fps, duration, crf, preset, audioBitrate,
    bgPath, originalLogoPath, phrasePngPath, phrasePngHeight,
    logoWidth, logoY, logoFadeInDuration,
    phraseY, phraseTypingStart, phraseTypingDuration,
    backdropColor,
  } = params;

  const navyColor = `0x${backdropColor.replace('#', '').toUpperCase()}`;
  const shadowOffsetX = params.shadowOffsetX ?? 6;
  const shadowOffsetY = params.shadowOffsetY ?? 6;
  const shadowBlur = params.shadowBlur ?? 14;
  const shadowAlpha = params.shadowAlpha ?? 0.65;

  // Filter complex:
  // - Input 0: fondo (bg pattern del reel) (loop)
  // - Input 1: logo PNG (loop)
  // - Input 2: frase PNG (loop, ya con shadow integrado)
  // - Input 3: audio silencio
  //
  // Drop shadow del logo: split del logo en 2 streams. Uno se convierte a
  // negro (manteniendo alpha) y se aplica boxblur — esa es la sombra. Se
  // overlayea con offset detras del logo original.
  const typingEnd = phraseTypingStart + phraseTypingDuration;
  const filter = [
    // Fondo: escalar para llenar 1080x1350 manteniendo aspect ratio (cover)
    `[0:v]scale=${videoW}:${videoH}:force_original_aspect_ratio=increase,crop=${videoW}:${videoH},format=yuv420p[bg]`,
    // Logo: split en 2. shadow = negro + blur. logo_main = original con fade-in.
    `[1:v]scale=${logoWidth}:-1,format=rgba,split=2[logo_pre_shadow][logo_pre_main]`,
    // Generar shadow: colorchannelmixer pone RGB a 0 manteniendo alpha (siluetazo negro),
    // luego boxblur lo difumina, luego ajustamos alpha multiplicando por shadowAlpha
    // (via colorchannelmixer aa=shadowAlpha).
    `[logo_pre_shadow]colorchannelmixer=rr=0:gg=0:bb=0:aa=${shadowAlpha},boxblur=${shadowBlur}:1[logo_shadow]`,
    // Logo principal con fade-in
    `[logo_pre_main]fade=in:st=0:d=${logoFadeInDuration}:alpha=1[logo_main]`,
    // Frase: crop horizontal dinamico para efecto typing
    `[2:v]format=rgba,crop=w='max(2,${videoW}*min(1,max(0,(t-${phraseTypingStart}))/${phraseTypingDuration}))':h=${phrasePngHeight}:x=0:y=0[phrase]`,
    // Composicion: bg → shadow del logo (con offset) → logo encima → frase encima
    `[bg][logo_shadow]overlay=x=(W-w)/2+${shadowOffsetX}:y=${logoY}+${shadowOffsetY}:format=auto[bg_with_shadow]`,
    `[bg_with_shadow][logo_main]overlay=x=(W-w)/2:y=${logoY}:format=auto[withlogo]`,
    `[withlogo][phrase]overlay=x=0:y=${phraseY}:enable='gte(t,${phraseTypingStart})':format=auto,format=yuv420p[vout]`,
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
      // Input 2: frase PNG
      '-loop', '1',
      '-t', duration.toString(),
      '-i', phrasePngPath,
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
    return outputPath;
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'outro clip pre-render failed, reels saldran sin outro');
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
    const outroOutputPath = path.join(patternsBaseDir, `outro_clip_${i}.mp4`);
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
  try {
    await runFfmpeg([
      '-y',
      '-i', originalLogoPath,
      '-vf', `scale=${targetWidth}:-1:flags=lanczos`,
      '-frames:v', '1',
      resizedLogoPath,
    ]);
    const s = await stat(resizedLogoPath);
    logger?.info?.({ resizedLogoPath, bytes: s.size, targetWidth }, 'logo resized for outro');
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
    const pngs = files
      .filter((f) => f.endsWith('.png'))
      .map((f) => path.join(patternsDir, f))
      .sort();
    if (pngs.length > 0) return pngs;
  } catch (e) {
    /* directorio no existe */
  }
  return [singleFallbackPath];
}
