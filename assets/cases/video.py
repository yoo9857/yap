"""The video that fills the top of /cases/, from a school's own clip.

    python assets/cases/video.py "<folder with the originals>" [check-dir]

→ apps/client/public/cases/school-1/lesson.{mp4,webm} + lesson-poster.webp (960x540, no sound).

The owner's call (2026-11-16): the clip runs sharp and to its end — children seen from the side or
from behind are fine to show. Two things are still kept out, because that reason does not cover
them:
  * CUT (2.6–6.4 s): one child turns and faces the camera.
  * NAMES: only the class roster on a monitor the camera is close to (the class's and the
    teacher's name, every child's name, readable there) is blurred — a small box, nothing else.
    The owner asked for as little as possible (2026-11-16: a first version that also blurred the
    projector, the monitors beside it, name labels and everything pale "covered the game's own
    UI"). The boxes are TRACKS below, read off half-second contact sheets (in the source's
    1920x1080); between two keyframes the blur covers both boxes and what lies between (their
    hull): the camera is hand-held and jumps, and a box moved evenly between keyframes lagged
    behind it. After any change, look at the check sheets again.
The sound is dropped (children's voices). The original is never copied into the repository.
"""
import os, subprocess, sys
import cv2
import numpy as np

SRC = os.path.join(sys.argv[1], "KakaoTalk_20261112_153404355.mp4")
OUT = os.path.join(os.path.dirname(__file__), "../../apps/client/public/cases/school-1")
W, H = 960, 540
CUTS = [(2.6, 6.4)]          # seconds of the source left out
PAD = 8                      # px (source) added round every box
TRACKS = {
    # the roster on the monitor the camera is close to (the only place where names can be read)
    "roster": {10.0: (1073, 375, 1147, 510), 10.5: (1120, 355, 1210, 495), 11.0: (1132, 429, 1243, 599), 11.5: (933, 599, 1097, 748), 12.0: (611, 459, 781, 638), 12.5: (429, 295, 599, 459),
               13.0: (429, 319, 602, 504), 13.5: (426, 57, 605, 310), 14.0: (417, 24, 611, 224), 14.5: (420, 45, 614, 253), 15.0: (423, 83, 617, 283), 15.5: (307, 283, 536, 536), 16.0: (283, 256, 536, 486),
               16.5: (286, 128, 554, 381), 17.0: (274, 30, 542, 307), 17.5: (277, 30, 530, 307), 18.0: (185, 0, 507, 197), 18.5: (60, 0, 520, 110), 19.0: (0, 0, 400, 60)},
    "roster2": {20.0: (640, 480, 800, 720), 20.5: (673, 504, 778, 697), 21.0: (512, 662, 611, 781), 21.5: (405, 730, 560, 894), 22.0: (429, 662, 593, 799), 22.5: (500, 298, 635, 477), 23.0: (530, 69, 700, 238), 23.5: (530, 0, 727, 143), 24.0: (468, 0, 691, 39), 24.5: (468, 0, 691, 20)},
    "roster3": {25.5: (0, 0, 120, 200), 26.0: (6, 12, 170, 316), 26.5: (0, 92, 158, 480), 27.0: (0, 54, 155, 516), 27.5: (0, 54, 182, 516), 28.3: (0, 54, 182, 516)},
}

def box_at(track, t):
    """The hull of the two keyframes' boxes round time t (see the note at the top)."""
    times = sorted(track)
    if t < times[0] or t > times[-1]: return None
    for a, b in zip(times, times[1:]):
        if a <= t <= b:
            p, q = track[a], track[b]
            return (min(p[0], q[0]), min(p[1], q[1]), max(p[2], q[2]), max(p[3], q[3]))
    return track[times[-1]]

cap = cv2.VideoCapture(SRC)
fps = cap.get(cv2.CAP_PROP_FPS) or 30
sx, sy = W / cap.get(cv2.CAP_PROP_FRAME_WIDTH), H / cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
os.makedirs(OUT, exist_ok=True)
mp4 = os.path.join(OUT, "lesson.mp4")
enc = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", f"{fps}", "-i", "-",
                        "-vf", "eq=saturation=1.08:contrast=1.03", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "25", "-preset", "slow", "-movflags", "+faststart", mp4], stdin=subprocess.PIPE)
check, n, kept = [], 0, 0
while True:
    ok, frame = cap.read()
    if not ok: break
    t = n / fps; n += 1
    if any(a <= t < b for a, b in CUTS): continue
    frame = cv2.resize(frame, (W, H), interpolation=cv2.INTER_AREA)
    mask = np.zeros((H, W), np.float32)
    for track in TRACKS.values():
        b = box_at(track, t)
        if b is None: continue
        x0, y0, x1, y1 = int((b[0] - PAD) * sx), int((b[1] - PAD) * sy), int((b[2] + PAD) * sx), int((b[3] + PAD) * sy)
        mask[max(0, y0):max(0, min(H, y1)), max(0, x0):max(0, min(W, x1))] = 1
    if mask.any():
        soft = cv2.GaussianBlur(frame, (0, 0), 11)
        m = cv2.GaussianBlur(mask, (0, 0), 5)[..., None]
        m = np.clip(m * 1.6, 0, 1)   # full strength well inside the box, a soft edge
        frame = (soft * m + frame * (1 - m)).astype(np.uint8)
    enc.stdin.write(frame.tobytes()); kept += 1
    if len(sys.argv) > 2 and kept % 15 == 1: check.append((t, frame.copy()))
enc.stdin.close(); enc.wait(); cap.release()
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", mp4, "-an", "-c:v", "libvpx-vp9", "-crf", "38", "-b:v", "0", "-row-mt", "1", os.path.join(OUT, "lesson.webm")], check=True)
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", "5.5", "-i", mp4, "-frames:v", "1", "-c:v", "libwebp", "-q:v", "72", os.path.join(OUT, "lesson-poster.webp")], check=True)
print(f"{kept / fps:.1f} s kept of {n / fps:.1f} s;", ", ".join(f"{f} {os.path.getsize(os.path.join(OUT, f)) // 1024} KB" for f in ("lesson.mp4", "lesson.webm", "lesson-poster.webp")))
if len(sys.argv) > 2:   # the finished video every half second, twelve frames a sheet, at full size
    os.makedirs(sys.argv[2], exist_ok=True)
    for i in range(0, len(check), 12):
        tiles = [cv2.putText(f.copy(), f"{t:.1f}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 255), 2) for t, f in check[i:i + 12]]
        while len(tiles) < 12: tiles.append(np.zeros((H, W, 3), np.uint8))
        sheet = np.vstack([np.hstack(tiles[r * 4:r * 4 + 4]) for r in range(3)])
        open(os.path.join(sys.argv[2], f"video-{i // 12}.jpg"), "wb").write(cv2.imencode(".jpg", sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes())   # (imwrite cannot write to a non-ASCII path)
