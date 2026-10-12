"""Workbench (+ steel test bed) and the workshop room around it.

Frame (shared by workbench.glb and workshop.glb): origin = centre of the test-bed plate's
top surface, Y up, the game camera looks from +Z towards -Z. Both are static and rendered
unlit: their lighting (lamp over the bench, sun and sky through the window on the left,
ceiling tubes, ambient occlusion) is baked into the vertex colours.
"""

from __future__ import annotations

import math
import os
import random

from assetkit import scene as S
from assetkit.bake import DirLight, Lighting, PointLight, bake_lighting
from assetkit.geo import (
    RGB,
    MeshBuilder,
    box,
    bevel_box,
    cylinder,
    flat,
    grid,
    hexrgb,
    icosphere,
    mix,
    rotate,
    scale,
    segment,
    shade,
    ticks,
    torus,
    translate,
)

from . import palette as P

FLOOR = -0.93  # floor height (m) below the bed top
WOOD_TOP = -0.03  # bench top surface
BED_SIZE = (0.72, 0.03, 0.42)
BENCH_SIZE = (1.60, 0.06, 0.80)
ROOM_X = (-2.0, 2.0)
ROOM_Z = (-0.55, 2.6)
CEIL = 1.8
RAIL_Y = -0.2  # wainscot / chair-rail height
LAMP = (0.0, 0.95, -0.12)  # pendant bulb centre
WIN_Y = (0.05, 1.05)  # window opening on the left wall (x = ROOM_X[0])
WIN_Z = (-0.10, 1.10)
SUN_DIR = (-1.0, 1.3, 0.35)  # towards the sun (through the window)

# Debris / physics colliders (boxes, metres, workbench frame) for T-310.
COLLIDERS = [
    {"name": "bed", "center": [0.0, -0.015, 0.0], "halfExtents": [0.36, 0.015, 0.21]},
    {"name": "benchTop", "center": [0.0, -0.06, 0.0], "halfExtents": [0.80, 0.03, 0.40]},
    {"name": "floor", "center": [0.0, FLOOR - 0.05, 1.0], "halfExtents": [2.0, 0.05, 1.6]},
]


def _normal(vs) -> tuple[float, float, float]:
    n = (vs[1] - vs[0]).cross(vs[2] - vs[0])
    ln = n.length or 1.0
    return (n.x / ln, n.y / ln, n.z / ln)


def top_side(top: RGB, side: RGB):
    """face_color callback: `top` on upward faces, `side` elsewhere."""

    def f(_i, vs):
        return top if _normal(vs)[1] > 0.5 else side

    return f


# =========================================================================== bench


def bench() -> MeshBuilder:
    b = MeshBuilder()
    rng = random.Random(3071)

    # --- steel test bed: base slab + raised strips, T-slot grooves between them
    bx, bz = BED_SIZE[0], BED_SIZE[2]
    b.add(box((bx, 0.018, bz), (0.0, -0.021, 0.0), step=0.1, skip_faces=("-y",)),
          color=P.BED_BODY, face_color=top_side(P.BED_GROOVE, P.BED_BODY))
    groove, strips = 0.014, 4
    w = (bz - (strips - 1) * groove) / strips
    for i in range(strips):
        zc = -bz / 2 + i * (w + groove) + w / 2
        b.add(box((bx, 0.012, w), (0.0, -0.006, zc), step=0.1, skip_faces=("-y",)),
              color=P.BED_BODY, face_color=top_side(P.BED_TOP, P.BED_BODY))
    # ruler ticks on the front face, every 5 cm (10 cm ticks longer)
    for k in range(-7, 8):
        h = 0.008 if k % 2 == 0 else 0.004
        b.add(box((0.0016, h, 0.0006), (k * 0.05, -h / 2 - 0.0012, bz / 2 + 0.0003)), color=P.BED_TICK)
    # hold-down bolts at the corners
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.add(cylinder(0.009, 0.004, segs=12, center=(sx * (bx / 2 - 0.03), 0.002, sz * (bz / 2 - 0.045)),
                           bevel=0.001), color=P.BED_GROOVE)

    # --- wooden top: 8 planks along x (inner side faces / bottoms are never seen)
    for i in range(8):
        z = -0.35 + 0.1 * i
        skips = ["-y"]
        if i > 0:
            skips.append("-z")
        if i < 7:
            skips.append("+z")
        col = P.WOOD[rng.randrange(len(P.WOOD))]
        b.add(box((1.60, 0.06, 0.1), (0.0, WOOD_TOP - 0.03, z), step=0.1, skip_faces=skips), color=col)

    # --- frame: legs, aprons, lower shelf
    leg_h = (WOOD_TOP - 0.06) - FLOOR
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.add(box((0.07, leg_h, 0.07), (sx * 0.72, FLOOR + leg_h / 2, sz * 0.33), skip_faces=("-y", "+y")),
                  color=P.FRAME)
            b.add(box((0.09, 0.015, 0.09), (sx * 0.72, FLOOR + 0.0075, sz * 0.33), skip_faces=("-y",)),
                  color=P.RUBBER)
    ay = WOOD_TOP - 0.06 - 0.05
    b.add(box((1.37, 0.10, 0.025), (0.0, ay, 0.34), skip_faces=("+y",)), color=P.FRAME)
    b.add(box((1.37, 0.10, 0.025), (0.0, ay, -0.34), skip_faces=("+y",)), color=P.FRAME)
    b.add(box((0.025, 0.10, 0.59), (0.72, ay, 0.0), skip_faces=("+y",)), color=P.FRAME)
    b.add(box((0.025, 0.10, 0.59), (-0.72, ay, 0.0), skip_faces=("+y",)), color=P.FRAME)
    shelf_y = FLOOR + 0.17
    b.add(box((1.37, 0.02, 0.59), (0.0, shelf_y, 0.0), step=0.2), color=P.WOOD_DARK)

    # lower shelf: aluminium bar stock (raw blocks the game's parts are carved from)
    for row, n in ((0, 4), (1, 3), (2, 2)):
        for k in range(n):
            z = (k - (n - 1) / 2) * 0.045
            b.add(bevel_box((0.5, 0.04, 0.04), (-0.36, shelf_y + 0.03 + row * 0.04, z + 0.02), 0.002),
                  color=shade(P.ALU, 0.92 + 0.04 * ((k + row) % 2)))
    # toolbox
    tb = (0.36, shelf_y + 0.01)
    b.add(bevel_box((0.42, 0.16, 0.22), (tb[0], tb[1] + 0.08, 0.02), 0.006), color=P.CABINET)
    b.add(box((0.43, 0.012, 0.225), (tb[0], tb[1] + 0.13, 0.02)), color=P.CABINET_DARK)
    b.add(torus(0.07, 0.008, segs=10, rsegs=6, arc=180.0, start=180.0),
          matrix=translate(tb[0], tb[1] + 0.16, 0.02) @ rotate("X", 90.0), color=P.RUBBER)

    _vise(b, (-0.62, WOOD_TOP, 0.27))
    _mug(b, (0.64, WOOD_TOP, 0.25))
    _notebook(b, (0.6, WOOD_TOP, -0.17))
    return b


