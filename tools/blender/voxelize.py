"""Scene → stage dict: voxelise the design domain and collect supports/loads/keep/block.

Naming convention (design doc ステージ作成フロー):

- ``domain*``    closed meshes; their union is the design domain. The grid origin is the
                 min corner of the domain bounds (stage axes), ``n = extent / voxel_size``.
- ``support_*``  props ``face`` (x-/x+/y-/y+/z-/z+), ``fix`` (subset of "xyz"),
                 optional ``whole_face`` (bool).
- ``load_*``     prop ``force`` = [fx, fy, fz] total newtons in *stage* axes.
- ``keep_*``, ``block_*``  no props.

Role objects select the cells whose centres lie inside them (BVH ray parity, 3 skewed rays,
majority vote). Scene props: ``stage_id``, ``title``, ``world``, ``voxel_size``,
``material_E/nu/allowable[/density]``, ``targets`` [s1, s2, s3], ``hints`` [str],
``max_displacement`` (optional).

Axes: stage (x, y, z) = Blender (x, z, -y)  (see ``stagecore.blender_to_stage``).
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import stagecore as sc

ROLES = ("domain", "support_", "load_", "keep_", "block_")

# Skewed (non axis-aligned) ray directions so rays from cell centres never graze mesh edges.
_RAY_DIRS = [
    Vector((1.0, 0.0137, 0.0071)).normalized(),
    Vector((-0.0093, 1.0, 0.0119)).normalized(),
    Vector((0.0111, -0.0067, 1.0)).normalized(),
]


class StageBuildError(Exception):
    pass


@dataclass
class Solid:
    """A closed world-space mesh with a BVH for inside queries (stage-axis bounds)."""

    name: str
    bvh: BVHTree
    lo: np.ndarray  # stage-axis bounds
    hi: np.ndarray

    def contains(self, p_stage: np.ndarray, step: float) -> bool:
        if np.any(p_stage < self.lo) or np.any(p_stage > self.hi):
            return False
        origin = Vector(sc.stage_to_blender(p_stage))
        votes = 0
        for d in _RAY_DIRS:
            crossings = 0
            o = origin.copy()
            for _ in range(10_000):
                loc, _normal, _index, _dist = self.bvh.ray_cast(o, d)
                if loc is None:
                    break
                crossings += 1
                o = loc + d * step
            votes += crossings % 2
        return votes >= 2


@dataclass
class SceneStage:
    stage: dict
    report: list[str] = field(default_factory=list)


def _role(obj: bpy.types.Object) -> str | None:
    for r in ROLES:
        if obj.name.startswith(r):
            return r.rstrip("_")
    return None


def _solid_from_object(obj: bpy.types.Object, depsgraph) -> Solid:
    if obj.type != "MESH":
        raise StageBuildError(f"{obj.name}: role objects must be meshes (got {obj.type})")
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    try:
        mesh.calc_loop_triangles()
        mw = ev.matrix_world
        verts = [mw @ v.co for v in mesh.vertices]
        tris = [tuple(t.vertices) for t in mesh.loop_triangles]
    finally:
        ev.to_mesh_clear()
    if not tris:
        raise StageBuildError(f"{obj.name}: mesh has no faces")
    edges = Counter()
    for t in tris:
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            edges[(a, b) if a < b else (b, a)] += 1
    open_edges = sum(1 for c in edges.values() if c != 2)
    if open_edges:
        raise StageBuildError(
            f"{obj.name}: mesh is not closed ({open_edges} edges not shared by exactly 2 faces); "
            "merge by distance / make it watertight"
        )
    pts = np.array([sc.blender_to_stage(v) for v in verts])
    return Solid(obj.name, BVHTree.FromPolygons(verts, tris), pts.min(axis=0), pts.max(axis=0))


def _scene_prop(scene, key, default=None, required=True):
    if key in scene.keys():
        return scene[key]
    if required and default is None:
        raise StageBuildError(f"scene custom property {key!r} is missing")
    return default


def _cells_inside(solid: Solid, centres: np.ndarray, candidates: np.ndarray, step: float) -> np.ndarray:
    """Boolean mask over ``candidates`` (element indices) whose centres lie inside ``solid``."""
    out = np.zeros(len(candidates), dtype=bool)
    for i, e in enumerate(candidates):
        out[i] = solid.contains(centres[e], step)
    return out


def voxelize_scene(scene: bpy.types.Scene | None = None) -> SceneStage:
    """Build the stage dict (contract format, not yet validated) from a scene."""
    scene = scene or bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    report: list[str] = []

    h = float(_scene_prop(scene, "voxel_size"))
    if not (math.isfinite(h) and h > 0):
        raise StageBuildError(f"voxel_size must be positive (got {h})")

    by_role: dict[str, list[bpy.types.Object]] = {r.rstrip("_"): [] for r in ROLES}
    for obj in sorted(scene.objects, key=lambda o: o.name):
        r = _role(obj)
        if r:
            by_role[r].append(obj)
    if not by_role["domain"]:
        raise StageBuildError("no design-domain object (name starting with 'domain')")

    domains = [_solid_from_object(o, depsgraph) for o in by_role["domain"]]
    lo = np.min([d.lo for d in domains], axis=0)
    hi = np.max([d.hi for d in domains], axis=0)
    grid = []
    for extent in hi - lo:
        r = extent / h
        n = round(r) if abs(r - round(r)) < 1e-4 else math.ceil(r)
        grid.append(int(n))
    if min(grid) <= 0:
        raise StageBuildError(f"degenerate domain bounds {lo}..{hi}")
    nx, ny, nz = grid
    n = nx * ny * nz

    # cell centres in stage axes, element order e = x + nx*(y + ny*z)
    zz, yy, xx = np.meshgrid(np.arange(nz), np.arange(ny), np.arange(nx), indexing="ij")
    idx = np.stack([xx.ravel(), yy.ravel(), zz.ravel()], axis=1)
    centres = lo + (idx + 0.5) * h
    all_cells = np.arange(n)
    step = h * 1e-3

    domain = np.zeros(n, dtype=bool)
    for d in domains:
        domain |= _cells_inside(d, centres, all_cells, step)

    def select(obj) -> np.ndarray:
        s = _solid_from_object(obj, depsgraph)
        mask = np.zeros(n, dtype=bool)
        mask[all_cells] = _cells_inside(s, centres, all_cells, step)
        if not mask.any():
            raise StageBuildError(f"{obj.name}: contains no cell centre (grid {nx}x{ny}x{nz}, h={h})")
        return mask

    block = np.zeros(n, dtype=bool)
    for o in by_role["block"]:
        block |= select(o)
    solid = domain & ~block

    def cells_of(mask: np.ndarray) -> list[list[int]]:
        return [list(sc.element_coords(grid, int(e))) for e in np.flatnonzero(mask)]

    keep = np.zeros(n, dtype=bool)
    for o in by_role["keep"]:
        m = select(o)
        outside = m & ~solid
        if outside.any():
            c = sc.element_coords(grid, int(np.flatnonzero(outside)[0]))
            raise StageBuildError(f"{o.name}: keep cell {c} is not solid")
        keep |= m

    supports = []
    for o in by_role["support"]:
        face = o.get("face")
        fix = o.get("fix")
        if face not in sc.FACES:
            raise StageBuildError(f"{o.name}: custom prop 'face' must be one of {sc.FACES} (got {face!r})")
        if not isinstance(fix, str) or not fix or set(fix) - set("xyz"):
            raise StageBuildError(f"{o.name}: custom prop 'fix' must be a non-empty subset of 'xyz' (got {fix!r})")
        fix = "".join(c for c in "xyz" if c in fix)
        m = select(o)
        entry = {"face": face, "fix": fix}
        if o.get("whole_face", False):
            axis = "xyz".index(face[0])
            layer = grid[axis] - 1 if face[1] == "+" else 0
            off = [c for c in cells_of(m) if c[axis] != layer]
            if off:
                raise StageBuildError(f"{o.name}: whole_face support must lie in the {face} boundary layer (cell {off[0]})")
        else:
            entry["cells"] = cells_of(m)
        supports.append(entry)
        report.append(f"{o.name}: face {face} fix {fix} " + ("whole face" if "cells" not in entry else f"{len(entry['cells'])} cells"))

    loads = []
    for o in by_role["load"]:
        force = o.get("force")
        try:
            force = [float(f) for f in force]
        except TypeError:
            force = None
        if force is None or len(force) != 3:
            raise StageBuildError(f"{o.name}: custom prop 'force' must be [fx, fy, fz] (N, stage axes)")
        m = select(o)
        loads.append({"cells": cells_of(m), "force": [f + 0.0 for f in force]})
        report.append(f"{o.name}: {int(m.sum())} cells, force {force} N")

    mat = {
        "E": float(_scene_prop(scene, "material_E")),
        "nu": float(_scene_prop(scene, "material_nu")),
        "allowable": float(_scene_prop(scene, "material_allowable")),
    }
    density = _scene_prop(scene, "material_density", required=False)
    if density is not None:
        mat["density"] = float(density)
    targets = [float(t) for t in _scene_prop(scene, "targets", default=(0.7, 0.55, 0.45))]
    if len(targets) != 3:
        raise StageBuildError("scene prop 'targets' must be [star1, star2, star3]")

    stage = {
        "version": sc.FORMAT_VERSION,
        "id": str(_scene_prop(scene, "stage_id")),
        "title": str(_scene_prop(scene, "title")),
        "world": int(_scene_prop(scene, "world")),
        "grid": grid,
        "voxelSize": h,
        "material": mat,
        "solid": sc.encode_bitmask(solid),
        "keep": sc.encode_bitmask(keep),
        "supports": supports,
        "loads": loads,
        "targets": {"star1": targets[0], "star2": targets[1], "star3": targets[2]},
    }
    if block.any():
        stage["block"] = sc.encode_bitmask(block)
    hints = _scene_prop(scene, "hints", required=False)
    if hints:
        stage["hints"] = [str(x) for x in hints]
    md = _scene_prop(scene, "max_displacement", required=False)
    if md is not None:
        stage["maxDisplacement"] = float(md)

    report.insert(
        0,
        f"grid {nx}x{ny}x{nz} h={h} solid {int(solid.sum())} keep {int(keep.sum())} block {int(block.sum())} "
        f"supports {len(supports)} loads {len(loads)}",
    )
    return SceneStage(stage, report)
