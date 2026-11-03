"""Builds the privacy mask video (white = blur) from per-frame face detections and manual boxes (plates, signs).
Detections are used directly (no tracking): with a panning camera a face moves hundreds of px between samples, so
tracks do not link; instead every detection covers the frames within half a sample step around it.
Usage: python make-privacy-mask.py <faces.raw.json> <out.mkv> [--approved approved.json] [--manual manual.json] [--frames N] [--fps 30000/1001]
approved.json: {"minSizePx": 40, "minScore": 0.6, "exclude": [{"start": 60, "end": 70, "x": 100, "y": 100, "w": 400, "h": 400}]}
               minSizePx: smaller faces are not identifiable. exclude: source-pixel regions NOT to blur (statues, murals, masks).
manual.json:   [{"start": 12.0, "end": 15.5, "x": 1200, "y": 800, "w": 300, "h": 100, "shape": "box"}]  (source pixels)
The mask is 960x540 8-bit gray (FFV1); scripts/70-composite.mjs scales it up and feathers it."""
import argparse, json, os, subprocess, sys
import numpy as np, cv2
ap = argparse.ArgumentParser(); ap.add_argument("tracks"); ap.add_argument("out")
ap.add_argument("--approved"); ap.add_argument("--manual"); ap.add_argument("--frames", type=int, default=10354); ap.add_argument("--fps", default="30000/1001")
a = ap.parse_args()
num, den = (int(x) for x in a.fps.split("/")) if "/" in a.fps else (int(a.fps), 1)
d = json.load(open(a.tracks)); pad = 0.35; step = 1 / d["fps"]
cfg = json.load(open(a.approved)) if a.approved and os.path.exists(a.approved) else {}
min_px, min_score, excl = cfg.get("minSizePx", 40), cfg.get("minScore", 0.6), cfg.get("exclude", [])
def excluded(t, x, y, w, h):
    cx, cy = x + w / 2, y + h / 2
    return any(e["start"] <= t <= e["end"] and e["x"] <= cx <= e["x"] + e["w"] and e["y"] <= cy <= e["y"] + e["h"] for e in excl)
dets = {}  # frame index -> boxes
n_det = 0
for fr in d["frames"]:
    for b in fr["boxes"]:
        if b[3] < min_px or b[4] < min_score or excluded(fr["t"], *b[:4]): continue
        n_det += 1
        for i in range(int(np.floor((fr["t"] - step / 2) * 30000 / 1001 + 0.5)), int(np.ceil((fr["t"] + step / 2) * 30000 / 1001 - 0.5)) + 1):
            dets.setdefault(i, []).append(b)
manual = json.load(open(a.manual)) if a.manual and os.path.exists(a.manual) else []
S = 0.25  # 3840 -> 960
W, H = 960, 540
enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", f"{num}/{den}", "-i", "-", "-c:v", "ffv1", "-level", "3", a.out], stdin=subprocess.PIPE)
for i in range(a.frames):
    t = i * den / num
    m = np.zeros((H, W), np.uint8)
    for x, y, w, h, _ in dets.get(i, []):
        cx, cy = (x + w / 2) * S, (y + h / 2) * S
        cv2.ellipse(m, (int(cx), int(cy)), (max(2, int(w * S * (0.5 + pad))), max(2, int(h * S * (0.5 + pad * 1.2)))), 0, 0, 360, 255, -1)
    for r in manual:
        if r["start"] <= t <= r["end"]:
            x, y, w, h = (r[k] * S for k in ("x", "y", "w", "h"))
            if r.get("shape") == "ellipse": cv2.ellipse(m, (int(x + w / 2), int(y + h / 2)), (int(w / 2), int(h / 2)), 0, 0, 360, 255, -1)
            else: cv2.rectangle(m, (int(x), int(y)), (int(x + w), int(y + h)), 255, -1)
    enc.stdin.write(m.tobytes())
enc.stdin.close(); enc.wait()
print(f"{n_det} yüz algısı maskelendi, {len(manual)} elle kutu, {a.frames} kare → {a.out} ({os.path.getsize(a.out)/1e6:.1f} MB)")
