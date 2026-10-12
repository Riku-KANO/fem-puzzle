"""Authoring helpers for procedural stage sources (``stages/src/<id>.py``).

A source calls these to build a Blender scene that follows the stage naming convention;
``export_stage.py`` then voxelises the scene exactly as it would a hand-made ``.blend``.

All boxes are given in **stage cell coordinates** (Y-up, cell units): ``lo``/``hi`` are the
min/max cell *boundaries*, so ``box((0, 0, 0), (24, 8, 4))`` covers cells 0..23 x 0..7 x 0..3.
Boxes are created in Blender metres (Z-up) via ``stagecore.stage_to_blender``; keep the
domain's min corner at (0, 0, 0) so source cell numbers equal exported cell numbers.
"""

from __future__ import annotations

from typing import Sequence

import bpy

from stagecore import FACES, stage_to_blender

ALUMINIUM = {"E": 70e9, "nu": 0.33, "allowable": 120e6, "density": 2700.0}
PROVISIONAL_TARGETS = (0.7, 0.55, 0.45)  # T-203 `topopt calibrate` overwrites these

Vec3 = Sequence[float]


def reset() -> None:
    """Empty the current scene: remove every object, orphan mesh and scene custom prop."""
    scene = bpy.context.scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for mesh in list(bpy.data.meshes):
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)
    for key in list(scene.keys()):
        del scene[key]


def stage_props(
    id: str,
    title: str,
    world: int,
    voxel_size: float = 0.01,
    material: dict | None = None,
    targets: Sequence[float] = PROVISIONAL_TARGETS,
    hints: Sequence[str] = (),
    max_displacement: float | None = None,
) -> None:
    """Scene-level stage properties (custom props on the scene)."""
    mat = dict(ALUMINIUM if material is None else material)
    scene = bpy.context.scene
    scene["stage_id"] = id
    scene["title"] = title
    scene["world"] = int(world)
    scene["voxel_size"] = float(voxel_size)
    scene["material_E"] = float(mat["E"])
    scene["material_nu"] = float(mat["nu"])
    scene["material_allowable"] = float(mat["allowable"])
    if mat.get("density") is not None:
        scene["material_density"] = float(mat["density"])
    scene["targets"] = [float(t) for t in targets]
    if hints:
        scene["hints"] = [str(h) for h in hints]
    if max_displacement is not None:
        scene["max_displacement"] = float(max_displacement)


def _voxel_size() -> float:
    h = bpy.context.scene.get("voxel_size")
    if h is None:
        raise RuntimeError("call stage_props(...) before creating boxes (voxel_size unknown)")
    return float(h)


def box(name: str, lo: Vec3, hi: Vec3, display: str = "WIRE") -> bpy.types.Object:
    """Closed box mesh object spanning stage cells ``lo``..``hi`` (cell boundaries)."""
    h = _voxel_size()
    if any(float(b) <= float(a) for a, b in zip(lo, hi)):
        raise ValueError(f"{name}: empty box {lo}..{hi}")
    a = [float(v) * h for v in lo]
    b = [float(v) * h for v in hi]
    centre_stage = [(p + q) / 2 for p, q in zip(a, b)]
    centre = stage_to_blender(centre_stage)
    corners = []
    for x in (a[0], b[0]):
        for y in (a[1], b[1]):
            for z in (a[2], b[2]):
                p = stage_to_blender((x, y, z))
                corners.append(tuple(p[i] - centre[i] for i in range(3)))
    # corners[i] with i = 4*ix + 2*iy + iz (stage axes); faces wound outward after the
    # axis flip are recomputed below, so winding here only has to be consistent.
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(corners, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = centre
    obj.display_type = display
    bpy.context.scene.collection.objects.link(obj)
    _orient_outward(mesh)
    return obj


def _orient_outward(mesh: bpy.types.Mesh) -> None:
    """Flip the box's faces if they point inward (only cosmetic; the voxeliser uses parity)."""
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def domain_box(lo: Vec3, hi: Vec3, name: str = "domain") -> bpy.types.Object:
    """Design-domain box. Several ``domain*`` objects are united."""
    if not name.startswith("domain"):
        name = "domain_" + name
    return box(name, lo, hi, display="SOLID")


def support(name: str, lo: Vec3, hi: Vec3, face: str, fix: str = "xyz", whole_face: bool = False) -> bpy.types.Object:
    """Support on the cells inside the box: nodes on ``face`` of each cell, components ``fix``.

    ``whole_face=True`` exports ``{face, fix}`` without ``cells``: every node of the grid face
    that touches an initially-solid cell is fixed (the box must lie in that boundary layer).
    """
    if face not in FACES:
        raise ValueError(f"support {name}: face must be one of {FACES}")
    obj = box("support_" + name, lo, hi)
    obj["face"] = face
    obj["fix"] = fix
    if whole_face:
        obj["whole_face"] = True
    return obj


def load(name: str, lo: Vec3, hi: Vec3, force: Vec3) -> bpy.types.Object:
    """Load on the cells inside the box. ``force`` = total force (N) in *stage* axes."""
    obj = box("load_" + name, lo, hi)
    obj["force"] = [float(f) for f in force]
    return obj


def keep(name: str, lo: Vec3, hi: Vec3) -> bpy.types.Object:
    """Protected cells (cannot be carved, excluded from the stress judgement)."""
    return box("keep_" + name, lo, hi)


def block(name: str, lo: Vec3, hi: Vec3) -> bpy.types.Object:
    """Obstacle cells: never material (removed from the domain)."""
    return box("block_" + name, lo, hi)