def _vise(b: MeshBuilder, at) -> None:
    x, y, z = at
    b.add(cylinder(0.065, 0.02, segs=16, center=(x, y + 0.01, z), bevel=0.003), color=shade(P.VISE, 0.8))
    b.add(bevel_box((0.09, 0.07, 0.17), (x, y + 0.055, z), 0.006), color=P.VISE)
    for zz in (z - 0.065, z + 0.035):
        b.add(bevel_box((0.15, 0.05, 0.035), (x, y + 0.105, zz), 0.004), color=P.VISE)
    for zz in (z - 0.046, z + 0.016):  # serrated jaw plates
        b.add(box((0.15, 0.04, 0.004), (x, y + 0.11, zz)), color=P.STEEL)
    b.add(cylinder(0.008, 0.16, segs=10, axis="z", center=(x, y + 0.065, z + 0.13)), color=P.CHROME)
    b.add(cylinder(0.0045, 0.17, segs=8, axis="x", center=(x, y + 0.065, z + 0.205)), color=P.CHROME)
    for sx in (-1, 1):
        b.add(icosphere(0.009, 1), matrix=translate(x + sx * 0.088, y + 0.065, z + 0.205), color=P.CHROME)


def _mug(b: MeshBuilder, at) -> None:
    x, y, z = at
    h, r = 0.095, 0.04
    b.add(cylinder(r, h, segs=16, center=(x, y + h / 2, z), caps=False), color=P.MUG)
    b.add(cylinder(r * 0.92, h, segs=16, center=(x, y + h / 2, z), caps=False), color=shade(P.MUG, 0.75),
          invert=True)
    b.add(torus(r * 0.96, 0.0016 + r * 0.04, segs=16, rsegs=4), matrix=translate(x, y + h, z), color=P.MUG)
    b.add(cylinder(r * 0.92, 0.002, segs=16, center=(x, y + h - 0.012, z)), color=P.COFFEE)
    b.add(cylinder(r * 1.002, 0.025, segs=16, center=(x, y + 0.06, z), caps=False), color=P.BLUE_PAINT)
    b.add(torus(0.024, 0.006, segs=10, rsegs=6), matrix=translate(x + r + 0.012, y + 0.05, z) @ rotate("X", 90.0),
          color=P.MUG)


