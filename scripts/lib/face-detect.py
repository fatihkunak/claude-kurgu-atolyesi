"""Detects the largest face in every frame image of a folder (f00000.jpg, f00001.jpg, ...).

    python face-detect.py <frames-dir> <fps>

Prints a JSON list [{t, cx, cy, w}] (cx/cy/w as fractions of the frame; cx = null when no face was found).
Frontal Haar cascade first, then profile (both directions): the presenter often looks aside while talking.
Needs opencv-python-headless 4.x (the 5.x wheel ships no cascades); scripts/lib/face-track.mjs finds the venv.
"""
import glob
import json
import os
import sys

import cv2

frames_dir, fps = sys.argv[1], float(sys.argv[2])
front = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
profile = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
out = []
for i, path in enumerate(sorted(glob.glob(os.path.join(frames_dir, "f*.jpg")))):
    gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        out.append({"t": i / fps, "cx": None})
        continue
    h, w = gray.shape
    gray = cv2.equalizeHist(gray)
    min_size = (int(w * 0.08), int(w * 0.08))
    best = None
    for cascade, flip in ((front, False), (profile, False), (profile, True)):
        img = cv2.flip(gray, 1) if flip else gray
        for (x, y, ww, hh) in cascade.detectMultiScale(img, scaleFactor=1.1, minNeighbors=5, minSize=min_size):
            cx = (x + ww / 2) / w
            if flip:
                cx = 1 - cx
            if best is None or ww * hh > best[3]:
                best = (cx, (y + hh / 2) / h, ww / w, ww * hh)
    out.append({"t": i / fps, "cx": best[0], "cy": best[1], "w": best[2]} if best else {"t": i / fps, "cx": None})
print(json.dumps(out))
