// Face blur pipeline for privacy (faces of passers-by). Plates and signs have no reliable detector here: list them by hand.
//   node scripts/85-privacy.mjs setup    → isolated venv (OpenCV 5.x + numpy) and the YuNet model (not the system Python)
//   node scripts/85-privacy.mjs detect   → work/privacy/faces.raw.json   (15 samples/s; ~35 min for 6 min of 4K)
//   node scripts/85-privacy.mjs review   → work/privacy/faces_sheet_*.jpg  (look: statues, murals and masks are detected too)
//   node scripts/85-privacy.mjs mask     → work/privacy/mask.mkv           (uses work/privacy/approved.json + manual.json)
// Then set work/project.json "privacy": true and run the composite (npm run composite), or test with `node scripts/70-composite.mjs --draft --until 20 --privacy`.
// work/privacy/approved.json: {"minSizePx": 40, "minScore": 0.6, "exclude": [{"start":60,"end":70,"x":100,"y":100,"w":400,"h":400}]}
// work/privacy/manual.json:   [{"start":12,"end":15.5,"x":1200,"y":800,"w":300,"h":100,"shape":"box"}]   (source pixels, e.g. plates)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { p, SOURCE, sourceTiming } from "./lib/paths.mjs";

const home = os.homedir();
const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "KurguAtolyesi") : path.join(home, ".kurgu-atolyesi");
const venv = path.join(base, "venv-privacy");
const py = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
const MODEL = path.join(home, "Models", "privacy", "yunet.onnx");
const MODEL_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx";
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const cmd = process.argv[2];
const fps = (() => { const i = process.argv.indexOf("--fps"); return i > 0 ? process.argv[i + 1] : "15"; })();
mkdirSync(p("work/privacy"), { recursive: true });

if (cmd === "setup") {
  if (!existsSync(py)) run("python", ["-m", "venv", venv]);
  run(py, ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "opencv-python-headless", "numpy"]);
  if (!existsSync(MODEL)) {
    mkdirSync(path.dirname(MODEL), { recursive: true });
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`Model indirilemedi: ${res.status}`);
    writeFileSync(MODEL, Buffer.from(await res.arrayBuffer()));
  }
  console.log(`Hazır: ${py}\nModel: ${MODEL}`);
} else if (["detect", "review", "mask"].includes(cmd)) {
  if (!existsSync(py) || !existsSync(MODEL)) throw new Error("Önce: node scripts/85-privacy.mjs setup");
  const raw = p("work/privacy/faces.raw.json");
  if (cmd === "detect") run(py, ["scripts/py/detect-faces.py", SOURCE, raw, "--fps", fps, "--model", MODEL]);
  else if (!existsSync(raw)) throw new Error("Önce: node scripts/85-privacy.mjs detect");
  else if (cmd === "review") run(py, ["scripts/py/track-faces.py", raw, SOURCE, p("work/privacy")]);
  else {
    const { frames: n, fpsNum, fpsDen } = sourceTiming();
    run(py, ["scripts/py/make-privacy-mask.py", raw, p("work/privacy/mask.mkv"), "--approved", p("work/privacy/approved.json"), "--manual", p("work/privacy/manual.json"), "--frames", String(n), "--fps", `${fpsNum}/${fpsDen}`]);
  }
} else {
  console.error("Kullanım: node scripts/85-privacy.mjs setup | detect [--fps 15] | review | mask");
  process.exit(1);
}