def _notebook(b: MeshBuilder, at) -> None:
    x, y, z = at
    m = translate(x, y, z) @ rotate("Y", 12.0)
    b.add(box((0.21, 0.008, 0.15), (0.0, 0.004, 0.0)), matrix=m, color=hexrgb("#33424f"))
    b.add(box((0.2, 0.002, 0.142), (0.0, 0.009, 0.0)), matrix=m, color=P.PAPER)
    # sketch: a cantilever with a load arrow, plus "text" lines
    lines = [
        ((-0.08, -0.03), (0.04, -0.03)), ((-0.08, -0.05), (0.04, -0.05)), ((0.04, -0.03), (0.04, -0.05)),
        ((-0.08, -0.015), (-0.08, -0.065)), ((0.04, 0.0), (0.04, -0.025)),
        ((0.04, -0.025), (0.033, -0.017)), ((0.04, -0.025), (0.047, -0.017)),
        ((-0.08, 0.03), (0.02, 0.03)), ((-0.08, 0.045), (0.06, 0.045)), ((-0.08, 0.06), (0.03, 0.06)),
    ]
    flatten = translate(0.0, 0.0101, 0.0) @ rotate("X", -90.0)
    for p, q in lines:
        b.add(segment(p, q, 0.0014, 0.0003), matrix=m @ flatten, color=P.INK)
    # pencil
    pm = translate(x - 0.02, y + 0.004, z + 0.115) @ rotate("Y", -25.0)
    b.add(cylinder(0.0038, 0.15, segs=6, axis="x", center=(0.0, 0.0, 0.0)), matrix=pm, color=P.YELLOW_PAINT)
    b.add(cylinder(0.0038, 0.018, segs=6, axis="x", r2=0.0008, center=(0.084, 0.0, 0.0)), matrix=pm,
          color=hexrgb("#d9b98c"))


# =========================================================================== room


def room() -> MeshBuilder:
    b = MeshBuilder()
    rng = random.Random(3072)
    x0, x1 = ROOM_X
    z0, z1 = ROOM_Z
    hgt = CEIL - FLOOR

    # floor: concrete slabs (0.6 m) with slight tone variation
    slab = {}

    def floor_col(_i, vs):
        cx = sum(v.x for v in vs) / 4
        cz = sum(v.z for v in vs) / 4
        key = (math.floor(cx / 0.6), math.floor(cz / 0.6))
        if key not in slab:
            slab[key] = shade(P.FLOOR, 0.94 + 0.12 * rng.random())
        return slab[key]

    zs = ticks(0.0, z1 - z0, 0.15, [k * 0.6 - z0 for k in range(-1, 6)])
    xs = ticks(0.0, x1 - x0, 0.15, [k * 0.6 - x0 for k in range(-4, 5)])
    b.add(grid((x0, FLOOR, z0), (0, 0, 1), (1, 0, 0), zs, xs), color=P.FLOOR, face_color=floor_col)
    # anti-fatigue mat in front of the bench
    b.add(box((1.3, 0.012, 0.55), (0.0, FLOOR + 0.006, 0.75), step=0.15, skip_faces=("-y",)), color=P.FLOOR_MAT)

    def wall_col(_i, vs):
        cy = sum(v.y for v in vs) / len(vs)
        return P.WALL_LOW if cy < RAIL_Y else P.WALL_HIGH

    ys = ticks(0.0, hgt, 0.15, [RAIL_Y - FLOOR, WIN_Y[0] - FLOOR, WIN_Y[1] - FLOOR, 0.2 - FLOOR, 0.9 - FLOOR])
    # back wall (z = z0, facing +z); finer grid behind the bench where the lamp falls off
    bx = ticks(0.0, x1 - x0, 0.2, [1.0, 3.0])
    bx = sorted(set(bx) | set(ticks(1.0, 3.0, 0.1)))
    b.add(grid((x0, FLOOR, z0), (1, 0, 0), (0, 1, 0), bx, ys), color=P.WALL_HIGH, face_color=wall_col)
    # left wall (x = x0, facing +x) with the window opening
    lz = ticks(0.0, z1 - z0, 0.15, [WIN_Z[0] - z0, WIN_Z[1] - z0])

    def in_window(u0, u1, v0, v1):
        yc, zc = FLOOR + (u0 + u1) / 2, z0 + (v0 + v1) / 2
        return WIN_Y[0] < yc < WIN_Y[1] and WIN_Z[0] < zc < WIN_Z[1]

    b.add(grid((x0, FLOOR, z0), (0, 1, 0), (0, 0, 1), ys, lz, skip=in_window), color=P.WALL_HIGH,
          face_color=wall_col)
    # right wall (x = x1, facing -x) and front wall (z = z1, facing -z)
    rz = ticks(0.0, z1 - z0, 0.2)
    b.add(grid((x1, FLOOR, z0), (0, 0, 1), (0, 1, 0), rz, ys), color=P.WALL_HIGH, face_color=wall_col)
    fx = ticks(0.0, x1 - x0, 0.2)
    b.add(grid((x0, FLOOR, z1), (0, 1, 0), (1, 0, 0), ys, fx), color=P.WALL_HIGH, face_color=wall_col)
    # ceiling (facing -y)
    b.add(grid((x0, CEIL, z0), (1, 0, 0), (0, 0, 1), ticks(0.0, x1 - x0, 0.25), ticks(0.0, z1 - z0, 0.25)),
          color=P.CEILING)

    # skirting + chair rail on all four walls
    for y, hh, d, col in ((FLOOR + 0.04, 0.08, 0.012, P.SKIRTING), (RAIL_Y, 0.03, 0.015, P.RAIL)):
        b.add(box((x1 - x0, hh, d), (0.0, y, z0 + d / 2), skip_faces=("-z",)), color=col)
        b.add(box((x1 - x0, hh, d), (0.0, y, z1 - d / 2), skip_faces=("+z",)), color=col)
        if y < WIN_Y[0] or y > WIN_Y[1]:
            b.add(box((d, hh, z1 - z0), (x0 + d / 2, y, (z0 + z1) / 2), skip_faces=("-x",)), color=col)
        b.add(box((d, hh, z1 - z0), (x1 - d / 2, y, (z0 + z1) / 2), skip_faces=("+x",)), color=col)

    _window(b)
    _lamp(b)
    _ceiling_lights(b)
    _pegboard(b)
    _shelf(b)
    _blueprint(b)
    _clock(b, (0.98, 1.22, z0))
    _cabinet(b)
    _stool(b, (1.0, FLOOR, 0.72))
    _bin(b, (1.78, FLOOR, 0.4))
    _door(b)
    _front_wall(b)
    return b


