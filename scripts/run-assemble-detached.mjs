// Montaj birleştirmesi, panelden bağımsız (oturum kapansa da sürer): work/assemble.json → 08-assemble → project.source → probe.
//   node scripts/run-assemble-detached.mjs --child     (paneldeki "Birleştir" bunu başlatır; durum: work/montage-build.json)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { p, LUT_GFX } from "./lib/paths.mjs";

/** Montaj'ın müzik klibi (work/montage-audio.json) → work/audio/selection.json: music + musicPlace. Klip yoksa yalnız eski musicPlace silinir. */
function mergeMusic() {
  const f = p("work/montage-audio.json");
  if (!existsSync(f)) return;
  const m = JSON.parse(readFileSync(f, "utf8"));
  const sf = p("work/audio/selection.json");
  const base = existsSync(sf) ? sf : p("library/audio/selection.default.json");
  if (!existsSync(base)) { console.log("[montaj] selection.json ve varsayılanı yok: müzik ayarı yazılamadı."); return; }
  const sel = JSON.parse(readFileSync(base, "utf8"));
  if (m.music) { sel.music = m.music.replace(/\\/g, "/"); sel.musicPlace = m.musicPlace; console.log(`[montaj] müzik: ${sel.music} (${m.musicPlace.in}–${m.musicPlace.out} sn → ${m.musicPlace.start}. sn)`); }
  else if (sel.musicPlace) { delete sel.musicPlace; console.log("[montaj] müzik klibi yok: eski musicPlace silindi."); }
  else return;
  mkdirSync(path.dirname(sf), { recursive: true });
  writeFileSync(sf, `${JSON.stringify(sel, null, 2)}\n`);
}

const BUILD = p("work/montage-build.json");
const prev = existsSync(BUILD) ? JSON.parse(readFileSync(BUILD, "utf8")) : {};
const mark = (patch) => writeFileSync(BUILD, `${JSON.stringify({ ...prev, ...patch }, null, 2)}\n`);
const run = (script, args = []) => {
  console.log(`[montaj] ${script} ${args.join(" ")}`.trim());
  return spawnSync(process.execPath, [p("scripts", script), ...args], { cwd: p(), stdio: "inherit", windowsHide: true }).status;
};

if (process.argv.includes("--child")) {
  // SDR parçalar HLG tabana çıkarılırken grafik LUT'unu kullanır; yeni projede henüz üretilmemiş olabilir
  let code = existsSync(LUT_GFX) ? 0 : run("40-make-luts.mjs");
  if (code === 0) code = run("08-assemble.mjs", ["--force"]);
  if (code === 0) {
    const pf = p("work/project.json");
    const project = JSON.parse(readFileSync(pf, "utf8"));
    project.source = "work/composite/base.mov"; // tüm betikler SOURCE'u buradan okur (scripts/lib/paths.mjs)
    writeFileSync(pf, `${JSON.stringify(project, null, 2)}\n`);
    code = run("00-probe.mjs");
    if (code === 0) mergeMusic();
  }
  mark(code === 0 ? { state: "done", finishedAt: new Date().toISOString() } : { state: "failed", finishedAt: new Date().toISOString(), error: "Birleştirme başarısız: work/logs/assemble.log" });
  console.log(code === 0 ? "[montaj] BITTI" : "[montaj] HATA");
  process.exit(code === 0 ? 0 : 1);
}
