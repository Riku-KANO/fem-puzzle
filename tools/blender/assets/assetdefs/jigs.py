"""Support and load jigs (runtime-lit PBR, mild AO baked into the vertex colours).

Frame of every jig (glTF space, metres): the origin is the centre of the contact patch on
the domain surface.
- Supports (clamp, pin, roller): local +Y = outward normal of the supported face; the jig
  lives in y >= 0 (outside the domain). Local X = the patch's long axis (pin axis).
- Loads: local -Y = force direction. The cylinder PUSHES (contact on the face whose outward
  normal is -F, body in y >= 0); the weight PULLS (hangs from the face whose outward
  normal is +F, body in y <= 0) and is only meant for downward loads.
- The riser is a stand: origin on the bench, node `riser_column` is 1 m tall (scale its Y).
"""

from __future__ import annotations

import math
import os

from assetkit import scene as S
from assetkit.bake import bake_ao
from assetkit.geo import (
    MeshBuilder,
    bevel_box,
    box,
    cylinder,
    flat,
    prism,
    prism_x,
    rotate,
    segment,
    torus,
    translate,
)

from . import palette as P

PAINT, STEEL, RUBBER = 0, 1, 2


def _materials():
    return [
        S.mat_pbr("jig_paint", metallic=0.0, roughness=0.55),
        S.mat_pbr("jig_steel", metallic=0.6, roughness=0.35),
        S.mat_pbr("jig_rubber", metallic=0.0, roughness=0.85),
    ]


def _hex_bolt(b: MeshBuilder, x: float, y: float, z: float, r: float, h: float, axis_sign: float) -> None:
    """Hex head with its axis along Y, protruding from y towards axis_sign."""
    b.add(cylinder(r, h, segs=6, center=(x, y + axis_sign * h / 2, z), bevel=r * 0.15), color=P.JIG_MACHINED,
          mat=STEEL)


def _hatch(b: MeshBuilder, w: float, h: float, matrix, pitch: float = 0.009) -> None:
    """Engineering 'fixed support' hatch: 45° bars across a w x h face (XY plane, +Z out)."""
    run = h - 0.006  # horizontal run of one 45° bar
    n = max(1, int((w - 0.008 - run) / pitch) + 1)
    x = -((n - 1) * pitch + run) / 2
    for _ in range(n):
        b.add(segment((x, -h / 2 + 0.003), (x + run, h / 2 - 0.003), 0.002, 0.0005), matrix=matrix,
              color=P.JIG_HATCH, mat=PAINT)
        x += pitch


# =========================================================================== supports


def clamp() -> dict[str, MeshBuilder]:
    """Fixed face: a bolted fixture plate. Nominal patch 0.08 x 0.08 (plate 0.10 x 0.10)."""
    plate = MeshBuilder()
    plate.add(bevel_box((0.10, 0.012, 0.10), (0.0, 0.006, 0.0), 0.0015), color=P.JIG_MACHINED, mat=STEEL)
    for sx in (-1, 1):
        for sz in (-1, 1):
            _hex_bolt(plate, sx * 0.045, 0.0, sz * 0.045, 0.0045, 0.004, -1.0)
    block = MeshBuilder()
    d = 0.036
    block.add(bevel_box((0.12, d, 0.12), (0.0, 0.012 + d / 2, 0.0), 0.003), color=P.JIG_STEEL, mat=PAINT)
    yc = 0.012 + d / 2
    for ang in (0.0, 90.0, 180.0, 270.0):
        m = rotate("Y", ang) @ translate(0.0, yc, 0.06)
        _hatch(block, 0.11, d, m)
    # back: a raised boss where the fixture is mounted
    block.add(cylinder(0.03, 0.006, segs=16, center=(0.0, 0.048 + 0.003, 0.0), bevel=0.0015), color=P.JIG_STEEL,
              mat=PAINT)
    return {"clamp_plate": plate, "clamp_block": block}


def _knuckle(b: MeshBuilder, y_base: float, length: float) -> None:
    trap = [(-0.03, y_base), (0.03, y_base), (0.009, 0.006), (-0.009, 0.006)]
    b.add(prism_x(trap, length), color=P.JIG_STEEL, mat=PAINT)


