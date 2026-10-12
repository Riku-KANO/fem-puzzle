"""Crack decal (crack_decal.png): dark branching cracks on transparent, centred.

Generated procedurally with numpy (fixed seed) and written with our own PNG encoder, so
the file is byte-for-byte reproducible. Straight (non-premultiplied) alpha, sRGB colour.
Cracks radiate from the centre and stay inside a circle of 0.47 x size, so the decal can
be projected centred on an over-stressed voxel face (DecalGeometry) or a textured quad.
"""

from __future__ import annotations

import math
import os
import random

import numpy as np

from assetkit import png

SIZE = 512
SEED = 3077
CORE_RGB = (24, 20, 19)  # sRGB of the crack interior


def _walk(rng: random.Random, x: float, y: float, ang: float, length: float, width: float, depth: int,
          segs: list[tuple[float, float, float, float, float]]) -> None:
    """Random-walk crack from (x, y); appends (x0, y0, x1, y1, radius) segments.
    Mostly straight runs with occasional sharp kinks read as brittle fracture."""
    step = 7.0
    n = max(2, int(length / step))
    lim = SIZE * 0.47
    cx = cy = SIZE / 2
    for i in range(n):
        t = i / n
        ang += rng.gauss(0.0, 0.12)
        if rng.random() < 0.18:
            ang += rng.choice((-1.0, 1.0)) * rng.uniform(0.3, 0.6)
        nx, ny = x + math.cos(ang) * step, y + math.sin(ang) * step
        if math.hypot(nx - cx, ny - cy) > lim:
            break
        r = max(0.6, width * (1.0 - 0.8 * t))
        segs.append((x, y, nx, ny, r))
        if depth < 2 and i > 2 and rng.random() < 0.06:
            side = 1.0 if rng.random() < 0.5 else -1.0
            _walk(rng, nx, ny, ang + side * rng.uniform(0.5, 1.0), (n - i) * step * rng.uniform(0.3, 0.55),
                  r * 0.7, depth + 1, segs)
        x, y = nx, ny


def _raster(segs, halo: float) -> tuple[np.ndarray, np.ndarray]:
    core = np.zeros((SIZE, SIZE), dtype=np.float64)
    soft = np.zeros((SIZE, SIZE), dtype=np.float64)
    for x0, y0, x1, y1, r in segs:
        pad = r + halo + 2
        xa, xb = int(max(0, min(x0, x1) - pad)), int(min(SIZE, max(x0, x1) + pad + 1))
        ya, yb = int(max(0, min(y0, y1) - pad)), int(min(SIZE, max(y0, y1) + pad + 1))
        if xa >= xb or ya >= yb:
            continue
        px, py = np.meshgrid(np.arange(xa, xb) + 0.5, np.arange(ya, yb) + 0.5)
        dx, dy = x1 - x0, y1 - y0
        ll = dx * dx + dy * dy
        t = np.clip(((px - x0) * dx + (py - y0) * dy) / ll, 0.0, 1.0) if ll > 0 else 0.0
        d = np.sqrt((px - (x0 + t * dx)) ** 2 + (py - (y0 + t * dy)) ** 2)
        core[ya:yb, xa:xb] = np.maximum(core[ya:yb, xa:xb], np.clip(r + 0.5 - d, 0.0, 1.0))
        soft[ya:yb, xa:xb] = np.maximum(soft[ya:yb, xa:xb], np.clip(1.0 - (d - r) / halo, 0.0, 1.0) ** 2)
    return core, soft


def image() -> np.ndarray:
    rng = random.Random(SEED)
    segs: list[tuple[float, float, float, float, float]] = []
    arms = 6
    for k in range(arms):
        ang = 2 * math.pi * k / arms + rng.uniform(-0.35, 0.35)
        _walk(rng, SIZE / 2, SIZE / 2, ang, rng.uniform(150, 235), rng.uniform(4.5, 6.0), 0, segs)
    # a chipped spall at the centre
    spall = []
    for k in range(9):
        a = 2 * math.pi * k / 9
        rr = rng.uniform(9.0, 16.0)
        spall.append((SIZE / 2 + rr * math.cos(a), SIZE / 2 + rr * math.sin(a)))
    for (xa, ya), (xb, yb) in zip(spall, spall[1:] + spall[:1]):
        segs.append((xa, ya, xb, yb, 3.0))
        segs.append((SIZE / 2, SIZE / 2, (xa + xb) / 2, (ya + yb) / 2, 6.0))
    core, soft = _raster(segs, halo=5.0)
    alpha = np.maximum(core, 0.35 * soft)
    rgba = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = CORE_RGB
    rgba[..., 3] = np.round(alpha * 255.0).astype(np.uint8)
    rgba[rgba[..., 3] == 0, :3] = 0
    return rgba


def build(out_dir: str) -> dict[str, dict]:
    rgba = image()
    path = os.path.join(out_dir, "crack_decal.png")
    size = png.write_rgba(path, SIZE, SIZE, rgba.tobytes())
    return {
        "crack_decal.png": {
            "bytes": size,
            "size": [SIZE, SIZE],
            "use": "dark cracks, straight alpha, centred; project onto over-stressed faces",
        }
    }
