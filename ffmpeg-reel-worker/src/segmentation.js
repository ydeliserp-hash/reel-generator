/**
 * Smart Segmentation v3 — agrupa palabras de Whisper en IDEAS/FRASES.
 *
 * Mismo algoritmo que el nodo "Segment Transcript" del workflow normal.
 * Aqui lo tenemos en el worker para usarlo en el flujo curado de
 * /analyze sin pasar por n8n.
 *
 * Estrategia:
 *   - Cortar SOLO en puntuacion fuerte (. ! ? ¿ ¡)
 *   - Si una frase es muy larga (>MAX_IDEA_DUR), partirla en 2 en una coma
 *     cercana al medio
 *   - Si es muy corta (<MIN_IDEA_DUR), fusionarla con la siguiente
 */

function endsWithStrong(text) {
  return /[.!?¿¡]\s*$/u.test(text);
}
function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function splitLong(idea, MAX_IDEA_DUR) {
  const dur = idea.end - idea.start;
  if (dur <= MAX_IDEA_DUR) return [idea];
  const midTime = idea.start + dur / 2;
  let bestSplit = -1;
  let bestDist = Infinity;
  for (let i = 0; i < idea.words.length - 1; i++) {
    const w = idea.words[i];
    if (/[,;:]\s*$/u.test(w.word || '')) {
      const d = Math.abs(w.end - midTime);
      if (d < bestDist) { bestDist = d; bestSplit = i; }
    }
  }
  if (bestSplit < 0) bestSplit = Math.floor(idea.words.length / 2) - 1;
  if (bestSplit < 0) return [idea];
  const wordsA = idea.words.slice(0, bestSplit + 1);
  const wordsB = idea.words.slice(bestSplit + 1);
  if (wordsA.length === 0 || wordsB.length === 0) return [idea];
  const a = {
    start: wordsA[0].start,
    end: wordsA[wordsA.length - 1].end,
    text: wordsA.map((w) => (w.word || '').trim()).join(' '),
    words: wordsA,
  };
  const b = {
    start: wordsB[0].start,
    end: wordsB[wordsB.length - 1].end,
    text: wordsB.map((w) => (w.word || '').trim()).join(' '),
    words: wordsB,
  };
  return [...splitLong(a), ...splitLong(b)];
}

/**
 * Convierte la respuesta verbose_json de Whisper en una lista de segmentos
 * agrupados por idea/frase.
 *
 * @param {{words?: Array, segments?: Array}} transcript
 * @returns {Array<{start: number, end: number, text: string}>}
 */
export function smartSegment(transcript) {
  const rawWords = Array.isArray(transcript?.words) ? transcript.words : [];
  const rawSegments = Array.isArray(transcript?.segments) ? transcript.segments : [];

  if (rawWords.length === 0 && rawSegments.length === 0) return [];

  if (rawWords.length === 0) {
    return rawSegments.map((s) => ({
      start: s.start,
      end: s.end,
      text: normalize(s.text),
    }));
  }

  // Parametros dinamicos segun duracion total. El worker FFmpeg se queda
  // corto con >15 segmentos en su pipeline de concat-xfade, asi que en
  // audios largos producimos chunks mas largos.
  const totalDur = rawWords[rawWords.length - 1].end || 0;
  let MIN_IDEA_DUR, MAX_IDEA_DUR;
  if (totalDur > 120) {
    MIN_IDEA_DUR = 5.0; MAX_IDEA_DUR = 12.0;
  } else if (totalDur > 60) {
    MIN_IDEA_DUR = 4.0; MAX_IDEA_DUR = 10.0;
  } else {
    MIN_IDEA_DUR = 2.5; MAX_IDEA_DUR = 7.0;
  }

  // 1) Agrupar palabras en oraciones que terminen en puntuacion fuerte
  const sentences = [];
  let cur = null;
  for (const w of rawWords) {
    const wText = (w.word || '').trim();
    if (!wText) continue;
    if (cur === null) {
      cur = { start: w.start, end: w.end, text: wText, words: [w] };
    } else {
      cur.end = w.end;
      cur.text += ' ' + wText;
      cur.words.push(w);
    }
    if (endsWithStrong(cur.text)) {
      sentences.push(cur);
      cur = null;
    }
  }
  if (cur) sentences.push(cur);

  // 2) Partir oraciones demasiado largas
  let split = [];
  for (const s of sentences) split.push(...splitLong(s, MAX_IDEA_DUR));

  // 3) Fusionar oraciones muy cortas con la siguiente
  const merged = [];
  for (const idea of split) {
    const last = merged[merged.length - 1];
    const dur = idea.end - idea.start;
    if (last) {
      const lastDur = last.end - last.start;
      const combinedDur = idea.end - last.start;
      if ((lastDur < MIN_IDEA_DUR || dur < MIN_IDEA_DUR) && combinedDur <= MAX_IDEA_DUR) {
        last.end = idea.end;
        last.text = normalize(last.text + ' ' + idea.text);
        continue;
      }
    }
    merged.push({ start: idea.start, end: idea.end, text: normalize(idea.text) });
  }

  // 4) HARD CAP a 12 segmentos — fusiona los pares adyacentes mas cortos
  // hasta bajar, evitando que el worker se sature en concat-xfade.
  const MAX_SEGMENTS = 12;
  while (merged.length > MAX_SEGMENTS) {
    let bestIdx = -1;
    let bestSum = Infinity;
    for (let i = 0; i < merged.length - 1; i++) {
      const sum = (merged[i].end - merged[i].start) + (merged[i + 1].end - merged[i + 1].start);
      if (sum < bestSum) { bestSum = sum; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    merged[bestIdx].end = merged[bestIdx + 1].end;
    merged[bestIdx].text = normalize(merged[bestIdx].text + ' ' + merged[bestIdx + 1].text);
    merged.splice(bestIdx + 1, 1);
  }

  return merged;
}