def _window(b: MeshBuilder) -> None:
    x0 = ROOM_X[0]
    (ya, yb), (za, zb) = WIN_Y, WIN_Z
    depth = 0.15
    # reveals (inner sides of the opening)
    b.add(grid((x0 - depth, ya, za), (0, 0, 1), (1, 0, 0), [0, zb - za], [0, depth]), color=P.WINDOW_FRAME)
    b.add(grid((x0 - depth, yb, za), (1, 0, 0), (0, 0, 1), [0, depth], [0, zb - za]), color=P.WALL_HIGH)
    b.add(grid((x0 - depth, ya, za), (1, 0, 0), (0, 1, 0), [0, depth], [0, yb - ya]), color=P.WALL_HIGH)
    b.add(grid((x0 - depth, ya, zb), (0, 1, 0), (1, 0, 0), [0, yb - ya], [0, depth]), color=P.WALL_HIGH)

    # glass: emissive sky gradient (does not block the sun)
    def sky(_i, vs):
        t = (sum(v.y for v in vs) / len(vs) - ya) / (yb - ya)
        return mix(P.SKY_LOW, P.SKY_HIGH, t)

    gx = x0 - depth + 0.03
    b.add(grid((gx, ya, za), (0, 1, 0), (0, 0, 1), ticks(0, yb - ya, 0.2), [0, zb - za]), color=P.SKY_HIGH,
          face_color=sky, bake=False, occlude=False)
    # frame + mullions
    fx = gx + 0.02
    fw = 0.045
    for y in (ya + fw / 2, yb - fw / 2, (ya + yb) / 2):
        b.add(box((0.04, fw if y != (ya + yb) / 2 else 0.03, zb - za), (fx, y, (za + zb) / 2)), color=P.WINDOW_FRAME)
    for z in (za + fw / 2, zb - fw / 2, (za + zb) / 2):
        b.add(box((0.04, yb - ya, fw if z != (za + zb) / 2 else 0.03), (fx, (ya + yb) / 2, z)), color=P.WINDOW_FRAME)
    # interior sill + a plant
    b.add(box((0.09, 0.025, zb - za + 0.1), (x0 + 0.045, ya - 0.0125, (za + zb) / 2), skip_faces=("-x",)),
          color=P.WINDOW_FRAME)
    px, pz = x0 + 0.06, 0.86
    b.add(cylinder(0.05, 0.1, r2=0.062, segs=10, center=(px, ya + 0.05, pz), bevel=0.003), color=P.TERRACOTTA)
    b.add(cylinder(0.056, 0.004, segs=10, center=(px, ya + 0.092, pz)), color=hexrgb("#3b2a1e"))
    for (dx, dy, dz, r, col) in ((0.0, 0.17, 0.0, 0.08, P.PLANT), (0.03, 0.24, -0.03, 0.055, P.PLANT_DARK),
                                 (-0.01, 0.14, 0.06, 0.05, P.PLANT_DARK)):
        b.add(icosphere(r, 1), matrix=translate(px + dx, ya + dy, pz + dz) @ scale(1.0, 0.85, 1.0), color=col)


def _lamp(b: MeshBuilder) -> None:
    x, y, z = LAMP
    rim = y - 0.05
    b.add(cylinder(0.16, 0.12, r2=0.032, segs=20, center=(x, rim + 0.06, z), caps=False), color=P.LAMP_SHADE)
    b.add(cylinder(0.157, 0.118, r2=0.03, segs=20, center=(x, rim + 0.06, z), caps=False), color=P.LAMP_INNER,
          invert=True, bake=False)
    b.add(torus(0.16, 0.004, segs=20, rsegs=4), matrix=translate(x, rim, z), color=shade(P.LAMP_SHADE, 0.7))
    b.add(cylinder(0.034, 0.03, segs=10, center=(x, rim + 0.135, z)), color=P.LAMP_SHADE)
    b.add(cylinder(0.004, CEIL - (rim + 0.15), segs=6, center=(x, (CEIL + rim + 0.15) / 2, z)), color=P.RUBBER)
    b.add(cylinder(0.022, 0.045, r2=0.03, segs=10, center=(x, y - 0.005, z)), color=P.BULB, bake=False,
          occlude=False)
    b.add(cylinder(0.03, 0.005, segs=10, center=(x, CEIL - 0.0025, z)), color=P.RUBBER)


