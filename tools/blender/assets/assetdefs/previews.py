"""Review renders (tools/blender/assets/previews/*.png), made from the *exported* files.

Re-importing the .glb files means the previews show exactly what the game loads, and the
two `scene_*` renders double as a worked example of the placement rules in the README
(they place jigs with the same maths T-310 will use). EEVEE output is GPU dependent, so
previews are committed for review but not byte-checked.
"""

from __future__ import annotations

import os

import bpy
from mathutils import Matrix, Vector

from assetkit import scene as S
from assetkit.geo import BL_TO_GLTF, GLTF_TO_BL, MeshBuilder, basis, box, hexrgb, scale, translate

W, H = 480, 320
BENCH_GAP = 0.16  # domain bottom above the bed top (README placement rule)


def _import(path: str) -> bpy.types.Object:
    """Import a .glb and return its root object."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in new if o.parent is None]
    return sorted(roots, key=lambda o: o.name)[0]


def _place(root: bpy.types.Object, m_gltf: Matrix) -> None:
    """Give an imported root a glTF-space transform."""
    root.matrix_world = GLTF_TO_BL @ m_gltf @ BL_TO_GLTF


def _child(root: bpy.types.Object, name: str) -> bpy.types.Object:
    for c in root.children_recursive:
        if c.name.startswith(name):
            return c
    raise KeyError(name)


def _domain(size, min_corner, color="#8fa3b8") -> bpy.types.Object:
    """A stand-in for the voxel part (min corner + size, glTF space)."""
    b = MeshBuilder()
    c = tuple(min_corner[i] + size[i] / 2 for i in range(3))
    b.add(box(size, c), color=hexrgb(color))
    return b.to_object("domain", [S.mat_pbr("domain_mat", roughness=0.5)])


def _lights(key: float = 3.0) -> None:
    S.light("SUN", pos=(-1.0, 2.0, 1.0), target=(0.0, 0.0, 0.0), energy=key, color=(1.0, 0.95, 0.88), size=0.3)
    S.light("AREA", pos=(0.6, 0.8, 1.2), target=(0.0, 0.1, 0.0), energy=25.0, size=1.0)
    S.light("AREA", pos=(-0.8, 0.4, -0.6), target=(0.0, 0.1, 0.0), energy=8.0, size=1.0, color=(0.8, 0.88, 1.0))


def _render(prev_dir: str, name: str, outs: list[str]) -> None:
    path = os.path.join(prev_dir, f"{name}.png")
    S.render(path)
    outs.append(path)


def _env(out_dir: str) -> None:
    _import(os.path.join(out_dir, "workbench.glb"))
    _import(os.path.join(out_dir, "workshop.glb"))


def workshop(out_dir: str, prev_dir: str, outs: list[str]) -> None:
    S.reset()
    _env(out_dir)
    S.setup_render(W, H, world=(0.02, 0.02, 0.025))
    _lights()
    S.camera((0.0, 0.2 + 0.6, 0.6), (0.0, 0.12, 0.0), lens=28.0)
    _render(prev_dir, "workbench", outs)
    S.camera((1.75, 0.75, 2.3), (-0.4, 0.05, -0.2), lens=20.0)
    _render(prev_dir, "workshop", outs)


# per-jig preview pose (glTF space) and a stand-in for the adjacent bit of the part
_POSE = {
    "jig_clamp": (basis((0, 1, 0), (-1, 0, 0)), ((0.06, 0.08, 0.08), (0.0, -0.04, -0.04))),
    "jig_pin": (basis((0, 0, 1), (0, -1, 0)), ((0.12, 0.04, 0.08), (-0.06, 0.0, -0.04))),
    "jig_roller": (basis((0, 0, 1), (0, -1, 0)), ((0.12, 0.04, 0.08), (-0.06, 0.0, -0.04))),
    "jig_riser": (Matrix.Identity(4), None),
    "jig_cylinder": (Matrix.Identity(4), ((0.08, 0.04, 0.06), (-0.04, -0.04, -0.03))),
    "jig_weight": (Matrix.Identity(4), ((0.08, 0.04, 0.06), (-0.04, 0.0, -0.03))),
}


def jigs(out_dir: str, prev_dir: str, names: list[str], outs: list[str]) -> None:
    for name in names:
        S.reset()
        root = _import(os.path.join(out_dir, f"{name}.glb"))
        pose, stub = _POSE.get(name, (Matrix.Identity(4), None))
        _place(root, pose)
        if name == "jig_riser":
            _child(root, "riser_column").scale = (1.0, 1.0, 0.12)  # Blender Z = glTF Y
        if stub is not None:
            _domain(*stub)
        S.setup_render(W, H, world=(0.16, 0.17, 0.18))
        _lights()
        bpy.context.view_layer.update()
        pts = [o.matrix_world @ Vector(b) for o in bpy.data.objects if o.type == "MESH" for b in o.bound_box]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        c = BL_TO_GLTF.to_3x3() @ ((lo + hi) / 2)
        r = (hi - lo).length / 2
        eye = c + Vector((0.6, 0.45, 0.85)).normalized() * (3.6 * r)
        S.camera(tuple(eye), tuple(c), lens=50.0)
        _render(prev_dir, name, outs)


def _jig(out_dir: str, name: str, m: Matrix) -> bpy.types.Object:
    root = _import(os.path.join(out_dir, f"{name}.glb"))
    _place(root, m)
    return root


def _riser(out_dir: str, x: float, z: float, top: float) -> None:
    root = _jig(out_dir, "jig_riser", translate(x, 0.0, z))
    _child(root, "riser_column").scale = (1.0, 1.0, top)


def scenes(out_dir: str, prev_dir: str, outs: list[str]) -> None:
    """W1 cantilever (clamp + cylinder) and W2 beam (pin, roller, hanging weight)."""
    g = BENCH_GAP
    # ---- W1: 24 x 8 x 4 voxels of 1 cm, x- face clamped, downward load on the tip top
    S.reset()
    _env(out_dir)
    S.setup_render(W, H, world=(0.02, 0.02, 0.025))
    _lights()
    nx, ny, nz = 0.24, 0.08, 0.04
    _domain((nx, ny, nz), (-nx / 2, g, -nz / 2))
    # clamp: contact = centre of the x- face, +Y -> -X, local X -> +Y (patch 0.08 x 0.04)
    m = basis((0, 1, 0), (-1, 0, 0), (-nx / 2, g + ny / 2, 0.0)) @ scale((ny + 0.02) / 0.10, 1.0, (nz + 0.02) / 0.10)
    _jig(out_dir, "jig_clamp", m)
    _riser(out_dir, -nx / 2 - 0.03, 0.0, g + ny / 2 - 0.06 * (ny + 0.02) / 0.10)
    # cylinder: force (0, -F, 0) on the top of the last column: -Y = F, so identity rotation
    _jig(out_dir, "jig_cylinder", translate(nx / 2 - 0.005, g + ny, 0.0))
    S.camera((0.05, g + 0.55, 0.62), (0.0, g + 0.02, 0.0), lens=30.0)
    _render(prev_dir, "scene_w1", outs)

    # ---- W2: 32 x 8 x 8, pin + roller under the ends, hanging weight under mid-span
    S.reset()
    _env(out_dir)
    S.setup_render(W, H, world=(0.02, 0.02, 0.025))
    _lights()
    nx, ny, nz = 0.32, 0.08, 0.08
    _domain((nx, ny, nz), (-nx / 2, g, -nz / 2))
    for name, x in (("jig_pin", -nx / 2 + 0.005), ("jig_roller", nx / 2 - 0.005)):
        # bottom face: +Y -> -Y (down), local X (pin axis) -> +Z across the beam
        m = basis((0, 0, 1), (0, -1, 0), (x, g, 0.0)) @ scale(nz / 0.08, 1.0, 1.0)
        _jig(out_dir, name, m)
        _riser(out_dir, x, 0.0, g - 0.06)
    _jig(out_dir, "jig_weight", translate(0.0, g, 0.0))
    S.camera((0.12, g + 0.42, 0.62), (0.0, g - 0.02, 0.0), lens=30.0)
    _render(prev_dir, "scene_w2", outs)


def debris(out_dir: str, prev_dir: str, outs: list[str]) -> None:
    S.reset()
    root = _import(os.path.join(out_dir, "debris.glb"))
    pieces = sorted((o for o in root.children_recursive if o.type == "MESH"), key=lambda o: o.name)
    # a row of the individual pieces + a little pile, on a dark steel plate
    for i, o in enumerate(pieces):
        o.location = GLTF_TO_BL.to_3x3() @ Vector((-0.03 + 0.015 * i, 0.006, 0.012))
    import random

    rng = random.Random(7)
    for k in range(40):
        src = pieces[k % len(pieces)]
        dup = src.copy()
        bpy.context.scene.collection.objects.link(dup)
        dup.parent = None
        dup.location = GLTF_TO_BL.to_3x3() @ Vector((rng.gauss(0.0, 0.009), 0.003 + rng.random() * 0.006,
                                                     -0.012 + rng.gauss(0.0, 0.006)))
        dup.rotation_euler = (rng.random() * 6.28, rng.random() * 6.28, rng.random() * 6.28)
    b = MeshBuilder()
    b.add(box((0.12, 0.004, 0.08), (0.0, -0.002, 0.0)), color=hexrgb("#3b4146"))
    b.to_object("plate", [S.mat_pbr("plate_mat", metallic=0.4, roughness=0.5)])
    S.setup_render(W, H, world=(0.16, 0.17, 0.18))
    _lights()
    S.camera((0.05, 0.075, 0.1), (0.0, 0.0, 0.0), lens=50.0)
    _render(prev_dir, "debris", outs)


def decal(out_dir: str, prev_dir: str, outs: list[str]) -> None:
    """The crack decal on an over-stressed (magenta) block face, next to the raw texture."""
    S.reset()
    b = MeshBuilder()
    b.add(box((0.08, 0.08, 0.04), (0.0, 0.0, -0.02)), color=hexrgb("#d23cc8"))
    b.to_object("block", [S.mat_pbr("block_mat", roughness=0.6)])
    img = bpy.data.images.load(os.path.join(out_dir, "crack_decal.png"))
    m = bpy.data.materials.new("decal")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    for name, x, under in (("decal_on_block", 0.0, None), ("decal_raw", 0.1, hexrgb("#e8e4dc"))):
        me = bpy.data.meshes.new(name)
        h = 0.04
        me.from_pydata([(x - h, -h, 0.0005), (x + h, -h, 0.0005), (x + h, h, 0.0005), (x - h, h, 0.0005)], [],
                       [(0, 1, 2, 3)])
        uv = me.uv_layers.new()
        for li, (u, v) in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
            uv.data[li].uv = (u, v)
        me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        ob.matrix_world = GLTF_TO_BL
        bpy.context.scene.collection.objects.link(ob)
        if under is not None:
            ub = MeshBuilder()
            ub.add(box((0.08, 0.08, 0.002), (x, 0.0, -0.001)), color=under)
            ub.to_object("paper", [S.mat_pbr("paper_mat", roughness=0.9)])
    S.setup_render(W, H, world=(0.16, 0.17, 0.18))
    _lights()
    S.camera((0.05, 0.02, 0.22), (0.05, 0.0, 0.0), lens=50.0)
    _render(prev_dir, "crack_decal", outs)


def crack_tile(out_dir: str, prev_dir: str, outs: list[str]) -> None:
    """crack_tile.png repeated 3 x 3 over voxel-face-sized magenta cells (shows the seams)."""
    import numpy as np

    from assetkit import png

    im = bpy.data.images.load(os.path.join(out_dir, "crack_tile.png"))
    w, h = im.size
    t = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
    big = np.tile(t, (3, 3, 1))
    face = np.empty(big.shape[:2] + (3,), dtype=np.float32)
    face[:] = (0.82, 0.24, 0.78)
    face[::w, :] = face[:, ::w] = (0.55, 0.12, 0.5)  # voxel edges
    a = big[..., 3:4]
    rgb = big[..., :3] * a + face * (1 - a)
    rgba = np.concatenate([rgb, np.ones(rgb.shape[:2] + (1,), dtype=np.float32)], axis=2)
    path = os.path.join(prev_dir, "crack_tile.png")
    png.write_rgba(path, rgba.shape[1], rgba.shape[0], (np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
    outs.append(path)


def icon_sheet(icon_dir: str, prev_dir: str, names: list[str], outs: list[str]) -> None:
    """All toolbar icons on a dark HUD-like strip (pure numpy composite)."""
    import numpy as np

    from assetkit import png

    tiles = []
    for n in names:
        im = bpy.data.images.load(os.path.join(icon_dir, f"{n}.png"))
        w, h = im.size
        px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1]
        tiles.append(px)
    pad = 16
    w = len(tiles) * (128 + pad) + pad
    hgt = 128 + 2 * pad
    bg = np.empty((hgt, w, 3), dtype=np.float32)
    bg[:] = (0.13, 0.14, 0.16)
    for i, t in enumerate(tiles):
        x = pad + i * (128 + pad)
        a = t[..., 3:4]
        bg[pad : pad + 128, x : x + 128] = t[..., :3] * a + bg[pad : pad + 128, x : x + 128] * (1 - a)
    rgba = np.concatenate([np.clip(bg, 0, 1), np.ones((hgt, w, 1), dtype=np.float32)], axis=2)
    path = os.path.join(prev_dir, "icons.png")
    png.write_rgba(path, w, hgt, (rgba * 255 + 0.5).astype(np.uint8).tobytes())
    outs.append(path)


def build(out_dir: str, prev_dir: str, only: list[str]) -> list[str]:
    outs: list[str] = []
    want = (lambda k: not only or k in only)
    if want("workshop"):
        workshop(out_dir, prev_dir, outs)
    if want("jigs"):
        from .jigs import JIGS

        jigs(out_dir, prev_dir, list(JIGS), outs)
    if want("workshop") and want("jigs"):
        scenes(out_dir, prev_dir, outs)
    if want("debris"):
        debris(out_dir, prev_dir, outs)
    if want("decal"):
        decal(out_dir, prev_dir, outs)
        crack_tile(out_dir, prev_dir, outs)
    icon_dir = os.path.join(out_dir, "icons")
    if want("icons") and os.path.isdir(icon_dir):
        from .icons import NAMES

        icon_sheet(icon_dir, prev_dir, NAMES, outs)
    return outs
