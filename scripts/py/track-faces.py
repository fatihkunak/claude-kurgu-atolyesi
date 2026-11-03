"""Links per-frame face boxes into tracks and writes work/privacy/proposals.json + a contact sheet to review.
Nothing is blurred by this script. Usage: python track-faces.py <faces.raw.json> <video> <outdir> [--min-hits 3] [--min-size 40]  (sheet shows tracks >= min-size px)"""
import argparse, json, subprocess, os
import numpy as np, cv2
ap = argparse.ArgumentParser(); ap.add_argument("raw"); ap.add_argument("video"); ap.add_argument("outdir")
ap.add_argument("--min-hits", type=int, default=3); ap.add_argument("--min-size", type=int, default=40); ap.add_argument("--pad", type=float, default=0.35)
a = ap.parse_args()
d = json.load(open(a.raw)); fps = d["fps"]; step = 1 / fps
tracks = []   # each: {"hits": [(t,x,y,w,h,score)], "last_t": t}
for fr in d["frames"]:
    t = fr["t"]
    used = set()
    for b in sorted(fr["boxes"], key=lambda b: -b[4]):
        cx, cy, w = b[0] + b[2] / 2, b[1] + b[3] / 2, b[2]
        best, bd = None, 1e9
        for i, tr in enumerate(tracks):
            if i in used or t - tr["last_t"] > 3 * step + 1e-6: continue
            x, y, ww, hh, _ = tr["hits"][-1][1:]
            dist = np.hypot(cx - (x + ww / 2), cy - (y + hh / 2))
            if dist < max(ww, w) * 1.2 and dist < bd: best, bd = i, dist
        if best is None: tracks.append({"hits": [(t, *b)], "last_t": t}); used.add(len(tracks) - 1)
        else: tracks[best]["hits"].append((t, *b)); tracks[best]["last_t"] = t; used.add(best)
keep = [tr for tr in tracks if len(tr["hits"]) >= a.min_hits]
props = []
for n, tr in enumerate(keep, 1):
    h = tr["hits"]
    props.append({"id": f"F{n:03d}", "start": h[0][0], "end": round(h[-1][0] + step, 3), "hits": len(h),
                  "maxScore": max(x[5] for x in h), "maxSizePx": int(max(x[3] for x in h)),
                  "samples": [[x[0], x[1], x[2], x[3], x[4]] for x in h]})
os.makedirs(a.outdir, exist_ok=True)
json.dump({"padding": a.pad, "note": "Öneri: uygulanmaz. Gözden geçirip work/privacy/approved.json'a seçilen id'leri yaz.", "tracks": props}, open(os.path.join(a.outdir, "proposals.json"), "w"))
# contact sheet: a crop of each track at its middle detection, labelled with id + time
tiles = []
for p in [q for q in props if q["maxSizePx"] >= a.min_size]:
    s = p["samples"][len(p["samples"]) // 2]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{s[0]:.3f}", "-i", a.video, "-frames:v", "1", "-vf", "scale=3840:2160,format=bgr24", "-f", "rawvideo", "-"], capture_output=True).stdout
    if len(raw) < 3840 * 2160 * 3: continue
    img = np.frombuffer(raw, np.uint8).reshape(2160, 3840, 3)
    x, y, w, h = s[1:5]; m = max(w, h) * 1.4; cx, cy = x + w / 2, y + h / 2
    x0, y0 = int(max(0, cx - m)), int(max(0, cy - m)); x1, y1 = int(min(3840, cx + m)), int(min(2160, cy + m))
    crop = cv2.resize(img[y0:y1, x0:x1], (160, 160))
    cv2.rectangle(crop, (int((x - x0) / (x1 - x0) * 160), int((y - y0) / (y1 - y0) * 160)), (int((x + w - x0) / (x1 - x0) * 160), int((y + h - y0) / (y1 - y0) * 160)), (0, 255, 255), 1)
    cv2.rectangle(crop, (0, 0), (160, 16), (0, 0, 0), -1)
    cv2.putText(crop, f"{p['id']} {int(s[0] // 60)}:{int(s[0] % 60):02d} {p['maxSizePx']}px", (2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    tiles.append(crop)
cols = 12
for si in range(0, len(tiles), cols * 8):
    chunk = tiles[si: si + cols * 8]
    rows = [np.hstack(chunk[r: r + cols] + [np.zeros((160, 160, 3), np.uint8)] * (cols - len(chunk[r: r + cols]))) for r in range(0, len(chunk), cols)]
    cv2.imwrite(os.path.join(a.outdir, f"faces_sheet_{si // (cols * 8) + 1:02d}.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 82])
sizes = [p["maxSizePx"] for p in props]
print(f"{len(tracks)} ham iz → {len(props)} iz (≥{a.min_hits} algı); yüz boyutu px: ortanca {int(np.median(sizes))}, en küçük {min(sizes)}, en büyük {max(sizes)}")
