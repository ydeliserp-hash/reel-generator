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
  const c0 = ffmpegColor(BRAND.colors.bg_mid);
  const c1 = ffmpegColor(BRAND.colors.bg_dark);

  try {
    // Gradiente lineal en diagonal 45 grados (oscuro en 2 esquinas opuestas,
    // mas claro en las otras 2) + rejilla gris sutil tipo UI medico/tech.
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `gradients=size=${w}x${h}:c0=${c1}:c1=${c0}:x0=0:y0=0:x1=${w}:y1=${h}:type=linear:duration=1:rate=1`,
      '-vf', 'drawgrid=width=60:height=60:thickness=1:color=gray@0.10',
      '-frames:v', '1',
      outputPath,
    ]);
    logger?.info?.({ outputPath }, 'gradient background baked (linear diagonal + grid)');
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'gradients filter falla, intentando radial');
    try {
      await runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `gradients=size=${w}x${h}:c0=${c0}:c1=${c1}:type=radial:duration=1:rate=1`,
        '-vf', 'drawgrid=width=60:height=60:thickness=1:color=gray@0.10',
        '-frames:v', '1',
        outputPath,
      ]);
      logger?.info?.({ outputPath }, 'gradient background baked (radial fallback + grid)');
    } catch (e2) {
      logger?.warn?.({ err: e2.message }, 'gradients no disponible, color solido');
      await runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `color=c=${c1}:s=${w}x${h}`,
        '-vf', 'drawgrid=width=60:height=60:thickness=1:color=gray@0.10',
        '-frames:v', '1',
        outputPath,
      ]);
    }
  }
  return outputPath;
}