TUBES = [(-0.9, CEIL - 0.06, 1.05), (0.9, CEIL - 0.06, 1.05)]


def _ceiling_lights(b: MeshBuilder) -> None:
    for x, y, z in TUBES:
        b.add(box((1.25, 0.05, 0.17), (x, CEIL - 0.025, z), skip_faces=("+y",)), color=P.HOUSING)
        b.add(box((1.18, 0.008, 0.12), (x, CEIL - 0.054, z), skip_faces=("+y",)), color=P.TUBE, bake=False,
              occlude=False)


def _pegboard(b: MeshBuilder) -> None:
    z = ROOM_Z[0]
    zf = z + 0.012  # front face of the board
    b.add(box((1.4, 0.7, 0.012), (0.0, 0.43, z + 0.006), step=0.1, skip_faces=("-z",)), color=P.PEGBOARD)
    for (cx, cy, sx, sy) in ((0.0, 0.79, 1.44, 0.025), (0.0, 0.07, 1.44, 0.025), (-0.71, 0.43, 0.025, 0.74),
                             (0.71, 0.43, 0.025, 0.74)):
        b.add(box((sx, sy, 0.02), (cx, cy, z + 0.01), skip_faces=("-z",)), color=P.WOOD_DARK)
    hole = 0.007
    for i in range(27):
        for j in range(13):
            hx, hy = -0.65 + i * 0.05, 0.13 + j * 0.05
            b.add(grid((hx - hole / 2, hy - hole / 2, zf + 0.0004), (1, 0, 0), (0, 1, 0), [0, hole], [0, hole]),
                  color=P.PEG_HOLE)
    t = zf + 0.0006  # tools sit on the board

    def on_board(x, y, rz=0.0):
        return translate(x, y, t) @ rotate("Z", rz)

    # hammer
    b.add(box((0.026, 0.16, 0.018), (0.0, 0.0, 0.009)), matrix=on_board(-0.56, 0.42), color=P.WOOD[2])
    b.add(box((0.03, 0.1, 0.02), (0.0, -0.13, 0.01)), matrix=on_board(-0.56, 0.42), color=P.RUBBER)
    b.add(bevel_box((0.12, 0.032, 0.024), (0.0, 0.095, 0.012), 0.003), matrix=on_board(-0.56, 0.42),
          color=P.STEEL)
    # wrenches (open end + ring end)
    for k, ln in enumerate((0.2, 0.17, 0.14)):
        m = on_board(-0.4 + k * 0.06, 0.45 - (0.2 - ln) / 2)
        b.add(box((0.016, ln, 0.005), (0.0, 0.0, 0.0025)), matrix=m, color=P.CHROME)
        jaw = [(-0.02, 0.0), (0.02, 0.0), (0.02, 0.03), (0.007, 0.03), (0.007, 0.012), (-0.007, 0.012),
               (-0.007, 0.03), (-0.02, 0.03)]
        b.add(flat(jaw, 0.006), matrix=m @ translate(0.0, ln / 2 - 0.006, 0.0), color=P.CHROME)
        b.add(torus(0.013, 0.004, segs=10, rsegs=4), matrix=m @ translate(0.0, -ln / 2, 0.003) @ rotate("X", 90.0),
              color=P.CHROME)
    # screwdrivers
    for k, col in enumerate((P.RED, P.YELLOW_PAINT, P.BLUE_PAINT, P.GREEN_PAINT)):
        m = on_board(-0.18 + k * 0.045, 0.5)
        b.add(cylinder(0.012, 0.085, segs=8, center=(0.0, 0.0, 0.013), bevel=0.002), matrix=m, color=col)
        b.add(cylinder(0.0028, 0.11 - 0.012 * k, segs=6, center=(0.0, -0.0425 - (0.11 - 0.012 * k) / 2, 0.013)),
              matrix=m, color=P.CHROME)
    # pliers
    for s in (-1, 1):
        m = on_board(0.07, 0.43, s * 9.0)
        b.add(box((0.012, 0.12, 0.008), (0.0, -0.02, 0.004)), matrix=m, color=P.RED)
        b.add(box((0.01, 0.05, 0.008), (0.0, 0.065, 0.004)), matrix=m, color=P.STEEL)
    # hand saw
    blade = [(0.0, 0.0), (0.3, 0.025), (0.3, 0.075), (0.0, 0.11)]
    b.add(flat(blade, 0.002), matrix=on_board(0.2, 0.36), color=P.CHROME)
    handle = [(-0.09, -0.01), (0.005, 0.0), (0.005, 0.12), (-0.09, 0.13), (-0.11, 0.06)]
    b.add(flat(handle, 0.02), matrix=on_board(0.2, 0.36), color=P.WOOD[1])
    # tape measure + wire coil
    b.add(cylinder(0.032, 0.024, segs=12, axis="z", center=(0.6, 0.63, t + 0.012), bevel=0.003),
          color=P.YELLOW_PAINT)
    b.add(torus(0.05, 0.008, segs=14, rsegs=5), matrix=translate(0.6, 0.33, t + 0.008) @ rotate("X", 90.0),
          color=hexrgb("#c46a2b"))
    # power strip under the board
    b.add(bevel_box((0.3, 0.045, 0.035), (0.95, 0.0, z + 0.0175), 0.004), color=P.HOUSING)
    for k in range(4):
        b.add(box((0.03, 0.02, 0.002), (0.855 + k * 0.063, 0.0, z + 0.036)), color=P.RUBBER)


