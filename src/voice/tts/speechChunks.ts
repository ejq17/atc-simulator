/**
 * Splitting a transmission into pieces that are synthesised one after the other. The model needs roughly 0.4 s plus a quarter
 * of a second per second of speech (measured, see src/voice/README.md), so the first piece should be short: it can start playing
 * while the rest is still being synthesised. Pieces end at punctuation so the join falls on a natural pause.
 */

export interface ChunkOptions {
  /** Fewest words in the first piece (very short fragments sound choppy). Default 3. */
  firstMinWords?: number;
  /** Most words in any later piece. Default 14. */
  maxWords?: number;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function splitSpeech(text: string, options: ChunkOptions = {}): string[] {
  const firstMin = options.firstMinWords ?? 3;
  const maxWords = options.maxWords ?? 14;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (wordCount(clean) <= firstMin * 2) return [clean];
  const clauses = clean.split(/(?<=[,;:.!?])\s+/).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const clause of clauses) {
    if (chunks.length === 0) {
      cur = cur ? `${cur} ${clause}` : clause;
      if (wordCount(cur) >= firstMin) {
        chunks.push(cur);
        cur = '';
      }
      continue;
    }
    if (cur && wordCount(cur) + wordCount(clause) > maxWords) {
      chunks.push(cur);
      cur = clause;
    } else {
      cur = cur ? `${cur} ${clause}` : clause;
    }
  }
  if (cur) {
    // A short tail ("... echo juliet") joins the piece before it instead of standing alone.
    if (chunks.length > 0 && wordCount(cur) < firstMin) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${cur}`;
    else chunks.push(cur);
  }
  return chunks;
}

/**
 * Cut the near-silent lead-in and tail the model leaves around speech, keeping `keepMs` on each side, so pieces join closely
 * and the first sound starts sooner. Returns a view of the same samples.
 */
export function trimSilence(samples: Float32Array, sampleRate: number, keepMs = 25, threshold = 0.004): Float32Array {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < threshold) first++;
  if (first === samples.length) return samples.subarray(0, Math.min(samples.length, Math.round((sampleRate * keepMs) / 1000)));
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < threshold) last--;
  const keep = Math.round((sampleRate * keepMs) / 1000);
  return samples.subarray(Math.max(0, first - keep), Math.min(samples.length, last + 1 + keep));
}
