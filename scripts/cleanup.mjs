// Disk space report and (only when asked) cleanup of REGENERABLE files. C: fills up fast: a 4K render is gigabytes of ProRes.
//   node scripts/cleanup.mjs                   → lists what could go and how much it frees. Deletes nothing.
//   node scripts/cleanup.mjs --apply segments  → deletes those categories (segments, composite, proxy, derived, qc, audio-build)
//   --archived                                  → only projects/* (the current project keeps its cache: a revision re-renders only what changed)
//   restore-preview                              → ONLY out/restore/*.onizleme.* (the 8 s restore previews; real restore outputs are never touched)
// Never touched: out/ (except restore-preview above), public/main.mov, public/assets/, work/edit-plan.json, transcripts, anything else.
// Everything below can be rebuilt from main.mov + the plan (proxy/derived/segments/composite re-render when needed).
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { p } from "./lib/paths.mjs";

const CATEGORIES = {
  segments: ["work/segments"],
  composite: ["work/composite"],
  proxy: ["public/proxy"],
  derived: ["public/derived"],
  qc: ["work/qc/stills"],
  "audio-build": ["work/audio/build", "work/audio/preview"],
  "restore-preview": (base) => {
    const d = path.join(base, "out/restore");
    return existsSync(d) ? readdirSync(d).filter((n) => /\.onizleme\./.test(n)).map((n) => path.join(d, n)) : [];
  },
};
/** Kategori ya göreli yol listesi ya da (base) → mutlak yol listesi veren fonksiyondur. */
const resolvePaths = (paths, base) => (typeof paths === "function" ? paths(base) : paths.map((x) => path.join(base, x))).filter(existsSync);
const sizeOf = (f) => {
  if (!existsSync(f)) return 0;
  const s = statSync(f);
  return s.isFile() ? s.size : readdirSync(f).reduce((n, name) => n + sizeOf(path.join(f, name)), 0);
};
const mb = (n) => `${(n / 2 ** 20).toFixed(0)} MB`;

const archived = process.argv.includes("--archived");
const roots = archived ? [] : [{ label: "şu anki proje", base: p() }];
if (existsSync(p("projects"))) for (const d of readdirSync(p("projects"))) roots.push({ label: `projects/${d}`, base: p("projects", d) });

const apply = process.argv.includes("--apply") ? process.argv.slice(process.argv.indexOf("--apply") + 1).filter((a) => !a.startsWith("--")) : null;
if (apply) for (const c of apply) if (!CATEGORIES[c]) { console.error(`Bilinmeyen kategori: ${c}. Seçenekler: ${Object.keys(CATEGORIES).join(", ")}`); process.exit(2); }

let total = 0, freed = 0; // total: silinmedi (hâlâ geri kazanılabilir), freed: bu çalıştırmada gerçekten silinen
for (const { label, base } of roots) {
  const rows = Object.entries(CATEGORIES).map(([name, paths]) => [name, resolvePaths(paths, base)]).map(([name, paths]) => [name, paths, paths.reduce((n, f) => n + sizeOf(f), 0)]).filter(([, , n]) => n > 0);
  if (!rows.length) continue;
  console.log(`\n${label}`);
  for (const [name, paths, n] of rows) {
    const doIt = apply?.includes(name);
    console.log(`  ${doIt ? "SİLİNİYOR" : "         "}  ${name.padEnd(12)} ${mb(n).padStart(9)}   ${paths.map((x) => path.relative(base, x)).join(", ")}`);
    if (doIt) { for (const f of paths) rmSync(f, { recursive: true, force: true }); freed += n; } else total += n;
  }
}
console.log(apply ? `\nAçılan alan: ${mb(freed)}${total ? ` (silinmeyen, hâlâ geri kazanılabilir: ${mb(total)})` : ""}` : `\nToplam geri kazanılabilir: ${mb(total)}. Silmek için: node scripts/cleanup.mjs --apply <kategori…> (ör. segments composite)`);
