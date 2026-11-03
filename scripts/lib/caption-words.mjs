// Word timings for Short captions that follow the user's transcript corrections.
// whisper (-ml 1) gives the raw words with exact times; work/transcript.tr.json holds the reviewed text per segment
// but no word times. Each segment's corrected tokens are aligned (LCS) to the raw words inside it: matching words keep
// their own time, replaced or added words are spread over the gap between their matched neighbours.
const norm = (s) => s.toLocaleLowerCase("tr-TR").replace(/[^\p{L}\p{N}]+/gu, "");

function lcsPairs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return pairs;
}

function alignSegment(raw, seg) {
  const tokens = seg.text.split(/\s+/).filter(Boolean);
  const pairs = lcsPairs(raw.map((w) => norm(w.text)), tokens.map(norm)).filter(([i]) => norm(raw[i].text) !== "");
  const out = [];
  let ri = 0, ci = 0;
  for (const [i, j] of [...pairs, [raw.length, tokens.length]]) {
    const gapRaw = raw.slice(ri, i), gapTok = tokens.slice(ci, j);
    if (gapTok.length) {
      const prevT = out.length ? out[out.length - 1].t : seg.start;
      const nextT = i < raw.length ? raw[i].t : seg.end;
      const from = gapRaw.length ? gapRaw[0].t : prevT, to = Math.max(from, nextT);
      gapTok.forEach((text, k) => out.push({ t: gapRaw.length ? from + ((to - from) * k) / gapTok.length : from + ((to - from) * (k + 1)) / (gapTok.length + 1), text }));
    }
    if (i < raw.length) out.push({ t: raw[i].t, text: tokens[j] });
    ri = i + 1; ci = j + 1;
  }
  return out;
}

/** rawWords: [{t, text}] from whisper; segments: transcript.tr.json segments. Returns [{t, text}] with the corrected text. */
export function correctedWords(rawWords, segments) {
  if (!segments?.length) return rawWords;
  const segs = [...segments].sort((a, b) => a.start - b.start);
  const buckets = segs.map(() => []);
  for (const w of rawWords) {
    let k = 0;
    while (k + 1 < segs.length && segs[k + 1].start <= w.t + 0.05) k++;
    buckets[k].push(w);
  }
  const out = segs.flatMap((seg, k) => alignSegment(buckets[k], seg));
  return out.map((w, i) => ({ ...w, t: Math.max(w.t, i ? out[i - 1].t : 0) })); // never run backwards
}
