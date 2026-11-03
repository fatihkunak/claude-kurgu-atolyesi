"""Face detection for privacy blur proposals (OpenCV YuNet). Proposals only: nothing is applied until reviewed.
Usage: python detect-faces.py <video> <out.json> [--fps 4] [--start S] [--dur D] [--model path] [--score 0.6]
Frames are piped from ffmpeg (scaled to 2560x1440); boxes are written in SOURCE pixels (3840x2160)."""
import argparse, json, subprocess, sys, os
import numpy as np, cv2

ap = argparse.ArgumentParser()
ap.add_argument("video"); ap.add_argument("out")
ap.add_argument("--fps", type=float, default=4); ap.add_argument("--start", type=float, default=0); ap.add_argument("--dur", type=float, default=0)
ap.add_argument("--model", default=os.path.join(os.path.expanduser("~"), "Models", "privacy", "yunet.onnx"))
ap.add_argument("--score", type=float, default=0.6)
a = ap.parse_args()
W, H, SRC_W = 2560, 1440, 3840
scale = SRC_W / W
cmd = ["ffmpeg", "-v", "error"]
if a.start: cmd += ["-ss", str(a.start)]
if a.dur: cmd += ["-t", str(a.dur)]
cmd += ["-i", a.video, "-an", "-vf", f"fps={a.fps},scale={W}:{H},format=bgr24", "-f", "rawvideo", "-"]
det = cv2.FaceDetectorYN.create(a.model, "", (W, H), a.score, 0.3, 5000)
p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
size = W * H * 3
frames, i = [], 0
while True:
    buf = p.stdout.read(size)
    if len(buf) < size: break
    img = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
    _, faces = det.detect(img)
    t = a.start + i / a.fps
    boxes = []
    if faces is not None:
        for f in faces:
            x, y, w, h = f[:4] * scale
            boxes.append([round(float(x)), round(float(y)), round(float(w)), round(float(h)), round(float(f[14]), 3)])
    frames.append({"t": round(t, 3), "boxes": boxes})
    i += 1
    if i % 100 == 0: print(f"{i} kare, t={t:.0f}s", file=sys.stderr, flush=True)
p.wait()
json.dump({"video": a.video, "fps": a.fps, "frames": frames}, open(a.out, "w"))
n = sum(len(f["boxes"]) for f in frames)
print(f"{len(frames)} kare, {n} yüz algısı -> {a.out}")
