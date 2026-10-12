"""Debris chips that fall from carved / floating voxels (Rapier bodies in T-310).

`chip_0` .. `chip_3` are convex (use them directly as Rapier convex hulls), 4-12 mm,
origin at the volume centroid. `swarf_0` is a curled shaving for the static pile only.
Base colour is a neutral light grey so per-instance colours (e.g. the voxel's stress
colour at the moment it was carved) multiply cleanly.
"""

from __future__ import annotations

import math
import os
import random

from mathutils import Vector

from assetkit import scene as S
from assetkit.geo import MeshBuilder, hull

from . import palette as P

DENSITY = 2700.0  # kg/m^3, aluminium (stages default to aluminium)


def _centroid_volume(verts, faces) -> tuple[Vector, float]:
    """Volume centroid of a closed mesh (fan-triangulated faces)."""
    vol = 0.0
    c = Vector((0.0, 0.0, 0.0))
    for f in faces:
        a = verts[f[0]]
        for i in range(1, len(f) - 1):
            b, d = verts[f[i]], verts[f[i + 1]]
            v = a.dot(b.cross(d)) / 6.0
            vol += v
            c += (a + b + d) * (v / 4.0)
    return c / vol, vol


def _chip(rng: random.Random, size: tuple[float, float, float], n: int = 12):
    pts = []
    for _ in range(n):
        # points near the corners of the box, pulled in randomly -> chunky, faceted shards
        c = [rng.choice((-1.0, 1.0)) * rng.uniform(0.45, 1.0) * size[i] / 2 for i in range(3)]
        pts.append(tuple(c))
    verts, faces, smooth = hull(pts)
    c, vol = _centroid_volume(verts, faces)
    return [v - c for v in verts], faces, smooth, vol


def _swarf(turns: float = 1.6, segs: int = 22):
    """A curled ribbon (rectangular section), centred on its bounding box."""
    rings = []
    for i in range(segs + 1):
        t = i / segs
        a = 2.0 * math.pi * turns * t
        r = 0.0045 * (1.0 - 0.35 * t)
        centre = Vector((r * math.cos(a), 0.0026 * turns * t, r * math.sin(a)))
        radial = Vector((math.cos(a), 0.0, math.sin(a)))
        up = Vector((0.0, 1.0, 0.0))
        w, th = 0.0016 * (1.0 - 0.4 * t), 0.00035
        rings.append([centre + up * (sy * w / 2) + radial * (sr * th / 2)
                      for sy, sr in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    verts = [p for ring in rings for p in ring]
    faces = []
    for i in range(segs):
        for k in range(4):
            a, b = i * 4 + k, i * 4 + (k + 1) % 4
            faces.append([a, a + 4, b + 4, b])
    faces.append([3, 2, 1, 0])
    last = segs * 4
    faces.append([last, last + 1, last + 2, last + 3])
    lo = Vector((min(v.x for v in verts), min(v.y for v in verts), min(v.z for v in verts)))
    hi = Vector((max(v.x for v in verts), max(v.y for v in verts), max(v.z for v in verts)))
    mid = (lo + hi) / 2
    # closed tube: a negative signed volume means the faces point inwards
    if _centroid_volume(verts, faces)[1] < 0.0:
        faces = [f[::-1] for f in faces]
    return [v - mid for v in verts], faces, [False] * len(faces)


CHIPS = [
    ("chip_0", (0.008, 0.0072, 0.0076), 3101),  # chunky cube fragment
    ("chip_1", (0.009, 0.0042, 0.0075), 3102),  # flat flake
    ("chip_2", (0.011, 0.0045, 0.005), 3103),  # sliver
    ("chip_3", (0.006, 0.0055, 0.0058), 3104),  # small nugget
]


def build(out_dir: str) -> dict[str, dict]:
    S.reset()
    mat = S.mat_pbr("debris", metallic=0.35, roughness=0.45)
    info = {}
    root = S.empty("debris", {})
    for name, size, seed in CHIPS:
        verts, faces, smooth, vol = _chip(random.Random(seed), size)
        b = MeshBuilder()
        b.add((verts, faces, smooth), color=P.CHIP)
        b.to_object(name, [mat], parent=root)
        lo, hi = b.bounds()
        info[name] = {
            "convex": True,
            "volume": float(f"{vol:.4g}"),
            "mass": float(f"{vol * DENSITY:.4g}"),
            "halfExtents": [round((hi[i] - lo[i]) / 2, 5) for i in range(3)],
        }
    b = MeshBuilder()
    b.add(_swarf(), color=P.CHIP)
    b.to_object("swarf_0", [mat], parent=root)
    lo, hi = b.bounds()
    info["swarf_0"] = {"convex": False, "halfExtents": [round((hi[i] - lo[i]) / 2, 5) for i in range(3)]}
    meta = {
        "asset": "debris",
        "frame": "each node is a separate piece at the origin; origin = volume centroid (chips)",
        "density": DENSITY,
        "pieces": info,
    }
    for k, v in meta.items():
        root[k] = v
    path = os.path.join(out_dir, "debris.glb")
    size_b = S.export_glb(path, [root], normals=True)
    return {"debris.glb": {"bytes": size_b, **meta}}
