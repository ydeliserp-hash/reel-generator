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
  const PATTERN_PROMPTS = [
    // 0 - Plexus / red de nodos conectados
    'minimalist plexus network of connected dots and bright thin lines floating in space, deep navy blue gradient background, cyan and electric blue accent dots, abstract tech aesthetic, minimal composition',
    // 1 - Hexagonos
    'abstract hexagonal mesh pattern, dark navy blue gradient background, soft emerald green and cyan outlines, glowing dots at vertices, geometric science wallpaper, minimalist',
    // 2 - Ondas / lineas fluidas con dots
    'flowing wave lines with bright dots and circuit board traces, deep navy gradient background, electric blue and white highlights, futuristic tech aesthetic',
    // 3 - Constelacion
    'constellation of connected stars and bright dots with thin white lines, deep navy night sky background, minimalist celestial pattern, soft glow',
    // 4 - Poligonos / triangulos
    'abstract geometric polygon network triangles and dots, deep navy and teal gradient background, soft green and cyan accent lines, minimalist science visualization',
    // 5 - Circuit board / placa de circuito
    'minimalist circuit board pattern with thin glowing traces and small chip nodes, deep navy gradient background, electric blue and gold accent lines, technological wallpaper, clean composition',
    // 6 - Holograma scan grid
    'holographic scan grid with subtle perspective lines and floating data points, deep navy blue gradient background, cyan and teal glow, futuristic interface aesthetic, minimalist',
    // 7 - ECG / electrocardiograma
    'subtle electrocardiogram heartbeat lines flowing horizontally with small bright pulse points, deep navy gradient background, electric blue and emerald green waveforms, medical tech aesthetic, minimal',
    // 8 - Particulas brillantes flotantes
    'soft floating particles and tiny glowing orbs scattered across deep navy gradient background, cyan and white bokeh accents, ethereal minimalist composition, abstract science wallpaper',
    // 9 - Radar / circulos concentricos
    'concentric circles radar pattern with thin glowing rings and small dots, deep navy blue gradient background, soft cyan and teal accents, sonar minimalist aesthetic',
    // 10 - Grid 3D perspectiva
    'subtle 3D perspective grid lines fading into distance with light points at intersections, deep navy gradient background, electric blue glow, retrofuturistic tech wallpaper, clean minimalist',
    // 11 - Cadena ADN / helix
    'abstract DNA double helix pattern with connected dots and thin curved lines, deep navy gradient background, soft teal and cyan accents, biotech minimalist wallpaper',
    // 12 - Curvas topograficas
    'minimalist topographic contour lines flowing organically across deep navy gradient background, thin emerald green and gold accents, abstract map aesthetic, clean composition',
    // 13 - Red neuronal multicapa
    'abstract neural network with layers of connected nodes and bright synaptic lines, deep navy blue gradient background, cyan and electric blue accents, AI science minimalist wallpaper',
    // 14 - Ondas sonoras horizontales
    'horizontal sound wave equalizer bars with soft glow and small dots, deep navy gradient background, teal and cyan vertical lines of varying height, audio tech minimalist aesthetic',
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
 * Pre-renderiza el outro completo como UN SOLO PNG de WxH (mismo tamano que
 * el video final). Combina backdrop navy semitransparente + logo redimensionado
 * + frase cursiva en una sola capa. Asi applyOverlays solo necesita UN
 * filtro `overlay` con `enable=` en vez de cuatro filtros distintos
 * (drawbox + drawtext + scale + overlay), lo que reduce drasticamente el
 * tiempo de procesamiento del filter graph.
 *
 * Devuelve el path del PNG generado, o null si falla.
 */
export async function ensureOutroOverlay(params, logger) {
  const {
    outputPath, videoW, videoH, originalLogoPath, fontFile,
    logoWidth, logoY, phraseText, phraseFontSize, phraseColor, phraseY,
    backdropColor, backdropAlpha, backdropPadding,
  } = params;

  // Construir filtro: empezamos con un fondo transparente WxH, dibujamos
  // el backdrop navy semitransparente, escalamos el logo y lo overlayeamos,
  // y dibujamos el texto cursivo.
  const backdropTop = Math.max(0, logoY - backdropPadding);
  // No conocemos el alto exacto del logo escalado hasta runtime; aproximamos
  // con un alto generoso (logoWidth * 0.6 = aspect ~5:3 que es lo del logo
  // original). Luego phrase y backdrop padding inferior.
  const approxLogoHeight = Math.round(logoWidth * 0.55);
  const backdropBottom = Math.min(videoH, phraseY + phraseFontSize + backdropPadding);
  const backdropX = backdropPadding;
  const backdropW = videoW - 2 * backdropPadding;
  const backdropH = backdropBottom - backdropTop;
  // Importante: ffmpeg requiere prefijo `0x` en MINUSCULAS (acepta los hex
  // RRGGBB en mayusculas). `0X` con X mayuscula da "Cannot find color".
  const navyAlpha = `0x${backdropColor.replace('#', '').toUpperCase()}@${backdropAlpha}`;
  const textColor = `0x${phraseColor.replace('#', '').toUpperCase()}`;
  const fontFilePosix = fontFile.replace(/\\/g, '/');
  const escapeArg = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const filter = [
    // Fondo transparente del tamano del video
    `color=c=black@0:s=${videoW}x${videoH}:r=1:d=1[bg]`,
    // Logo escalado
    `[1:v]scale=${logoWidth}:-1[logo]`,
    // Sobre el bg, drawbox del backdrop navy
    `[bg]drawbox=x=${backdropX}:y=${backdropTop}:w=${backdropW}:h=${backdropH}:color=${navyAlpha}:t=fill,format=rgba[withbox]`,
    // Overlay del logo
    `[withbox][logo]overlay=x=(W-w)/2:y=${logoY}[withlogo]`,
    // Drawtext de la frase
    `[withlogo]drawtext=fontfile='${escapeArg(fontFilePosix)}':text='${escapeArg(phraseText)}':fontsize=${phraseFontSize}:fontcolor=${textColor}:x=(w-text_w)/2:y=${phraseY}[out]`,
  ].join(';');

  try {
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=black@0:s=${videoW}x${videoH}:r=1:d=1`,
      '-i', originalLogoPath,
      '-filter_complex', filter,
      '-map', '[out]',
      '-frames:v', '1',
      outputPath,
    ]);
    const s = await stat(outputPath);
    logger?.info?.({ outputPath, bytes: s.size, videoW, videoH }, 'outro overlay PNG pre-rendered');
    return outputPath;
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'outro overlay pre-render failed, fallback al overlay multi-filtro en runtime');
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
