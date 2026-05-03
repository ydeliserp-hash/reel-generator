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
  // Patron tipo "globo terraqueo": circulos concentricos (paralelos)
  // + lineas radiales (meridianos) que parten del centro.
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  const circleStep = 90;     // separacion entre circulos
  const angleStep = 15;      // separacion angular entre meridianos (grados)
  const lineThickness = 2;   // grosor en px de cada linea
  // Expresion ffmpeg geq: pixel on-line si esta cerca de un circulo o de un radial
  const onCircleExpr = `lt(abs(mod(hypot(X-${cx},Y-${cy}),${circleStep})-${circleStep}/2),${lineThickness})`;
  const onRadialExpr = `lt(abs(mod(abs(atan2(Y-${cy},X-${cx})*180/PI),${angleStep})-${angleStep}/2),0.5)`;
  const onLineExpr = `gt(${onCircleExpr}+${onRadialExpr},0)`;
  // El filtro globe-grid genera un PNG transparente con lineas azul claro
  // donde la condicion onLine es verdadera. Despues lo combinamos con el
  // gradiente via overlay.
  const globeGridFilter = `format=rgba,geq=r=111:g=168:b=220:a='if(${onLineExpr},220,0)'`;

  // Generamos en una sola llamada: gradiente lineal + overlay del globe-grid
  // [0:v] = gradiente, [1:v] = patron globe transparente
  // overlay los compone en el output final.
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
    logger?.info?.({ outputPath }, 'background baked (gradient + globe grid)');
  } catch (e) {
    logger?.warn?.({ err: e.message }, 'globe grid falla, fallback a color + drawgrid');
    // Fallback simple si geq es muy lento o falla
    try {
      await runFfmpeg([
        '-y',
        '-f', 'lavfi',
        '-i', `gradients=size=${w}x${h}:c0=${cDark}:c1=${cBright}:x0=0:y0=0:x1=${w}:y1=${h}:type=linear:duration=1:rate=1`,
        '-vf', 'drawgrid=width=80:height=80:thickness=2:color=0x6FA8DC',
        '-frames:v', '1',
        outputPath,
      ]);
      logger?.info?.({ outputPath }, 'background baked (gradient + simple grid fallback)');
    } catch (e2) {
      logger?.warn?.({ err: e2.message }, 'gradients no disponible, color solido');
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
