/**
 * Genera (idempotente) el PNG de fondo navy con degradado radial.
 *
 * Si el filtro `gradients` no esta disponible o falla, hace fallback a un
 * PNG navy solido para no bloquear el arranque del worker.
 *
 * TODO: Fase 2 — usar este PNG como underlay en `compose.js` (overlay del
 * asset sobre el degradado en lugar del relleno solido actual del filtro
 * `pad=...:color=NAVY`). Implica anadir un input `-loop 1 -i bg.png` en
 * cada llamada de buildImageSegment / buildVideoSegment y reemplazar el
 * `pad` por un `overlay` con coordenadas Y=ASSET_TOP_Y.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { BRAND, ffmpegColor } from '../branding.js';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err += c.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

export async function ensureGradientBackground(outputPath, logger) {
  // SIEMPRE regenerar al arranque: si las dimensiones del branding cambiaron
  // (ej. de 9:16 a 4:5), el PNG cacheado ya no sirve. La generacion es ~500ms.
  const w = BRAND.video.width;
  const h = BRAND.video.height;
  // Para visibilidad real del gradiente, fuerzo contraste mayor que el de
  // bg_dark/bg_mid (que son muy parecidos). Manteniendo paleta navy.
  const cDark = '0x050E22';   // mucho mas oscuro que bg_dark (#0A1F3D)
  const cBright = '0x3578D5'; // mucho mas brillante que bg_mid (#1B4F8C)
  // Rejilla bien visible: lightblue 25% sobre navy + thickness 2px
  const gridFilter = 'drawgrid=width=50:height=50:thickness=2:color=lightblue@0.22';

  try {
    // Gradiente lineal diagonal (esquina top-left oscura, bottom-right clara)
    // + rejilla azul claro visible tipo UI medico
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `gradients=size=${w}x${h}:c0=${cDark}:c1=${cBright}:x0=0:y0=0:x1=${w}:y1=${h}:type=linear:duration=1:rate=1`,
      '-vf', gridFilter,
      '-frames:v', '1',
      outputPath,
    ]);
    logger?.info?.({ outputPath }, 'gradient background baked (linear diagonal + visible grid)');
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'gradients lineal falla, intentando radial');
    try {
      await runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `gradients=size=${w}x${h}:c0=${cBright}:c1=${cDark}:type=radial:duration=1:rate=1`,
        '-vf', gridFilter,
        '-frames:v', '1',
        outputPath,
      ]);
      logger?.info?.({ outputPath }, 'gradient background baked (radial fallback + grid)');
    } catch (e2) {
      logger?.warn?.({ err: e2.message }, 'gradients no disponible, color solido + grid');
      await runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `color=c=${cDark}:s=${w}x${h}`,
        '-vf', gridFilter,
        '-frames:v', '1',
        outputPath,
      ]);
    }
  }
  return outputPath;
}
