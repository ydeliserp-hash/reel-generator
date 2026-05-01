/**
 * Descarga una URL a un fichero local usando `fetch` nativo (Node 20+).
 * Sigue redirecciones por defecto. Lanza Error si el status no es 2xx.
 */
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function downloadToFile(url, destPath, { timeoutMs = 60000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers,
    });
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
    }
    if (!res.body) {
      throw new Error(`download response has no body for ${url}`);
    }
    const fileStream = createWriteStream(destPath);
    await pipeline(Readable.fromWeb(res.body), fileStream);
    return destPath;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrae la extension (con punto) de una URL, con fallback si no la tiene.
 */
export function extFromUrl(url, fallback) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/(\.[a-zA-Z0-9]+)$/);
    if (m) return m[1].toLowerCase();
  } catch {
    // url malformada — usamos fallback
  }
  return fallback;
}
