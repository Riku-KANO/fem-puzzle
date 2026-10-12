"""Procedural mesh building in glTF space (Y-up, metres).

`MeshBuilder` accumulates polygons with per-face albedo (linear RGB), material slot and
smooth/bake/occlude flags, then turns them into one Blender mesh object whose corner colour
attribute ``Color`` holds the albedo. The bake step (`bake.py`) later multiplies that colour
by lighting / ambient occlusion.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence

import bmesh
import bpy
from mathutils import Matrix, Vector

RGB = tuple[float, float, float]
Vec = Sequence[float]

# glTF (x, y, z) -> Blender (x, -z, y). The glTF exporter (export_yup) applies the inverse.
GLTF_TO_BL = Matrix(
    (
        (1.0, 0.0, 0.0, 0.0),
        (0.0, 0.0, -1.0, 0.0),
        (0.0, 1.0, 0.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    )
)
BL_TO_GLTF = GLTF_TO_BL.inverted()


def to_bl(v: Vec) -> Vector:
    """A glTF-space point/direction in Blender space."""
    return GLTF_TO_BL.to_3x3() @ Vector(v)


# --------------------------------------------------------------------------- colours


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_to_srgb(c: float) -> float:
    c = min(max(c, 0.0), 1.0)
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1.0 / 2.4) - 0.055


def hexrgb(h: str) -> RGB:
    """'#rrggbb' (sRGB, as picked in a colour picker) -> linear RGB."""
    h = h.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b))


def mix(a: RGB, b: RGB, t: float) -> RGB:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def shade(c: RGB, k: float) -> RGB:
    return (c[0] * k, c[1] * k, c[2] * k)


# --------------------------------------------------------------------------- matrices


def translate(x: float, y: float, z: float) -> Matrix:
    return Matrix.Translation((x, y, z))


def rotate(axis: str, deg: float) -> Matrix:
    """Rotation about a glTF-space axis ('X', 'Y' or 'Z')."""
    return Matrix.Rotation(math.radians(deg), 4, axis)


def scale(sx: float, sy: float, sz: float) -> Matrix:
    return Matrix.Diagonal((sx, sy, sz, 1.0))


def basis(x_axis: Vec, y_axis: Vec, origin: Vec = (0.0, 0.0, 0.0)) -> Matrix:
    """Matrix whose local X/Y map to the given (orthogonalised) directions."""
    y = Vector(y_axis).normalized()
    x = Vector(x_axis)
    x = (x - y * x.dot(y)).normalized()
    z = x.cross(y)
    m = Matrix.Identity(4)
    for r in range(3):
        m[r][0], m[r][1], m[r][2], m[r][3] = x[r], y[r], z[r], origin[r]
    return m


# --------------------------------------------------------------------------- primitives
# Each returns (verts, faces, smooth_flags) in local coordinates.

Prim = tuple[list[Vector], list[list[int]], list[bool]]


def _from_bm(bm: bmesh.types.BMesh) -> Prim:
    bm.verts.index_update()
    verts = [v.co.copy() for v in bm.verts]
    faces = [[v.index for v in f.verts] for f in bm.faces]
    smooth = [f.smooth for f in bm.faces]
    bm.free()
    return verts, faces, smooth


def ticks(a: float, b: float, step: float, cuts: Iterable[float] = ()) -> list[float]:
    """Sorted positions from a to b, spacing <= step, always containing the given cuts."""
    pts = {round(a, 6), round(b, 6)}
    pts.update(round(c, 6) for c in cuts if a < c < b)
    srt = sorted(pts)
    out: list[float] = []
    for p, q in zip(srt, srt[1:]):
        n = max(1, math.ceil((q - p) / step - 1e-9))
        out.extend(p + (q - p) * i / n for i in range(n))
    out.append(srt[-1])
    return out


def grid(
    origin: Vec,
    u: Vec,
    v: Vec,
    us: Sequence[float],
    vs: Sequence[float],
    skip: Callable[[float, float, float, float], bool] | None = None,
) -> Prim:
    """Quad grid on origin + s*u + t*v for s in us, t in vs; normal = u x v."""
    o, du, dv = Vector(origin), Vector(u), Vector(v)
    verts: list[Vector] = []
    index: dict[tuple[int, int], int] = {}

    def vid(i: int, j: int) -> int:
        key = (i, j)
        if key not in index:
            index[key] = len(verts)
            verts.append(o + du * us[i] + dv * vs[j])
        return index[key]

    faces: list[list[int]] = []
    for j in range(len(vs) - 1):
        for i in range(len(us) - 1):
            if skip and skip(us[i], us[i + 1], vs[j], vs[j + 1]):
                continue
            faces.append([vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)])
    return verts, faces, [False] * len(faces)


# (normal axis, sign) -> (u axis, v axis) with u x v = normal
_BOX_FACES = {
    ("x", 1): ("y", "z"),
    ("x", -1): ("z", "y"),
    ("y", 1): ("z", "x"),
    ("y", -1): ("x", "z"),
    ("z", 1): ("x", "y"),
    ("z", -1): ("y", "x"),
}
_AX = {"x": 0, "y": 1, "z": 2}


def box(
    size: Vec,
    center: Vec = (0.0, 0.0, 0.0),
    *,
    step: float | None = None,
    skip_faces: Iterable[str] = (),
) -> Prim:
    """Axis-aligned box. `step` subdivides the faces (for baked lighting resolution).
    `skip_faces` e.g. ('-y',) leaves faces out (hidden against a wall/floor)."""
    half = [s / 2.0 for s in size]
    skips = set(skip_faces)
    verts: list[Vector] = []
    faces: list[list[int]] = []
    for (ax, sgn), (ua, va) in _BOX_FACES.items():
        if f"{'+' if sgn > 0 else '-'}{ax}" in skips:
            continue
        n = _AX[ax]
        iu, iv = _AX[ua], _AX[va]
        origin = list(center)
        origin[n] += sgn * half[n]
        origin[iu] -= half[iu]
        origin[iv] -= half[iv]
        uvec = [0.0, 0.0, 0.0]
        vvec = [0.0, 0.0, 0.0]
        uvec[iu] = 1.0
        vvec[iv] = 1.0
        st = step if step else max(size) * 2.0
        us = ticks(0.0, size[iu], st)
        vs = ticks(0.0, size[iv], st)
        gv, gf, _ = grid(origin, uvec, vvec, us, vs)
        base = len(verts)
        verts.extend(gv)
        faces.extend([[base + i for i in f] for f in gf])
    return verts, faces, [False] * len(faces)


def bevel_box(size: Vec, center: Vec = (0.0, 0.0, 0.0), bevel: float = 0.002) -> Prim:
    """Box with chamfered edges (one bevel segment, flat shaded)."""
    bm = bmesh.new()
    m = Matrix.Translation(center) @ scale(size[0], size[1], size[2])
    bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    if bevel > 0.0:
        bmesh.ops.bevel(
            bm,
            geom=list(bm.edges),
            offset=bevel,
            offset_type="OFFSET",
            segments=1,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    for f in bm.faces:
        f.smooth = False
    return _from_bm(bm)


def cylinder(
    r: float,
    h: float,
    *,
    segs: int = 16,
    r2: float | None = None,
    center: Vec = (0.0, 0.0, 0.0),
    axis: str = "y",
    bevel: float = 0.0,
    caps: bool = True,
    smooth: bool = True,
) -> Prim:
    """Cylinder/cone along a glTF axis, centred at `center`; r = radius at the -axis end."""
    top = r if r2 is None else r2
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r, radius2=top, depth=h
    )
    # created along +Z (radius1 at -Z): rotate Z onto the requested axis
    to_axis = {
        "y": rotate("X", -90.0),
        "x": rotate("Y", 90.0),
        "z": Matrix.Identity(4),
    }[axis]
    bmesh.ops.transform(bm, matrix=Matrix.Translation(center) @ to_axis, verts=list(bm.verts))
    a = Vector((0.0, 0.0, 0.0))
    a[_AX[axis]] = 1.0
    bm.normal_update()
    if bevel > 0.0 and caps:
        rim = [e for e in bm.edges if any(abs(f.normal.dot(a)) > 0.99 for f in e.link_faces)]
        bmesh.ops.bevel(
            bm,
            geom=rim,
            offset=bevel,
            offset_type="OFFSET",
            segments=1,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
    bm.normal_update()
    slope = (r - top) / math.hypot(h, r - top)
    for f in bm.faces:
        f.smooth = smooth and abs(f.normal.dot(a) - slope) < 0.02 and len(f.verts) == 4
    return _from_bm(bm)


def prism(poly: Sequence[tuple[float, float]], depth: float, y0: float = 0.0) -> Prim:
    """Extrude a 2D polygon given in the XZ plane (x, z) from y0 to y0 + depth."""
    n = len(poly)
    verts = [Vector((x, y0, z)) for x, z in poly] + [Vector((x, y0 + depth, z)) for x, z in poly]
    # Newell normal of the outline in XZ: orient the top face to +Y
    ny = sum((poly[i][1] - poly[(i + 1) % n][1]) * (poly[i][0] + poly[(i + 1) % n][0]) for i in range(n))
    ring = list(range(n)) if ny > 0 else list(reversed(range(n)))
    top = [n + i for i in ring]
    bottom = list(reversed(ring))
    faces = [top, bottom]
    for k in range(n):
        a, b = ring[k], ring[(k + 1) % n]
        faces.append([a, b, n + b, n + a])
    return verts, faces, [False] * len(faces)


def torus(
    major: float,
    minor: float,
    *,
    segs: int = 16,
    rsegs: int = 8,
    arc: float = 360.0,
    start: float = 0.0,
) -> Prim:
    """Torus around the Y axis (ring in the XZ plane); `arc` < 360 gives a capped arc."""
    closed = arc >= 360.0 - 1e-6
    n = segs if closed else segs + 1
    verts: list[Vector] = []
    for i in range(n):
        t = math.radians(start + arc * i / segs)
        radial = Vector((math.cos(t), 0.0, math.sin(t)))
        c = radial * major
        for j in range(rsegs):
            p = 2.0 * math.pi * j / rsegs
            verts.append(c + (radial * math.cos(p) + Vector((0.0, 1.0, 0.0)) * math.sin(p)) * minor)
    faces: list[list[int]] = []
    rings = segs if closed else segs
    for i in range(rings):
        i2 = (i + 1) % n
        for j in range(rsegs):
            j2 = (j + 1) % rsegs
            faces.append([i * rsegs + j, i2 * rsegs + j, i2 * rsegs + j2, i * rsegs + j2])
    smooth = [True] * len(faces)
    if not closed:
        faces.append([j for j in range(rsegs)])
        faces.append([(n - 1) * rsegs + j for j in range(rsegs)][::-1])
        smooth += [False, False]
    # orient outward: check the first quad against the tube's radial direction
    f0 = faces[0]
    a, b, c = verts[f0[0]], verts[f0[1]], verts[f0[2]]
    nrm = (b - a).cross(c - a)
    t0 = math.radians(start)
    centre0 = Vector((math.cos(t0), 0.0, math.sin(t0))) * major
    if nrm.dot(a - centre0) < 0.0:
        faces = [f[::-1] for f in faces]
    return verts, faces, smooth


def hull(points: Iterable[Vec]) -> Prim:
    """Convex hull of a point cloud (flat shaded, coplanar triangles merged)."""
    bm = bmesh.new()
    for p in points:
        bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts), use_existing_faces=False)
    junk = list(dict.fromkeys(g for g in res["geom_interior"] + res["geom_unused"] if isinstance(g, bmesh.types.BMVert)))
    if junk:
        bmesh.ops.delete(bm, geom=junk, context="VERTS")
    bmesh.ops.dissolve_limit(
        bm, angle_limit=math.radians(1.0), verts=list(bm.verts), edges=list(bm.edges)
    )
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    for f in bm.faces:
        f.smooth = False
    return _from_bm(bm)


def icosphere(r: float, subdiv: int = 2) -> Prim:
    """Flat-shaded icosphere (low-poly foliage, knobs)."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    for f in bm.faces:
        f.smooth = False
    return _from_bm(bm)