def _shelf(b: MeshBuilder) -> None:
    z = ROOM_Z[0]
    sy = 0.88
    b.add(box((1.5, 0.025, 0.22), (0.0, sy, z + 0.11), step=0.15), color=P.WOOD_DARK)
    for sx in (-0.62, 0.62):
        b.add(box((0.02, 0.14, 0.02), (sx, sy - 0.08, z + 0.01)), color=P.FRAME)
        b.add(box((0.02, 0.02, 0.2), (sx, sy - 0.0225, z + 0.1)), color=P.FRAME)
        b.add(box((0.016, 0.016, 0.21)), matrix=translate(sx, sy - 0.08, z + 0.085) @ rotate("X", 40.0),
              color=P.FRAME)
    top = sy + 0.0125
    # parts bins
    for k, col in enumerate((P.BLUE_PAINT, P.RED, P.YELLOW_PAINT, P.BLUE_PAINT)):
        x = -0.66 + k * 0.115
        b.add(bevel_box((0.1, 0.075, 0.17), (x, top + 0.0375, z + 0.1), 0.004), color=col)
        b.add(box((0.05, 0.02, 0.002), (x, top + 0.045, z + 0.186)), color=P.PAPER)
    # paint cans
    for k, col in enumerate((P.GREEN_PAINT, P.RED)):
        x = -0.12 + k * 0.12
        b.add(cylinder(0.05, 0.11, segs=14, center=(x, top + 0.055, z + 0.11), bevel=0.003), color=P.STEEL)
        b.add(cylinder(0.0505, 0.06, segs=14, center=(x, top + 0.05, z + 0.11), caps=False), color=col)
    # cardboard box with tape
    b.add(box((0.22, 0.14, 0.18), (0.22, top + 0.07, z + 0.1)), color=P.CARDBOARD)
    b.add(box((0.05, 0.002, 0.182), (0.22, top + 0.141, z + 0.1)), color=hexrgb("#c9b48a"))
    # binders
    for k, (col, hh) in enumerate(((P.BLUE_PAINT, 0.22), (P.INK, 0.2), (P.RED, 0.22), (P.GREEN_PAINT, 0.19))):
        b.add(box((0.04, hh, 0.17), (0.48 + k * 0.045, top + hh / 2, z + 0.1)), color=col)
    b.add(box((0.04, 0.2, 0.17)), matrix=translate(0.69, top + 0.098, z + 0.1) @ rotate("Z", -18.0),
          color=P.YELLOW_PAINT)


def _blueprint(b: MeshBuilder) -> None:
    z = ROOM_Z[0] + 0.002
    cx, cy, w, h = -1.2, 0.42, 0.56, 0.76
    b.add(box((w, h, 0.002), (cx, cy, z)), color=P.BLUEPRINT)
    m = translate(cx, cy, z + 0.001)
    L = 0.0035
    pts = []
    # border + title block
    hw, hh = w / 2 - 0.03, h / 2 - 0.03
    pts += [((-hw, -hh), (hw, -hh)), ((hw, -hh), (hw, hh)), ((hw, hh), (-hw, hh)), ((-hw, hh), (-hw, -hh))]
    pts += [((0.06, -hh), (0.06, -hh + 0.08)), ((0.06, -hh + 0.08), (hw, -hh + 0.08))]
    # cantilever: wall hatch, beam, load arrow
    pts += [((-0.18, 0.08), (-0.18, 0.28))] + [((-0.18, 0.1 + 0.04 * k), (-0.21, 0.07 + 0.04 * k)) for k in range(5)]
    pts += [((-0.18, 0.21), (0.17, 0.21)), ((-0.18, 0.16), (0.17, 0.16)), ((0.17, 0.16), (0.17, 0.21))]
    pts += [((0.15, 0.32), (0.15, 0.22)), ((0.15, 0.22), (0.13, 0.25)), ((0.15, 0.22), (0.17, 0.25))]
    # arch (bridge) below
    arc = [(-0.18 + 0.36 * i / 10, -0.18 + 0.16 * math.sin(math.pi * i / 10)) for i in range(11)]
    pts += list(zip(arc, arc[1:]))
    pts += [((-0.2, -0.18), (0.2, -0.18)), ((-0.2, -0.0), (0.2, -0.0))]
    for p, q in pts:
        b.add(segment(p, q, L, 0.0006), matrix=m, color=P.BLUEPRINT_LINE)


