// Flags raw whisper segments that are probably hallucinated: no counterpart in the VAD pass,
// runs of identical segments, and known subtitle-credit phrases. Report only: it never edits the transcript.
// Output: work/transcript/hallucination-report.{json,md}. Review them, then record decisions in corrections.tr.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { p } from "./lib/paths.mjs";
import { findHallucinations, seg } from "./lib/transcript-checks.mjs";

const rawPath = p("work/transcript/raw.json"), vadPath = p("work/transcript/vad/raw.json");
if (!existsSync(rawPath) || !existsSync(vadPath)) {
  console.error("raw.json veya vad/raw.json yok: önce `node scripts/20-transcribe.mjs --force` (VAD modeliyle).");
  process.exit(1);
}
const raw = seg(JSON.parse(readFileSync(rawPath, "utf8")));
const vad = seg(JSON.parse(readFileSync(vadPath, "utf8")));
const findings = findHallucinations(raw, vad);

writeFileSync(p("work/transcript/hallucination-report.json"), JSON.stringify({ rawSegments: raw.length, vadSegments: vad.length, flagged: findings.length, findings }, null, 2));
const t = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
writeFileSync(p("work/transcript/hallucination-report.md"),
  `# Olası halüsinasyonlar\n\nHam ${raw.length} segment, VAD ${vad.length} segment, işaretli ${findings.length}. Yalnız rapor: döküm değiştirilmedi.\n\n` +
  findings.map((f) => `- ${t(f.start)}–${t(f.end)} "${f.text}" — ${f.reasons.join("; ")}`).join("\n") + "\n");
console.log(`${findings.length}/${raw.length} segment işaretlendi → work/transcript/hallucination-report.md`);