def flat(poly_xy: Sequence[tuple[float, float]], thickness: float) -> Prim:
    """A 2D outline in the XY plane extruded along +Z from z=0 (wall-mounted shapes)."""
    verts, faces, smooth = prism([(x, -y) for x, y in poly_xy], thickness)
    m = rotate("X", 90.0)
    return [m @ v for v in verts], faces, smooth


def prism_x(poly_zy: Sequence[tuple[float, float]], length: float) -> Prim:
    """A 2D outline given as (z, y) points extruded along X, centred on x = 0."""
    verts, faces, smooth = prism(poly_zy, length)
    # prism space (px, h, pz) -> (h - length/2, pz, px): a cyclic permutation, det = +1
    out = [Vector((v.y - length / 2.0, v.z, v.x)) for v in verts]
    return out, faces, smooth


def segment(p: Vec, q: Vec, width: float, depth: float) -> Prim:
    """A thin bar from p to q (2D points in the XY plane) lying on z in [0, depth]."""
    dx, dy = q[0] - p[0], q[1] - p[1]
    ln = math.hypot(dx, dy)
    verts, faces, smooth = box((ln, width, depth), (0.0, 0.0, depth / 2.0))
    m = translate((p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, 0.0) @ rotate("Z", math.degrees(math.atan2(dy, dx)))
    return [m @ v for v in verts], faces, smooth


def polygon_circle(r: float, segs: int, start_deg: float = 0.0) -> list[tuple[float, float]]:
    return [
        (r * math.cos(math.radians(start_deg) + 2 * math.pi * i / segs),
         r * math.sin(math.radians(start_deg) + 2 * math.pi * i / segs))
        for i in range(segs)
    ]


# --------------------------------------------------------------------------- builder


class MeshBuilder:
    """Accumulates polygons in glTF space with per-face attributes."""

    def __init__(self) -> None:
        self.verts: list[Vector] = []
        self.faces: list[list[int]] = []
        self.color: list[RGB] = []
        self.mat: list[int] = []
        self.smooth: list[bool] = []
        self.bake: list[bool] = []
        self.occlude: list[bool] = []

    def add(
        self,
        prim: Prim,
        *,
        color: RGB,
        mat: int = 0,
        matrix: Matrix | None = None,
        smooth: bool | None = None,
        bake: bool = True,
        occlude: bool = True,
        invert: bool = False,
        face_color: Callable[[int, list[Vector]], RGB] | None = None,
    ) -> MeshBuilder:
        """Append a primitive. `face_color(i, verts)` may override the colour per face;
        `invert` reverses the winding (inside of a shade, open shells)."""
        verts, faces, smooth_flags = prim
        m = matrix if matrix is not None else Matrix.Identity(4)
        flip = (m.to_3x3().determinant() < 0.0) != invert
        base = len(self.verts)
        tv = [m @ v for v in verts]
        self.verts.extend(tv)
        for i, f in enumerate(faces):
            self.faces.append([base + k for k in (f[::-1] if flip else f)])
            if face_color is not None:
                self.color.append(face_color(i, [tv[k] for k in f]))
            else:
                self.color.append(color)
            self.mat.append(mat)
            self.smooth.append(smooth_flags[i] if smooth is None else smooth)
            self.bake.append(bake)
            self.occlude.append(occlude)
        return self

    def extend(self, other: MeshBuilder, matrix: Matrix | None = None) -> MeshBuilder:
        m = matrix if matrix is not None else Matrix.Identity(4)
        flip = m.to_3x3().determinant() < 0.0
        base = len(self.verts)
        self.verts.extend(m @ v for v in other.verts)
        self.faces.extend([[base + k for k in (f[::-1] if flip else f)] for f in other.faces])
        self.color.extend(other.color)
        self.mat.extend(other.mat)
        self.smooth.extend(other.smooth)
        self.bake.extend(other.bake)
        self.occlude.extend(other.occlude)
        return self

    def __len__(self) -> int:
        return len(self.faces)

    def bounds(self) -> tuple[Vector, Vector]:
        lo = Vector((min(v.x for v in self.verts), min(v.y for v in self.verts), min(v.z for v in self.verts)))
        hi = Vector((max(v.x for v in self.verts), max(v.y for v in self.verts), max(v.z for v in self.verts)))
        return lo, hi

    def to_object(
        self,
        name: str,
        materials: Sequence[bpy.types.Material],
        *,
        parent: bpy.types.Object | None = None,
        collection: bpy.types.Collection | None = None,
    ) -> bpy.types.Object:
        """Create the Blender mesh object (Blender space) with a corner colour = albedo."""
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(GLTF_TO_BL @ v) for v in self.verts], [], self.faces)
        me.polygons.foreach_set("use_smooth", self.smooth)
        me.polygons.foreach_set("material_index", self.mat)
        for m in materials:
            me.materials.append(m)
        attr = me.color_attributes.new("Color", "FLOAT_COLOR", "CORNER")
        cols: list[float] = []
        for p, c in zip(me.polygons, self.color):
            cols.extend((c[0], c[1], c[2], 1.0) * p.loop_total)
        attr.data.foreach_set("color", cols)
        me.update()
        ob = bpy.data.objects.new(name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        if parent is not None:
            ob.parent = parent
        return ob