def _clock(b: MeshBuilder, at) -> None:
    x, y, z = at
    b.add(cylinder(0.13, 0.03, segs=20, axis="z", center=(x, y, z + 0.015), bevel=0.004), color=P.INK)
    b.add(cylinder(0.118, 0.002, segs=20, axis="z", center=(x, y, z + 0.031)), color=P.PAPER)
    for k in range(12):
        a = math.radians(30 * k)
        b.add(box((0.004, 0.016 if k % 3 == 0 else 0.01, 0.001)),
              matrix=translate(x + 0.1 * math.sin(a), y + 0.1 * math.cos(a), z + 0.0325) @ rotate("Z", -30 * k),
              color=P.INK)
    b.add(segment((0.0, 0.0), (0.05, 0.03), 0.006, 0.002), matrix=translate(x, y, z + 0.033), color=P.INK)
    b.add(segment((0.0, 0.0), (-0.02, 0.085), 0.004, 0.002), matrix=translate(x, y, z + 0.035), color=P.INK)


def _cabinet(b: MeshBuilder) -> None:
    z0 = ROOM_Z[0]
    x, w, d = 1.4, 0.7, 0.46
    h = 0.98 - 0.06
    base = FLOOR + 0.06
    b.add(bevel_box((w, h, d), (x, base + h / 2, z0 + d / 2 + 0.01), 0.008), color=P.CABINET)
    zf = z0 + d + 0.01
    y = base + 0.03
    for k, dh in enumerate((0.22, 0.18, 0.14, 0.1, 0.1, 0.1)):
        b.add(bevel_box((w - 0.05, dh - 0.012, 0.012), (x, y + dh / 2, zf + 0.004), 0.003),
              color=P.CABINET_DARK if k % 2 else shade(P.CABINET, 0.95))
        b.add(cylinder(0.006, w - 0.2, segs=6, axis="x", center=(x, y + dh - 0.025, zf + 0.018)), color=P.CHROME)
        y += dh
    b.add(box((w + 0.01, 0.012, d + 0.01), (x, base + h + 0.006, z0 + d / 2 + 0.01)), color=P.RUBBER)
    for sx in (-1, 1):
        for sz in (-1, 1):
            b.add(cylinder(0.025, 0.02, segs=10, axis="x", center=(x + sx * 0.3, FLOOR + 0.03, z0 + 0.24 + sz * 0.17)),
                  color=P.RUBBER)
    # toolbox on top
    ty = base + h + 0.012
    b.add(bevel_box((0.4, 0.14, 0.2), (x - 0.05, ty + 0.07, z0 + 0.2), 0.006), color=hexrgb("#8a9096"))
    b.add(box((0.41, 0.01, 0.205), (x - 0.05, ty + 0.11, z0 + 0.2)), color=P.FRAME)
    # bench grinder-ish motor block
    b.add(cylinder(0.06, 0.16, segs=12, axis="x", center=(x + 0.22, ty + 0.07, z0 + 0.22), bevel=0.006),
          color=P.VISE)
    for sx in (-1, 1):
        b.add(cylinder(0.065, 0.02, segs=14, axis="x", center=(x + 0.22 + sx * 0.1, ty + 0.07, z0 + 0.22)),
              color=P.STEEL)


def _stool(b: MeshBuilder, at) -> None:
    x, y, z = at
    b.add(cylinder(0.2, 0.07, r2=0.06, segs=12, center=(x, y + 0.035, z)), color=P.FRAME)
    b.add(cylinder(0.024, 0.55, segs=8, center=(x, y + 0.34, z)), color=P.CHROME)
    b.add(torus(0.14, 0.008, segs=14, rsegs=4), matrix=translate(x, y + 0.3, z), color=P.FRAME)
    b.add(cylinder(0.17, 0.06, segs=16, center=(x, y + 0.64, z), bevel=0.012), color=hexrgb("#2f2b28"))


def _bin(b: MeshBuilder, at) -> None:
    x, y, z = at
    b.add(cylinder(0.15, 0.45, r2=0.17, segs=14, center=(x, y + 0.225, z), caps=False), color=hexrgb("#4f5d4f"))
    b.add(cylinder(0.145, 0.45, r2=0.165, segs=14, center=(x, y + 0.225, z), caps=False),
          color=shade(hexrgb("#4f5d4f"), 0.6), invert=True)
    b.add(cylinder(0.16, 0.01, segs=14, center=(x, y + 0.38, z)), color=hexrgb("#9a948a"))
    b.add(torus(0.17, 0.007, segs=14, rsegs=4), matrix=translate(x, y + 0.45, z), color=hexrgb("#3e4a3e"))