def pin() -> dict[str, MeshBuilder]:
    """Pin support: pin axis = local X (nominal length 0.08), pedestal down to y = 0.06."""
    pinb = MeshBuilder()
    pinb.add(cylinder(0.006, 0.09, segs=14, axis="x", center=(0.0, 0.006, 0.0), bevel=0.001), color=P.JIG_MACHINED,
             mat=STEEL)
    body = MeshBuilder()
    _knuckle(body, 0.05, 0.07)
    body.add(bevel_box((0.09, 0.01, 0.075), (0.0, 0.055, 0.0), 0.002), color=P.JIG_STEEL, mat=PAINT)
    for sx in (-1, 1):
        for sz in (-1, 1):
            _hex_bolt(body, sx * 0.035, 0.05, sz * 0.028, 0.004, 0.003, -1.0)
    return {"pin_pin": pinb, "pin_body": body}


def roller() -> dict[str, MeshBuilder]:
    """Roller support: like the pin, but the pedestal rides on three rollers (slides along Z)."""
    pinb = MeshBuilder()
    pinb.add(cylinder(0.006, 0.09, segs=14, axis="x", center=(0.0, 0.006, 0.0), bevel=0.001), color=P.JIG_MACHINED,
             mat=STEEL)
    body = MeshBuilder()
    _knuckle(body, 0.034, 0.07)
    body.add(bevel_box((0.08, 0.006, 0.07), (0.0, 0.037, 0.0), 0.0015), color=P.JIG_STEEL, mat=PAINT)
    rollers = MeshBuilder()
    for z in (-0.022, 0.0, 0.022):
        rollers.add(cylinder(0.0055, 0.08, segs=12, axis="x", center=(0.0, 0.0455, z), bevel=0.0008),
                    color=P.JIG_MACHINED, mat=STEEL)
    base = MeshBuilder()
    base.add(bevel_box((0.09, 0.008, 0.08), (0.0, 0.056, 0.0), 0.002), color=P.JIG_STEEL, mat=PAINT)
    for sz in (-1, 1):  # rails keep the rollers in place
        base.add(box((0.09, 0.004, 0.004), (0.0, 0.05, sz * 0.038)), color=P.JIG_STEEL, mat=PAINT)
    body.extend(base)
    return {"roller_pin": pinb, "roller_body": body, "roller_rollers": rollers}


def riser() -> dict[str, MeshBuilder]:
    """Stand under a jig: origin on the bench, `riser_column` spans y in [0, 1] (scale Y)."""
    foot = MeshBuilder()
    foot.add(bevel_box((0.07, 0.008, 0.07), (0.0, 0.004, 0.0), 0.002), color=P.JIG_STEEL, mat=PAINT)
    for sx in (-1, 1):
        for sz in (-1, 1):
            _hex_bolt(foot, sx * 0.026, 0.008, sz * 0.026, 0.004, 0.003, 1.0)
    col = MeshBuilder()
    col.add(box((0.035, 1.0, 0.035), (0.0, 0.5, 0.0), skip_faces=("-y",)), color=P.JIG_STEEL, mat=PAINT, bake=False)
    return {"riser_foot": foot, "riser_column": col}


# =========================================================================== loads

ROD_TRAVEL = 0.04  # how far `cylinder_rod` can retract (+Y) for the load-test animation


