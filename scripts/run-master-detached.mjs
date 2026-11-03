// Cross-platform twin of run-master-detached.sh: graphics render → manifest check → x265 composite,
// as ONE detached job that survives the session.
//   node scripts/run-master-detached.mjs          (starts the job and returns immediately)
// Progress: work/logs/render-gfx.log, work/logs/composite.log; end marker in work/logs/chain.log.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = path.join(ROOT, "work/logs");
const CHAIN = path.join(LOGS, "chain.log");
mkdirSync(LOGS, { recursive: true });

if (!process.argv.includes("--child")) {
  const fd = openSync(CHAIN, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
  console.log(`Zincir başladı (pid ${child.pid}). İzle: ${CHAIN}`);
  process.exit(0);
}

const now = () => new Date().toTimeString().slice(0, 8);
const say = (m) => appendFileSync(CHAIN, `[chain] ${m}\n`);
// run one script with its output appended to a log file; returns the exit code
const step = (script, log, first) => {
  const fd = openSync(path.join(LOGS, log), first ? "w" : "a");
  const { status, signal, error } = spawnSync(process.execPath, [path.join(ROOT, "scripts", script)], { cwd: ROOT, stdio: ["ignore", fd, fd] });
  if (status !== 0) say(`${script} cikis=${status} sinyal=${signal} ${error?.message ?? ""} ${now()}`);
  return status;
};

say(`render basliyor ${now()}`);
if (step("50-validate-plan.mjs", "render-gfx.log", true) !== 0 || step("60-render-segments.mjs", "render-gfx.log", false) !== 0) {
  say("BITTI (hata)");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(path.join(ROOT, "work/segments/manifest.json"), "utf8"));
if (!manifest.complete) {
  say("MANIFEST EKSIK");
  say("BITTI (hata)");
  process.exit(1);
}
say(`manifest tam: ${manifest.segments.length} segment`);
say(`composite basliyor ${now()}`);
say(`composite cikis kodu ${step("70-composite.mjs", "composite.log", true)} ${now()}`);
say("BITTI");
