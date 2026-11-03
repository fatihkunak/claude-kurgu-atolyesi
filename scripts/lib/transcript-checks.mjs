// Döküm denetimlerinin saf mantığı (dosya okuma/yazma yok): scripts/22 ve 23 bunları kullanır, tests/ doğrular.

export const norm = (t) => t.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
export const words = (t) => norm(t).split(" ").filter((w) => w.length >= 3);
/** whisper.cpp JSON'u → { start, end, text } (saniye); boş metinler atılır. */
export const seg = (j) => j.transcription.map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text.trim() })).filter((s) => s.text);

export const CREDITS = /altyazı\s*m\.?\s*k|abone ol|izlediğiniz için|bir sonraki videoda|amara\.org|altyazı/i;
export const WINDOW = 12; // saniye: uzun segmentlerde VAD zaman damgaları kayar

/**
 * Olası halüsinasyonlar: (1) VAD geçişinde karşılığı olmayan, (2) 3+ ardışık aynı metin, (3) bilinen kredi/veda kalıbı.
 * Yalnız işaretler, döküme dokunmaz.
 */
export function findHallucinations(raw, vad) {
  const findings = [];
  raw.forEach((s, i) => {
    const reasons = [];
    const w = words(s.text);
    if (w.length) {
      const pool = new Set(vad.filter((v) => v.end >= s.start - WINDOW && v.start <= s.end + WINDOW).flatMap((v) => words(v.text)));
      const hit = w.filter((x) => pool.has(x)).length / w.length;
      if (hit < 0.34) reasons.push(`VAD geçişinde karşılığı yok (eşleşme %${Math.round(hit * 100)})`);
    }
    let run = 1;
    for (let k = i - 1; k >= 0 && norm(raw[k].text) === norm(s.text); k--) run++;
    if (run >= 3) reasons.push(`aynı metnin ${run}. ardışık tekrarı`);
    if (CREDITS.test(s.text)) reasons.push("bilinen halüsinasyon kalıbı (altyazı kredisi / veda)");
    if (reasons.length) findings.push({ index: i, start: s.start, end: s.end, text: s.text, reasons });
  });
  return findings;
}

/** Konuşmasız kesitler (≥ minGap sn): kesme ADAYI. Segmentler çakışabilir; başlangıç ve bitiş dahil edilir. */
export function findGaps(segments, duration, minGap = 4) {
  const gaps = [];
  let prev = 0;
  for (const s of segments) { if (s.start - prev >= minGap) gaps.push({ from: prev, to: s.start }); prev = Math.max(prev, s.end); }
  if (duration - prev >= minGap) gaps.push({ from: prev, to: duration });
  return gaps;
}

/** Konuşma süresi (sn): whisper.cpp VAD geçişi JSON'undaki metinli segmentlerin toplamı. Konuşmasız klipte ~0. */
export const speechSeconds = (j) => seg(j).reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
export const MIN_SPEECH_SECONDS = 3;
/** whisper.cpp'nin boş çıktısı: sonraki adımlar (21, 22) konuşmasız klipte de çökmesin. */
export const EMPTY_WHISPER = { transcription: [] };