def hydraulic_cylinder() -> dict[str, MeshBuilder]:
    """Pusher: pad at the origin, body along +Y (0 .. 0.245). Force acts along -Y."""
    rod = MeshBuilder()
    rod.add(cylinder(0.016, 0.006, segs=16, center=(0.0, 0.003, 0.0), bevel=0.001), color=P.JIG_MACHINED, mat=STEEL)
    rod.add(cylinder(0.0065, 0.11, segs=12, center=(0.0, 0.006 + 0.055, 0.0)), color=P.CHROME, mat=STEEL)

    body = MeshBuilder()
    body.add(cylinder(0.017, 0.014, segs=6, center=(0.0, 0.077, 0.0), bevel=0.0015), color=P.JIG_STEEL, mat=PAINT)
    body.add(cylinder(0.023, 0.12, segs=20, center=(0.0, 0.144, 0.0), bevel=0.0015), color=P.LOAD_YELLOW, mat=PAINT)
    for y in (0.1, 0.188):
        body.add(cylinder(0.0234, 0.008, segs=20, center=(0.0, y, 0.0), caps=False), color=P.LOAD_BLACK, mat=PAINT)
    body.add(cylinder(0.026, 0.012, segs=20, center=(0.0, 0.21, 0.0), bevel=0.0015), color=P.LOAD_BLACK, mat=PAINT)
    for sx in (-1, 1):
        body.add(bevel_box((0.006, 0.028, 0.03), (sx * 0.01, 0.23, 0.0), 0.001), color=P.JIG_STEEL, mat=PAINT)
    body.add(cylinder(0.004, 0.034, segs=10, axis="x", center=(0.0, 0.236, 0.0)), color=P.JIG_MACHINED, mat=STEEL)
    # hydraulic port with a short hose stub
    body.add(cylinder(0.005, 0.012, segs=8, axis="z", center=(0.0, 0.196, 0.027)), color=P.JIG_MACHINED, mat=STEEL)
    body.add(cylinder(0.0045, 0.02, segs=8, axis="z", center=(0.0, 0.196, 0.043)), color=P.HOSE, mat=RUBBER)
    # direction fins: four flat arrows pointing at the contact (-Y)
    fin = [(0.0215, 0.196), (0.0305, 0.196), (0.0305, 0.128), (0.045, 0.128), (0.0215, 0.086)]
    for ang in (45.0, 135.0, 225.0, 315.0):
        body.add(flat(fin, 0.003), matrix=rotate("Y", ang) @ translate(0.0, 0.0, -0.0015), color=P.LOAD_BLACK,
                 mat=PAINT)
    return {"cylinder_rod": rod, "cylinder_body": body}


def _slotted_disc(r: float, slot: float, hole: float, segs: int = 20) -> list[tuple[float, float]]:
    a0 = math.asin(slot / 2 / r)
    pts = [(r * math.cos(a0 + (2 * math.pi - 2 * a0) * i / segs), r * math.sin(a0 + (2 * math.pi - 2 * a0) * i / segs))
           for i in range(segs + 1)]
    return pts + [(hole, -slot / 2), (hole, slot / 2)]


def weight() -> dict[str, MeshBuilder]:
    """Hanging slotted weights: saddle at the origin, stack hangs along -Y (0 .. -0.125)."""
    hook = MeshBuilder()
    hook.add(bevel_box((0.026, 0.004, 0.026), (0.0, -0.002, 0.0), 0.001), color=P.JIG_MACHINED, mat=STEEL)
    hook.add(torus(0.0065, 0.0018, segs=12, rsegs=6), matrix=translate(0.0, -0.0115, 0.0) @ rotate("X", 90.0),
             color=P.JIG_MACHINED, mat=STEEL)
    hook.add(torus(0.0065, 0.0018, segs=12, rsegs=6),
             matrix=translate(0.0, -0.0215, 0.0) @ rotate("Y", 90.0) @ rotate("X", 90.0), color=P.JIG_MACHINED,
             mat=STEEL)
    hook.add(cylinder(0.0025, 0.036, segs=8, center=(0.0, -0.046, 0.0)), color=P.CHROME, mat=STEEL)

    stack = MeshBuilder()
    stack.add(cylinder(0.022, 0.005, segs=16, center=(0.0, -0.0665, 0.0), bevel=0.001), color=P.CAST_IRON, mat=PAINT)
    disc = _slotted_disc(0.033, 0.0065, 0.004)
    y = -0.069
    for k in range(4):
        col = P.LOAD_YELLOW if k % 2 == 0 else P.LOAD_BLACK
        stack.add(prism(disc, 0.011, y - 0.011), matrix=rotate("Y", 90.0 * k), color=col, mat=PAINT)
        y -= 0.012
    stack.add(cylinder(0.0025, 0.05, segs=8, center=(0.0, -0.093, 0.0)), color=P.CHROME, mat=STEEL)
    stack.add(cylinder(0.0065, 0.006, segs=6, center=(0.0, y - 0.003, 0.0), bevel=0.0008), color=P.JIG_MACHINED,
              mat=STEEL)
    return {"weight_hook": hook, "weight_stack": stack}


