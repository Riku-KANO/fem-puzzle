"""128 px toolbar icons, modelled in 3D and rendered (EEVEE, transparent background).

Files: apps/web/public/assets/icons/<name>.png for every name in NAMES. Rendering is GPU
dependent, so `build.sh --check` only verifies that the icons exist and are 128 x 128.
"""

from __future__ import annotations

import math
import os

import bpy
from mathutils import Vector

from assetkit import scene as S
from assetkit.geo import (
    BL_TO_GLTF,
    MeshBuilder,
    bevel_box,
    cylinder,
    flat,
    hexrgb,
    prism_x,
    rotate,
    scale,
    segment,
    torus,
    translate,
)

from . import palette as P

NAMES = ["brush-1", "brush-3", "brush-5", "undo", "redo", "load-test", "submit"]

SLAB = hexrgb("#c3ccd4")
CARVE = hexrgb("#f29a3d")
ARROW = hexrgb("#ece7dd")
CHECK = hexrgb("#57b46f")
VIEW = Vector((1.0, 1.25, 1.55)).normalized()  # camera direction (glTF space)


def _obj(b: MeshBuilder, name: str = "icon") -> None:
    b.to_object(name, [S.mat_pbr(f"{name}_mat", metallic=0.0, roughness=0.5)])


def brush(n: int) -> None:
    b = MeshBuilder()
    half = 3
    for i in range(-half, half + 1):
        for k in range(-half, half + 1):
            sel = abs(i) <= n // 2 and abs(k) <= n // 2
            y = 0.55 if sel else 0.0
            b.add(bevel_box((0.9, 0.9, 0.9), (i * 1.0, y + 0.45, k * 1.0), 0.06), color=CARVE if sel else SLAB)
    _obj(b)


def _arrow(mirror: bool) -> None:
    b = MeshBuilder()
    start, arc = -35.0, 225.0
    flip = scale(-1.0, 1.0, 1.0) if mirror else scale(1.0, 1.0, 1.0)
    to_xy = rotate("X", -90.0)
    b.add(torus(1.0, 0.24, segs=28, rsegs=10, arc=arc, start=start), matrix=flip @ to_xy, color=ARROW)
    te = math.radians(start + arc)
    p = Vector((math.cos(te), math.sin(te), 0.0))
    t = Vector((-math.sin(te), math.cos(te), 0.0))
    h = 0.75
    c = p + t * (h / 2)
    b.add(cylinder(0.55, h, r2=0.0, segs=20), matrix=flip @ translate(c.x, c.y, 0.0) @ rotate("Z", math.degrees(te)),
          color=ARROW)
    _obj(b)


def load_test() -> None:
    b = MeshBuilder()
    b.add(bevel_box((3.2, 0.5, 0.9), (0.0, 0.25, 0.0), 0.05), color=SLAB)
    for x in (-1.35, 1.35):
        b.add(prism_x([(-0.35, -0.7), (0.35, -0.7), (0.0, 0.0)], 0.9), matrix=translate(x, 0.0, 0.0) @ rotate("Y", 90),
              color=P.JIG_STEEL)
    b.add(cylinder(0.32, 0.08, segs=20, center=(0.0, 0.54, 0.0)), color=P.JIG_MACHINED)
    b.add(cylinder(0.11, 0.7, segs=14, center=(0.0, 0.9, 0.0)), color=P.CHROME)
    b.add(cylinder(0.42, 1.1, segs=24, center=(0.0, 1.75, 0.0), bevel=0.04), color=P.LOAD_YELLOW)
    for y in (1.4, 2.1):
        b.add(cylinder(0.425, 0.1, segs=24, center=(0.0, y, 0.0), caps=False), color=P.LOAD_BLACK)
    fin = [(0.4, 2.15), (0.55, 2.15), (0.55, 1.6), (0.8, 1.6), (0.4, 1.15)]
    for ang in (45.0, 135.0, 225.0, 315.0):
        b.add(flat(fin, 0.06), matrix=rotate("Y", ang) @ translate(0.0, 0.0, -0.03), color=P.LOAD_BLACK)
    _obj(b)


def submit() -> None:
    b = MeshBuilder()
    for p, q in (((-0.75, 0.05), (-0.2, -0.5)), ((-0.33, -0.5), (0.85, 0.75))):
        b.add(segment(p, q, 0.36, 0.36), matrix=translate(0.0, 0.0, -0.18), color=CHECK)
    _obj(b)


BUILDERS = {
    "brush-1": lambda: brush(1),
    "brush-3": lambda: brush(3),
    "brush-5": lambda: brush(5),
    "undo": lambda: _arrow(False),
    "redo": lambda: _arrow(True),
    "load-test": load_test,
    "submit": submit,
}
# flat icons face the camera more directly
VIEWS = {
    "undo": Vector((0.25, 0.3, 1.0)).normalized(),
    "redo": Vector((-0.25, 0.3, 1.0)).normalized(),
    "submit": Vector((0.3, 0.35, 1.0)).normalized(),
}


def build(icon_dir: str, size: int) -> list[str]:
    os.makedirs(icon_dir, exist_ok=True)
    outs = []
    for name in NAMES:
        S.reset()
        BUILDERS[name]()
        S.setup_render(size, size, engine="CYCLES", transparent=True, samples=96, world=(0.55, 0.56, 0.6),
                       world_strength=0.9)
        S.light("SUN", pos=(-1.0, 3.0, 2.0), target=(0.0, 0.0, 0.0), energy=3.5, color=(1.0, 0.97, 0.92), size=0.4)
        S.light("SUN", pos=(2.0, 0.5, -1.0), target=(0.0, 0.0, 0.0), energy=1.0, color=(0.8, 0.86, 1.0), size=0.4)
        bpy.context.view_layer.update()
        pts = [o.matrix_world @ Vector(c) for o in bpy.data.objects if o.type == "MESH" for c in o.bound_box]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        c = BL_TO_GLTF.to_3x3() @ ((lo + hi) / 2)
        r = (hi - lo).length / 2
        d = VIEWS.get(name, VIEW)
        S.camera(tuple(c + d * (4.0 * r)), tuple(c), ortho=2.0 * r * 0.98)
        path = os.path.join(icon_dir, f"{name}.png")
        S.render(path)
        outs.append(path)
    return outs
