// Makes LISTENING SAMPLES of narration denoising (ffmpeg afftdn) and measures the noise floor.
// Preview only: scripts/75-audio.mjs keeps the narration untouched (its null-test depends on that).
// You cannot judge denoising by numbers (speech can sound watery), so the verdict needs ears.
// Usage: node scripts/76-denoise-preview.mjs [--start 25] [--dur 30]  → work/audio/denoise-preview/{orijinal,hafif,guclu}.wav
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { SOURCE, p } from "./lib/paths.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const start = arg("--start", 25), dur = arg("--dur", 30);
const dir = p("work/audio/denoise-preview");
mkdirSync(dir, { recursive: true });
const variants = {
  orijinal: "anull",
  hafif: "afftdn=nr=8:nf=-35:tn=1",
  guclu: "afftdn=nr=16:nf=-35:tn=1",
};
function windowsDb(file) { // 50 ms RMS windows, mono mix
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const n = raw.length / 2, win = 800, out = [];
  for (let i = 0; i + win <= n; i += win) { let s = 0; for (let k = 0; k < win; k++) { const v = raw.readInt16LE((i + k) * 2) / 32768; s += v * v; } out.push(10 * Math.log10(s / win + 1e-12)); }
  return out.sort((a, b) => a - b);
}
const q = (a, f) => a[Math.floor(f * (a.length - 1))];
const rows = [];
for (const [name, af] of Object.entries(variants)) {
  const file = `${dir}/${name}.wav`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(start), "-t", String(dur), "-i", SOURCE, "-map", "0:a:0", "-af", af, "-c:a", "pcm_s16le", file]);
  const w = windowsDb(file);
  rows.push({ name, noiseFloorDb: q(w, 0.1), speechDb: q(w, 0.9) });
}
console.log("varyant    gürültü tabanı  konuşma  fark(dB)");
for (const r of rows) console.log(`${r.name.padEnd(10)} ${r.noiseFloorDb.toFixed(1).padStart(8)} dB  ${r.speechDb.toFixed(1).padStart(7)} dB  ${(r.speechDb - r.noiseFloorDb).toFixed(1).padStart(6)}`);
console.log(`Dinleme örnekleri: ${dir}`);
