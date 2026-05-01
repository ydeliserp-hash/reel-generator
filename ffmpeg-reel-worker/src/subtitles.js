/**
 * Generador de archivos .ass (Advanced SubStation Alpha) para subtitulos
 * quemados en los reels.
 *
 * Por que ASS y no SRT:
 *   - Permite estilo preciso (fuente, tamano, outline, shadow, alineacion)
 *     dentro del propio fichero, sin pasar argumentos extra al filtro `ass=`.
 *   - El renderer libass es muy estable en FFmpeg.
 *
 * Flujo:
 *   buildAssContent(segments) -> string  (puro)
 *   writeSubtitleFile(segments, path)    (escribe a disco)
 */

import { writeFile } from 'node:fs/promises';
import { BRAND, assColor, pctY } from './branding.js';

/**
 * Convierte segundos a formato ASS: H:MM:SS.cc (centesimas de segundo).
 */
export function formatAssTime(seconds) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Escapa caracteres con significado especial en ASS dentro del campo Text.
 */
function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

/**
 * Word-wrap greedy: parte un texto en lineas de max `maxChars` caracteres,
 * sin partir palabras. Si una unica palabra excede `maxChars`, se conserva
 * en su propia linea (no se trunca).
 */
export function wrapToLines(text, maxChars) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Parte un texto largo en chunks donde cada uno cabe en `maxLines` lineas
 * de `maxChars`. Cada chunk se mostrara como un evento Dialogue separado,
 * con el tiempo del segmento dividido proporcionalmente al numero de chars.
 *
 * Esto cubre el caso comun: un segmento de 5s con ~70 caracteres no cabe en
 * 2 lineas de 22 chars (44 chars max), asi que se subdivide en 2-3 chunks.
 */
export function splitIntoChunks(text, maxChars, maxLines) {
  const maxLength = maxChars * maxLines;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Construye una linea Dialogue ASS, con word-wrap interno usando `\N`.
 */
function buildDialogueLine(start, end, text) {
  const lines = wrapToLines(text, BRAND.subtitle.max_chars_per_line);
  const visibleLines = lines.slice(0, BRAND.subtitle.max_lines);
  const overflow = lines.slice(BRAND.subtitle.max_lines).join(' ');
  if (overflow && visibleLines.length > 0) {
    visibleLines[visibleLines.length - 1] += ' ' + overflow;
  } else if (overflow) {
    visibleLines.push(overflow);
  }
  const escaped = visibleLines.map(escapeAssText).join('\\N');
  return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,,0,0,0,,${escaped}`;
}

/**
 * Genera el contenido completo del fichero .ass.
 *
 * @param {Array<{start:number,end:number,subtitle_text:string}>} segments
 * @returns {string}
 */
export function buildAssContent(segments) {
  const { width, height } = BRAND.video;
  const fontName = BRAND.fonts.subtitle;
  const fontSize = BRAND.subtitle.font_size;
  const primary = assColor(BRAND.colors.text_primary);
  const outline = assColor(BRAND.colors.text_outline);
  const back = assColor('#000000');
  // MarginV en ASS, con Alignment 8 (top center), es la distancia desde
  // el borde superior al limite superior del texto.
  const marginV = pctY(BRAND.positions.subtitle_y_pct);

  const header = [
    '[Script Info]',
    'Title: Reel Subtitles',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    'Collisions: Normal',
    'Timer: 100.0000',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Bold = -1 (true en ASS). BorderStyle = 1 (outline + shadow).
    // Alignment 8 = top center. Encoding 1 = default.
    `Style: Default,${fontName},${fontSize},${primary},&H000000FF,${outline},${back},-1,0,0,0,100,100,0,0,1,${BRAND.subtitle.outline_width},${BRAND.subtitle.shadow_offset},8,40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = [];
  for (const seg of segments) {
    const text = (seg.subtitle_text || '').trim();
    if (!text) continue;
    const segDuration = seg.end - seg.start;
    if (segDuration <= 0) continue;

    const chunks = splitIntoChunks(
      text,
      BRAND.subtitle.max_chars_per_line,
      BRAND.subtitle.max_lines
    );
    if (chunks.length === 0) continue;

    // Distribucion proporcional al numero de caracteres de cada chunk
    // (mas natural que partes iguales — un chunk con mas palabras dura mas).
    const totalChars = chunks.reduce((acc, c) => acc + c.length, 0) || 1;
    let cursor = seg.start;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const portion = (chunks[i].length / totalChars) * segDuration;
      const chunkStart = cursor;
      const chunkEnd = isLast ? seg.end : cursor + portion;
      events.push(buildDialogueLine(chunkStart, chunkEnd, chunks[i]));
      cursor = chunkEnd;
    }
  }

  return [...header, ...events, ''].join('\n');
}

/**
 * Genera y escribe el fichero .ass en disco.
 *
 * @returns {Promise<string>} ruta absoluta del fichero escrito.
 */
export async function writeSubtitleFile(segments, outputPath) {
  const content = buildAssContent(segments);
  await writeFile(outputPath, content, 'utf8');
  return outputPath;
}
