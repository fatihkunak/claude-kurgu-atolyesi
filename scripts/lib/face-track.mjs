// Presenter tracking for the portrait Short: samples the source at a few frames per second, finds the face
// (scripts/lib/face-detect.py, OpenCV Haar cascades in a separate venv) and returns smoothed crop keyframes.
//   const track = await trackFaces({ source, from, to });   // [{ t, cx }] (t = source seconds, cx = face centre, 0..1) or null
// null = no detector installed or no face found: callers fall back to the letterboxed layout.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SAMPLE_FPS = 4;
// KURGU_PY overrides; default is the isolated venv next to the other tools (system Python is left alone)
const python = () => [process.env.KURGU_PY, path.join(os.homedir(), "_tools/kurgu-venv/Scripts/python.exe"), path.join(os.homedir(), "_tools/kurgu-venv/bin/python")].find((f) => f && existsSync(f));

export const smooth = (samples) => {
  const found = samples.filter((s) => s.cx != null);
  if (!found.length) return null;
  // fill gaps with the nearest detection, then average over a 5-sample window and ignore drifts under 2 % of the frame
  const filled = samples.map((s, i) => {
    if (s.cx != null) return s.cx;
    let best = found[0], d = Infinity;
    for (const f of found) { const dd = Math.abs(f.t - s.t); if (dd < d) { d = dd; best = f; } }
    return best.cx;
  });
  const avg = filled.map((_, i) => { const w = filled.slice(Math.max(0, i - 2), i + 3); return w.reduce((a, b) => a + b, 0) / w.length; });
  const out = [];
  let hold = avg[0];
  samples.forEach((s, i) => { if (i === 0 || Math.abs(avg[i] - hold) > 0.02) hold = avg[i]; out.push({ t: s.t, cx: +hold.toFixed(4) }); });
  return out;
};

export const trackFaces = async ({ source, from, to }) => {
  const py = python();
  if (!py) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), "kurgu-face-"));
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(from), "-t", String(to - from), "-i", source, "-vf", `fps=${SAMPLE_FPS},scale=640:-2`, "-q:v", "3", "-start_number", "0", path.join(dir, "f%05d.jpg")], { stdio: "pipe" });
    if (!readdirSync(dir).length) return null;
    const raw = JSON.parse(execFileSync(py, [path.join(import.meta.dirname, "face-detect.py"), dir, String(SAMPLE_FPS)], { encoding: "utf8", maxBuffer: 2 ** 26 }));
    const track = smooth(raw.map((s) => ({ t: +(from + s.t).toFixed(3), cx: s.cx })));
    return track && track.length ? track : null;
  } catch (e) {
    console.error(`yüz izleme çalışmadı (${e.message.split("\n")[0]}), kırpma ortada kalacak`);
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ffmpeg crop `x` expression: piecewise-linear follow of the keyframes, in segment time (t = 0 at `from`).
// cw/iw = crop width / frame width; the crop centre is clamped so the window never leaves the picture.
export const cropXExpr = (track, from, cwFrac, iwExpr = "iw") => {
  const half = cwFrac / 2;
  const xs = track.map((k) => ({ t: +(k.t - from).toFixed(3), x: Math.min(1 - cwFrac, Math.max(0, k.cx - half)) }));
  // collapse runs where x does not change
  const pts = xs.filter((p, i) => i === 0 || i === xs.length - 1 || p.x !== xs[i - 1].x || p.x !== xs[i + 1].x);
  if (pts.length < 2) return `${(pts[0]?.x ?? (1 - cwFrac) / 2).toFixed(4)}*${iwExpr}`;
  let expr = `${pts.at(-1).x.toFixed(4)}`;
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1], span = Math.max(0.001, b.t - a.t);
    expr = `if(lt(t,${b.t}),${a.x.toFixed(4)}+(${(b.x - a.x).toFixed(4)})*(t-${a.t})/${span.toFixed(3)},${expr})`;
  }
  return `(${expr})*${iwExpr}`;
};