def _door(b: MeshBuilder) -> None:
    x1 = ROOM_X[1]
    zc, w, h = 1.6, 0.9, 2.05
    b.add(box((0.04, h, w), (x1 - 0.02, FLOOR + h / 2, zc), step=0.3, skip_faces=("+x",)), color=P.DOOR)
    for dz in (-w / 2 - 0.03, w / 2 + 0.03):
        b.add(box((0.05, h + 0.06, 0.06), (x1 - 0.025, FLOOR + (h + 0.06) / 2, zc + dz), skip_faces=("+x",)),
              color=P.WINDOW_FRAME)
    b.add(box((0.05, 0.06, w + 0.12), (x1 - 0.025, FLOOR + h + 0.03, zc), skip_faces=("+x",)), color=P.WINDOW_FRAME)
    b.add(cylinder(0.009, 0.12, segs=8, axis="z", center=(x1 - 0.07, FLOOR + 1.0, zc - w / 2 + 0.12)),
          color=P.CHROME)
    b.add(cylinder(0.01, 0.05, segs=8, axis="x", center=(x1 - 0.045, FLOOR + 1.0, zc - w / 2 + 0.07)),
          color=P.CHROME)


def _front_wall(b: MeshBuilder) -> None:
    z1 = ROOM_Z[1]
    # whiteboard with a stress-strain curve
    b.add(box((1.3, 0.85, 0.015), (-0.3, 0.45, z1 - 0.0075), skip_faces=("+z",)), color=hexrgb("#ecebe6"))
    curve = [(-0.5 + 0.08 * i, -0.25 + (0.45 * (1 - math.exp(-i / 2.0)))) for i in range(12)]
    m = translate(-0.3, 0.45, z1 - 0.016) @ rotate("Y", 180.0)
    for p, q in zip(curve, curve[1:]):
        b.add(segment(p, q, 0.006, 0.001), matrix=m, color=P.RED)
    b.add(segment((-0.5, -0.27), (0.45, -0.27), 0.005, 0.001), matrix=m, color=P.INK)
    b.add(segment((-0.5, -0.27), (-0.5, 0.3), 0.005, 0.001), matrix=m, color=P.INK)
    # fire extinguisher
    ex, ez = 1.55, z1 - 0.1
    b.add(cylinder(0.075, 0.42, segs=12, center=(ex, FLOOR + 0.5 + 0.21, ez), bevel=0.02), color=P.RED)
    b.add(cylinder(0.02, 0.06, segs=8, center=(ex, FLOOR + 0.95, ez)), color=P.RUBBER)
    b.add(box((0.08, 0.012, 0.025), (ex + 0.03, FLOOR + 0.985, ez)), color=P.RUBBER)


# =========================================================================== lighting


def lighting() -> Lighting:
    warm = hexrgb("#ffdcb0")
    return Lighting(
        ambient=(0.25, 0.25, 0.26),
        ao_distance=0.45,
        ao_samples=24,
        ao_strength=0.9,
        knee=0.7,
        exposure=1.0,
        points=[
            PointLight(pos=LAMP, color=warm, power=1.15, size=0.03, soft=0.06),
            *[PointLight(pos=(x, y - 0.05, z), color=(0.92, 0.96, 1.0), power=1.3, size=0.3, soft=0.3, samples=1)
              for (x, y, z) in TUBES],
        ],
        dirs=[
            DirLight(direction=SUN_DIR, color=hexrgb("#fff0d8"), power=2.2, spread=0.03),
            DirLight(direction=(-1.0, 0.45, 0.25), color=(0.62, 0.72, 0.88), power=0.25, shadow=False, wrap=0.4),
        ],
    )


# =========================================================================== build

FRAME_NOTE = (
    "origin = centre of the test-bed top surface; Y up; camera side = +Z. "
    "Place at (domainCentreX, domainMinY - 0.16, domainCentreZ). Unlit: lighting is baked "
    "into COLOR_0 (linear); render with toneMapped = false."
)


def build(out_dir: str) -> dict[str, dict]:
    """Export workbench.glb and workshop.glb (baked together so they shadow each other)."""
    S.reset()
    baked = S.mat_unlit("baked")
    bb, rb = bench(), room()
    lo, hi = bb.bounds()
    bench_root = S.empty(
        "workbench",
        {
            "asset": "workbench",
            "frame": FRAME_NOTE,
            "bedTopY": 0.0,
            "woodTopY": WOOD_TOP,
            "floorY": FLOOR,
            "colliders": COLLIDERS,
        },
    )
    room_root = S.empty("workshop", {"asset": "workshop", "frame": FRAME_NOTE, "floorY": FLOOR, "ceilingY": CEIL})
    bench_ob = bb.to_object("workbench_mesh", [baked], parent=bench_root)
    room_ob = rb.to_object("workshop_mesh", [baked], parent=room_root)
    pairs = [(bench_ob, bb), (room_ob, rb)]
    bake_lighting(pairs, pairs, lighting())
    out = {}
    for name, root, b in (("workbench", bench_root, bb), ("workshop", room_root, rb)):
        path = os.path.join(out_dir, f"{name}.glb")
        size = S.export_glb(path, [root], normals=False)
        lo, hi = b.bounds()
        out[f"{name}.glb"] = {
            "bytes": size,
            "faces": len(b),
            "bounds": [[round(c, 4) + 0.0 for c in lo], [round(c, 4) + 0.0 for c in hi]],
        }
    return out


__all__ = ["COLLIDERS", "FLOOR", "bench", "build", "lighting", "room"]
