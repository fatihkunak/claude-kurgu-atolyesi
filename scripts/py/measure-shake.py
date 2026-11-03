"""Measures camera shake (high-frequency global motion) on short slices, to decide whether stabilization is worth it.
Phase correlation between consecutive frames (960x540 gray); jitter = translation minus its ~1 s moving average.
Usage: python measure-shake.py <video> [--slices 12] [--dur 8]   (values in px at 960 px width; x4 for 3840)"""
import argparse, subprocess, json
import numpy as np, cv2
ap = argparse.ArgumentParser(); ap.add_argument("video"); ap.add_argument("--slices", type=int, default=12); ap.add_argument("--dur", type=float, default=8)
ap.add_argument("--total", type=float, default=345.0); ap.add_argument("--fps", type=float, default=29.97)
a = ap.parse_args()
W, H = 960, 540
res = []
for k in range(a.slices):
    s = 5 + k * (a.total - 5 - a.dur) / max(1, a.slices - 1)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{s:.2f}", "-t", str(a.dur), "-i", a.video, "-an", "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"], capture_output=True).stdout
    n = len(raw) // (W * H)
    fr = np.frombuffer(raw[: n * W * H], np.uint8).reshape(n, H, W).astype(np.float32)
    win = cv2.createHanningWindow((W, H), cv2.CV_32F)
    d = np.array([cv2.phaseCorrelate(fr[i - 1], fr[i], win)[0] for i in range(1, n)])  # per-frame shift (dx, dy)
    pos = np.cumsum(d, axis=0)
    k1 = int(a.fps)
    smooth = np.stack([np.convolve(pos[:, c], np.ones(k1) / k1, mode="same") for c in range(2)], axis=1)
    jit = (pos - smooth)[k1 // 2 : -k1 // 2]
    res.append({"t": round(s, 1), "jitter_rms_px": round(float(np.sqrt((jit ** 2).sum(axis=1).mean())), 2), "speed_px_per_frame": round(float(np.abs(d).mean()), 2)})
print(json.dumps(res, indent=0))
j = [r["jitter_rms_px"] for r in res]
print(f"jitter RMS (960 px genişlikte): ort {np.mean(j):.2f}, en yüksek {max(j):.2f} px → 4K'da yaklaşık x4")