SPREADER_T = 0.008  # spreader plate thickness


def spreader() -> dict[str, MeshBuilder]:
    """Load-spreader plate for wide load patches: 1 x 1 m in X/Z (scale it to the patch in
    metres), y in [0, 0.008]. Put the cylinder on top of it at y = 0.008."""
    plate = MeshBuilder()
    t = SPREADER_T
    plate.add(box((1.0, t * 0.6, 1.0), (0.0, t * 0.3, 0.0)), color=P.LOAD_BLACK, mat=PAINT, bake=False)
    plate.add(box((1.0, t * 0.4, 1.0), (0.0, t * 0.8, 0.0), skip_faces=("-y",)), color=P.LOAD_YELLOW, mat=PAINT,
              bake=False)
    return {"spreader_plate": plate}


# =========================================================================== build

JIGS = {
    "jig_clamp": (clamp, {
        "kind": "support", "use": "fixed face (fix xyz, whole face or large patch)",
        "frame": "origin = contact patch centre; +Y = outward face normal; body in y >= 0",
        "nominalPatch": [0.08, 0.08], "scaleXZ": "(patch + 0.02) / 0.10 per axis", "depth": 0.054,
    }),
    "jig_pin": (pin, {
        "kind": "support", "use": "pin (fix xyz on a few cells)",
        "frame": "origin = contact patch centre; +Y = outward face normal; pin axis = local X",
        "nominalPatch": [0.08, 0.01], "scaleX": "patch length / 0.08", "depth": 0.06,
    }),
    "jig_roller": (roller, {
        "kind": "support", "use": "roller (fix is a strict subset of xyz)",
        "frame": "origin = contact patch centre; +Y = outward face normal; pin axis = local X, rolls along Z",
        "nominalPatch": [0.08, 0.01], "scaleX": "patch length / 0.08", "depth": 0.06,
    }),
    "jig_riser": (riser, {
        "kind": "stand", "use": "column from the bench up to a support jig",
        "frame": "origin on the bench top; riser_column spans y in [0, 1]: set its scale.y to the height",
    }),
    "jig_cylinder": (hydraulic_cylinder, {
        "kind": "load", "force": "push",
        "frame": "origin = contact patch centre; -Y = force direction; body in y >= 0 (0 .. 0.245)",
        "padDiameter": 0.032, "rodTravel": ROD_TRAVEL, "animate": "cylinder_rod.position.y",
    }),
    "jig_weight": (weight, {
        "kind": "load", "force": "pull",
        "frame": "origin = contact patch centre (underside); -Y = force direction (down); hangs in y <= 0",
        "saddle": [0.026, 0.026], "animate": "weight_stack.position.y",
    }),
    "jig_spreader": (spreader, {
        "kind": "load-spreader", "use": "under a cylinder when the load patch is wider than its pad",
        "frame": "origin = contact patch centre; -Y = force direction; plate in y in [0, 0.008]",
        "scaleXZ": "patch size in metres (unit plate)", "thickness": SPREADER_T,
    }),
}


def _r(v):
    if isinstance(v, float):
        return round(v, 4)
    if isinstance(v, list):
        return [_r(x) for x in v]
    return v


def build(out_dir: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name, (fn, meta) in JIGS.items():
        S.reset()
        mats = _materials()
        parts = fn()
        root = S.empty(name, {"asset": name, **{k: _r(v) for k, v in meta.items()}})
        pairs = []
        for pname, b in parts.items():
            ob = b.to_object(pname, mats, parent=root)
            pairs.append((ob, b))
        bake_ao(pairs, distance=0.02, strength=0.55)
        path = os.path.join(out_dir, f"{name}.glb")
        size = S.export_glb(path, [root], normals=True)
        merged = MeshBuilder()
        for b in parts.values():
            merged.extend(b)
        lo, hi = merged.bounds()
        out[f"{name}.glb"] = {
            "bytes": size,
            "faces": len(merged),
            "nodes": sorted(parts),
            "bounds": [[round(c, 4) + 0.0 for c in lo], [round(c, 4) + 0.0 for c in hi]],
            **{k: _r(v) for k, v in meta.items()},
        }
    return out
