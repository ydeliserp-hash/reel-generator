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
  // Set curado por la doctora: solo los patterns que mejor encajan con su
  // estilo medico/tech. Originalmente eran 15 (plexus, hexagonos, ondas,
  // etc.); estos 7 son los favoritos confirmados visualmente.
  const PATTERN_PROMPTS = [
    // 0 - Plexus / red de nodos conectados
    'minimalist plexus network of connected dots and bright thin lines floating in space, deep navy blue gradient background, cyan and electric blue accent dots, abstract tech aesthetic, minimal composition',
    // 1 - Constelacion (originalmente idx 3)
    'constellation of connected stars and bright dots with thin white lines, deep navy night sky background, minimalist celestial pattern, soft glow',
    // 2 - Poligonos / triangulos (originalmente idx 4)
    'abstract geometric polygon network triangles and dots, deep navy and teal gradient background, soft green and cyan accent lines, minimalist science visualization',
    // 3 - Particulas brillantes flotantes (originalmente idx 8)
    'soft floating particles and tiny glowing orbs scattered across deep navy gradient background, cyan and white bokeh accents, ethereal minimalist composition, abstract science wallpaper',
    // 4 - Grid 3D perspectiva (originalmente idx 10)
    'subtle 3D perspective grid lines fading into distance with light points at intersections, deep navy gradient background, electric blue glow, retrofuturistic tech wallpaper, clean minimalist',
    // 5 - Cadena ADN / helix (originalmente idx 11)
    'abstract DNA double helix pattern with connected dots and thin curved lines, deep navy gradient background, soft teal and cyan accents, biotech minimalist wallpaper',
    // 6 - Red neuronal multicapa (originalmente idx 13)
    'abstract neural network with layers of connected nodes and bright synaptic lines, deep navy blue gradient background, cyan and electric blue accents, AI science minimalist wallpaper',
    // 7 - Nebulosa cosmica con estrellas
    'cosmic nebula with scattered bright stars and soft glowing dust clouds, deep navy and indigo space background, subtle cyan and white pinpoints, ethereal celestial wallpaper, minimalist',
    // 8 - Estructura cristalina 3D
    'abstract 3D crystal lattice structure with thin glowing edges and bright vertices, deep navy gradient background, soft teal and electric blue highlights, geometric biotech aesthetic, minimalist',
    // 9 - Particulas bioluminiscentes flotando
    'soft bioluminescent particles drifting in deep navy gradient space, glowing teal and emerald orbs of varying size, organic medical aesthetic, ethereal minimalist composition',
    // 10 - Sinapsis fluidas con flow
    'flowing synaptic connections with bright pulse points and curved thin lines, deep navy gradient background, electric blue and white glow, neural medical aesthetic, minimalist abstract',
    // 11 - Estructura atomica con orbitales
    'abstract atomic structure with elliptical orbital paths and bright nucleus points, deep navy gradient background, soft cyan and gold accents, scientific minimalist wallpaper',
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
 */
export async function ensureOutroPhrasePng(params, logger) {
  const { outputPath, videoW, fontFile, phraseText, phraseFontSize, phraseColor } = params;
  const textColor = `0x${phraseColor.replace('#', '').toUpperCase()}`;
  const fontFilePosix = fontFile.replace(/\\/g, '/');
  const escapeArg = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // Alto del PNG: 1.6x el fontsize para dejar margen vertical (descenders, etc).
  const phraseH = Math.round(phraseFontSize * 1.6);
  try {
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=black@0:s=${videoW}x${phraseH}:r=1:d=1`,
      '-vf', `drawtext=fontfile='${escapeArg(fontFilePosix)}':text='${escapeArg(phraseText)}':fontsize=${phraseFontSize}:fontcolor=${textColor}:x=(w-text_w)/2:y=(h-text_h)/2,format=rgba`,
      '-frames:v', '1',
      outputPath,
    ]);
    const s = await stat(outputPath);
    logger?.info?.({ outputPath, bytes: s.size, videoW, phraseH }, 'outro phrase PNG pre-rendered');
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

  // Filter complex:
  // - Input 0: fondo bg_gradient.png (loop)
  // - Input 1: logo PNG (loop)
  // - Input 2: frase PNG (loop)
  // - Input 3: audio silencio
  //
  // Steps:
  // 1. Escalar bg al tamano del video.
  // 2. Logo: format=rgba, fade-in alpha en los primeros logo_fade_in_duration s.
  // 3. Frase: format=rgba, crop horizontal dinamico segun t (typing).
  // 4. Overlay logo sobre bg.
  // 5. Overlay frase sobre lo anterior con enable= a partir de phrase_typing_start.
  const typingEnd = phraseTypingStart + phraseTypingDuration;
  const filter = [
    // Fondo
    `[0:v]scale=${videoW}:${videoH}:force_original_aspect_ratio=increase,crop=${videoW}:${videoH},format=yuv420p[bg]`,
    // Logo con fade-in alpha (0 → logoFadeInDuration)
    `[1:v]scale=${logoWidth}:-1,format=rgba,fade=in:st=0:d=${logoFadeInDuration}:alpha=1[logo]`,
    // Frase: crop dinamico para typing. w avanza de 0 a videoW entre typingStart y typingEnd.
    `[2:v]format=rgba,crop=w='max(2,${videoW}*min(1,max(0,(t-${phraseTypingStart}))/${phraseTypingDuration}))':h=${phrasePngHeight}:x=0:y=0[phrase]`,
    // Overlays
    `[bg][logo]overlay=x=(W-w)/2:y=${logoY}:format=auto[withlogo]`,
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
