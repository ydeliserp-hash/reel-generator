/**
 * Descarga una URL a un fichero local usando `fetch` nativo (Node 20+).
 * Sigue redirecciones por defecto. Lanza Error si el status no es 2xx.
 */
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function downloadToFile(url, destPath, { timeoutMs = 90000, headers = {}, maxRetries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers,
      });
      // Retry con backoff exponencial en errores transitorios
      if (res.status === 429 || res.status === 503 || res.status === 502) {
        const waitMs = Math.min(2000 * Math.pow(2, attempt), 30000); // 2s, 4s, 8s, 16s, 30s
        lastErr = new Error(`download failed: ${res.status} for ${url}`);
        clearTimeout(timer);
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
      }
      if (!res.body) {
        throw new Error(`download response has no body for ${url}`);
      }
      const fileStream = createWriteStream(destPath);
      await pipeline(Readable.fromWeb(res.body), fileStream);
      return destPath;
    } catch (e) {
      lastErr = e;
      // No reintentar si es error de validacion o cliente (4xx que no sea 429)
      if (e.message?.includes('download failed: 4') && !e.message.includes('429')) {
        throw e;
      }
      if (attempt < maxRetries - 1) {
        const waitMs = Math.min(1500 * Math.pow(2, attempt), 15000);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`download failed after ${maxRetries} attempts: ${url}`);
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
