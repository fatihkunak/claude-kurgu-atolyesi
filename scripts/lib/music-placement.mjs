// Müzik stem'i filtre zinciri (scripts/75-audio.mjs, bölüm 4) — saf mantık, ffmpeg çalıştırmaz; tests/scripts.test.mjs doğrular.
// selection.musicPlace YOKSA zincir eskisiyle BİREBİR aynıdır (başlangıç 0, tüm parça, videoya kadar).
// selection.musicPlace = { start, in, out, gainDb? }: Montaj'daki müzik klibi — kaynaktan [in, out) kesilir, videonun `start`. saniyesine konur.

/** Geçerli yerleşimi doğrular; hata mesajı ya da null döndürür. */
export function checkPlace(place, videoSeconds) {
  if (place == null) return null;
  const { start, in: tin, out } = place;
  if (![start, tin, out].every((v) => Number.isFinite(v) && v >= 0)) return "musicPlace: start/in/out sonlu ve ≥ 0 olmalı.";
  if (!(out > tin + 0.1)) return "musicPlace: out, in'den en az 0,1 sn büyük olmalı.";
  if (start >= videoSeconds - 0.1) return `musicPlace: müzik videonun sonunda (${start} sn ≥ ${videoSeconds.toFixed(1)} sn) başlıyor.`;
  return null;
}

/**
 * [0:a] → ... → [m]. place yoksa eski zincir. Varsa: kesit uzunluğu videodan taşıyorsa kırpılır, fade'ler kesite göre,
 * adelay ile `start`'a yerleştirilir (aynı kodlayıcı girişi: kesit zaten -ss/-t ile ayrı dosyaya çıkarılmış olmalı).
 */
export function musicStemFilter({ SR, dur, TOTAL, gainDb, fadeIn, fadeOut, place, segLen }) {
  const head = `[0:a]aresample=${SR}:filter_size=64:cutoff=0.97,aformat=sample_fmts=flt:channel_layouts=stereo`;
  if (!place) {
    return `${head},atrim=0:${dur},volume=${gainDb.toFixed(2)}dB,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${(dur - fadeOut).toFixed(3)}:d=${fadeOut},apad=whole_len=${TOTAL}[m]`;
  }
  const end = Math.max(0.1, Math.min(segLen, dur - place.start)); // kesitin kullanılan uzunluğu
  const fi = Math.min(fadeIn, end / 2), fo = Math.min(fadeOut, end / 2);
  const g = gainDb + (place.gainDb ?? 0);
  return `${head},atrim=0:${end.toFixed(3)},volume=${g.toFixed(2)}dB,afade=t=in:st=0:d=${fi.toFixed(3)},afade=t=out:st=${(end - fo).toFixed(3)}:d=${fo.toFixed(3)},adelay=${Math.round(place.start * 1000)}:all=1,apad=whole_len=${TOTAL}[m]`;
}

/** Kesit için ffmpeg giriş argümanları (-ss/-t); müzik dosyasından [in,out) çıkarılır. */
export const cutArgs = (file, place) => ["-ss", String(place.in), "-t", String(place.out - place.in), "-i", file];
