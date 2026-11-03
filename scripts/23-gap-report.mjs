// Lists speech-free stretches of the reviewed transcript as CUT CANDIDATES. Report only: nothing is cut.
// A talking-head video usually wants these tightened; a walking vlog may want them kept (the footage IS the content),
// so the decision stays with the user. Apply a cut through work/assemble.json (scripts/08-assemble.mjs).
// Usage: node scripts/23-gap-report.mjs [--min 4]   → work/transcript/gap-report.md
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { p } from "./lib/paths.mjs";
import { findGaps } from "./lib/transcript-checks.mjs";

const minGap = (() => { const i = process.argv.indexOf("--min"); return i > 0 ? Number(process.argv[i + 1]) : 4; })();
const file = [p("work/transcript.tr.duzeltilmis.json"), p("work/transcript.tr.json")].find((f) => existsSync(f));
if (!file) { console.error("Düzeltilmiş döküm yok: önce npm run transcribe."); process.exit(1); }
const { segments } = JSON.parse(readFileSync(file, "utf8"));
const meta = JSON.parse(readFileSync(p("work/source-metadata.json"), "utf8"));
const duration = meta.summary.durationSeconds;
const t = (x) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, "0")}`;

const gaps = findGaps(segments, duration, minGap);
const total = gaps.reduce((a, g) => a + (g.to - g.from), 0);
const lines = gaps.map((g) => `- ${t(g.from)}–${t(g.to)} (${(g.to - g.from).toFixed(1)} sn)`);
writeFileSync(p("work/transcript/gap-report.md"),
  `# Konuşmasız kesitler (≥ ${minGap} sn)\n\nKaynak döküm: ${file.replace(/.*work/, "work")}. ${gaps.length} kesit, toplam ${total.toFixed(0)} sn (%${((total / duration) * 100).toFixed(0)} / ${duration.toFixed(0)} sn).\nBunlar kesme ADAYI; görüntü yürüyüşse bunlar içeriktir. Kesilmedi.\n\n${lines.join("\n")}\n`);
console.log(`${gaps.length} kesit, ${total.toFixed(0)} sn (%${((total / duration) * 100).toFixed(0)}) → work/transcript/gap-report.md`);
