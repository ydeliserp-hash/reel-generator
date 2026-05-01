/**
 * Wrapper minimo sobre `ffprobe` para extraer metadatos de un fichero.
 */
import { spawn } from 'node:child_process';

function spawnFfprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => (stdout += c.toString()));
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited ${code}: ${stderr.trim()}`));
      }
      resolve(stdout);
    });
  });
}

/**
 * Devuelve la duracion en segundos de un fichero (audio o video).
 */
export async function probeDuration(filePath) {
  const out = await spawnFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const dur = parseFloat(out.trim());
  if (!Number.isFinite(dur)) {
    throw new Error(`ffprobe returned invalid duration: ${out}`);
  }
  return dur;
}

/**
 * Devuelve un objeto con anchura, altura y duracion del primer stream de video.
 * Si no hay stream de video (audio puro), `width` y `height` seran null.
 */
export async function probeVideo(filePath) {
  const out = await spawnFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    filePath,
  ]);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`ffprobe JSON parse failed: ${e.message}`);
  }
  const stream = parsed.streams?.[0] ?? {};
  const dur = parseFloat(parsed.format?.duration ?? 'NaN');
  return {
    width: stream.width ?? null,
    height: stream.height ?? null,
    duration: Number.isFinite(dur) ? dur : null,
  };
}
