// The panel's "Render'ı başlat": render → composite → qc → audio → qc:mix as ONE detached job that
// survives the panel. The previous delivery is moved to out/onceki-<stamp>/ first, never overwritten.
//   node scripts/run-delivery-detached.mjs          (starts the job and returns immediately)
//   node scripts/run-delivery-detached.mjs --resume   (only after a failed qc / audio / qc:mix: reruns from that step,
//                                                      keeps the finished render and the previous delivery archive)
// State: work/job.json; progress: work/logs/job.log (plus the logs of each step).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const p = (...parts) => path.join(ROOT, ...parts);
const LOGS = p("work/logs");
const JOB = p("work/job.json");
const JOB_LOG = p("work/logs/job.log");
const RESUME = process.argv.includes("--resume");
const ORDER = ["qc", "audio", "qcmix"];
mkdirSync(LOGS, { recursive: true });

if (!process.argv.includes("--child")) {
  if (RESUME) {
    let prev = null;
    try { prev = JSON.parse(readFileSync(JOB, "utf8")); } catch { /* kayıt yok */ }
    if (!(prev?.state === "failed" && ORDER.includes(prev.step))) { console.error("Devam edilemez: son iş qc / audio / qc:mix adımında düşmüş olmalı."); process.exit(2); }
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", ...(RESUME ? ["--resume"] : [])], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  console.log(`İş başladı (pid ${child.pid}). İzle: ${JOB_LOG}`);
  process.exit(0);
}

const startedAt = Date.now();
const setJob = (patch) => writeFileSync(JOB, JSON.stringify({ state: "running", pid: process.pid, startedAt, ...patch }, null, 2));
const say = (m) => appendFileSync(JOB_LOG, `${m}\n`);
const fail = (step, error) => { say(`HATA: ${error}`); setJob({ state: "failed", step, error, finishedAt: Date.now() }); process.exit(1); };
const PREV = RESUME ? (() => { try { return JSON.parse(readFileSync(JOB, "utf8")); } catch { return null; } })() : null;
if (RESUME && !(PREV?.state === "failed" && ORDER.includes(PREV.step))) { console.error("Devam edilemez: son iş qc / audio / qc:mix adımında düşmüş olmalı."); process.exit(2); }
if (RESUME) say(`
[devam] ${PREV.step} adımından yeniden başlıyor (render ve önceki teslim arşivi korunur)`); else writeFileSync(JOB_LOG, "");

// 1. keep the previous delivery and the plan it was made from
const delivered = ["final-hlg.mov", "final-hlg.temiz-ses.mov", "stems", "README.tr.md"].filter((n) => existsSync(p("out", n)));
if (!RESUME && delivered.length) {
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const dir = p("out", `onceki-${stamp}`);
  mkdirSync(dir, { recursive: true });
  for (const n of delivered) renameSync(p("out", n), path.join(dir, n));
  copyFileSync(p("work/edit-plan.json"), path.join(dir, "edit-plan.json"));
  say(`önceki teslim → out/onceki-${stamp}/`);
}

// 2. progress.md: the render steps start over; 11 and 12 (eyes on the master, delivery message) stay open at the end
const PROGRESS = p("work/progress.md");
const setProgress = (ticked, status) => {
  if (!existsSync(PROGRESS)) return;
  const text = readFileSync(PROGRESS, "utf8").replace(/^- \[[ x]\] (\d+) /gm, (m, n) => (Number(n) >= 8 ? `- [${ticked.includes(Number(n)) ? "x" : " "}] ${n} ` : m));
  writeFileSync(PROGRESS, text.replace(/## Durum[\s\S]*$/, `## Durum\n${status}\n`));
};
if (!RESUME) setProgress([], "Render çalışıyor (work/job.json).");

// 3. graphics + composite. A chain that dies before the composite is retried once: finished segments are cached.
const chainLog = p("work/logs/chain.log");
const runChain = () => {
  const offset = existsSync(chainLog) ? statSync(chainLog).size : 0;
  const { status } = spawnSync(process.execPath, [p("scripts/run-master-detached.mjs"), "--child"], { cwd: ROOT, stdio: "ignore", windowsHide: true });
  const text = readFileSync(chainLog).subarray(offset).toString();
  return { ok: status === 0 && /composite cikis kodu 0 /.test(text), text };
};
if (!RESUME) {
setJob({ step: "master" });
say("$ npm run master:detached");
let chain = runChain();
if (!chain.ok && !/composite cikis kodu/.test(chain.text)) {
  say("grafik render düştü, bir kez daha deneniyor");
  chain = runChain();
}
if (!chain.ok) fail("master", `render zinciri başarısız: ${chain.text.trim().split("\n").at(-2) ?? "kayıt yok"} (work/logs/chain.log)`);
}

// 4. qc → audio → qc:mix; each promotes to out/ only if it passes
for (const [step, label] of [["qc", "npm run qc"], ["audio", "npm run audio"], ["qcmix", "npm run qc:mix"]].slice(RESUME ? ORDER.indexOf(PREV.step) : 0)) {
  setJob({ step });
  say(`$ ${label}`);
  const log = p("work/logs", `${step}.log`);
  const fd = openSync(log, "w");
  const { status } = spawnSync(label, { cwd: ROOT, shell: true, stdio: ["ignore", fd, fd], windowsHide: true });
  if (status !== 0) fail(step, `${label} başarısız, çıkış ${status} (work/logs/${step}.log)`);
  if (/ATLANDI/.test(readFileSync(log, "utf8"))) say(`uyarı: ${label} grafiksiz pencere bulamadı, resim karşılaştırması ölçülmedi`);
}

setProgress([8, 9, 10], "Render ve QC bitti. Görsel denetim (11) ve teslim mesajı (12) bekliyor.");
say("bitti → out/final-hlg.mov");
// machine speed for the panel's time estimate: frames of the source / wall time of the whole chain (not after a partial resume)
if (!RESUME) {
  try {
    const frames = JSON.parse(readFileSync(p("work/edit-plan.json"), "utf8")).source.frames, secs = (Date.now() - startedAt) / 1000;
    const dir = process.env.KURGU_DATA ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local/share"), "KurguAtolyesi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "rates.json"), JSON.stringify({ framesPerSecond: +(frames / secs).toFixed(3), frames, seconds: Math.round(secs), at: new Date().toISOString() }));
  } catch { /* estimate only */ }
}
setJob({ state: "done", step: "done", finishedAt: Date.now() });
