"""Deterministic CPU light baking into the corner colour attribute.

The static environment (bench, room) is rendered unlit in the game, so its lighting is
computed here: ambient light with ray-traced ambient occlusion, soft-shadowed point lights
(the pendant lamp, ceiling tubes) and directional lights (sun / sky through the window).
Jigs and debris are lit at runtime; they only get a mild AO term multiplied into their
albedo. Everything uses fixed sample patterns (no RNG state), so builds are reproducible.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .geo import RGB, MeshBuilder, Vec, to_bl

Pair = tuple[bpy.types.Object, MeshBuilder]

EPS = 2.0e-4  # ray origin offset along the normal (m)


@dataclass
class PointLight:
    pos: Vec  # glTF space
    color: RGB
    power: float
    size: float = 0.04  # soft-shadow radius (m)
    soft: float = 0.05  # added to d^2 (avoids hot spots right under the lamp)
    samples: int = 5  # shadow rays (1 = hard shadow from the centre)


@dataclass
class DirLight:
    direction: Vec  # towards the light, glTF space
    color: RGB
    power: float
    shadow: bool = True
    wrap: float = 0.0  # half-lambert style wrap, 0 = plain lambert
    spread: float = 0.02  # soft-shadow cone (radians-ish)


@dataclass
class Lighting:
    ambient: RGB
    ao_distance: float = 0.5
    ao_samples: int = 32
    ao_strength: float = 1.0
    knee: float = 0.65  # tone curve: linear below, soft-clipped to 1.0 above
    exposure: float = 1.0
    points: list[PointLight] = field(default_factory=list)
    dirs: list[DirLight] = field(default_factory=list)


def _hemisphere(n: int) -> list[tuple[float, float, float]]:
    """Cosine-weighted hemisphere directions (z up), golden-angle spiral."""
    golden = math.pi * (3.0 - math.sqrt(5.0))
    out = []
    for i in range(n):
        u = (i + 0.5) / n
        r = math.sqrt(u)
        t = golden * i
        out.append((r * math.cos(t), r * math.sin(t), math.sqrt(max(0.0, 1.0 - u))))
    return out


# 4 jitter offsets for soft shadows (tetrahedron) + centre
_JITTER = [
    (0.0, 0.0, 0.0),
    (1.0, 1.0, 1.0),
    (1.0, -1.0, -1.0),
    (-1.0, 1.0, -1.0),
    (-1.0, -1.0, 1.0),
]


def _frame(n: Vector) -> tuple[Vector, Vector]:
    a = Vector((1.0, 0.0, 0.0)) if abs(n.x) < 0.9 else Vector((0.0, 1.0, 0.0))
    t = n.cross(a).normalized()
    return t, n.cross(t)


def _angle(i: int) -> float:
    return ((i * 2654435761) % 4294967296) / 4294967296.0 * 2.0 * math.pi


def build_bvh(pairs: Sequence[Pair]) -> BVHTree:
    verts: list[Vector] = []
    tris: list[tuple[int, int, int]] = []
    for ob, b in pairs:
        me = ob.data
        me.calc_loop_triangles()
        base = len(verts)
        mw = ob.matrix_world
        verts.extend(mw @ v.co for v in me.vertices)
        for t in me.loop_triangles:
            if b.occlude[t.polygon_index]:
                tris.append((base + t.vertices[0], base + t.vertices[1], base + t.vertices[2]))
    return BVHTree.FromPolygons(verts, tris, all_triangles=True)


def _ao(bvh: BVHTree, o: Vector, n: Vector, dirs, dist: float, rot: float) -> float:
    t, b = _frame(n)
    c, s = math.cos(rot), math.sin(rot)
    occl = 0.0
    for x, y, z in dirs:
        xr, yr = x * c - y * s, x * s + y * c
        d = t * xr + b * yr + n * z
        hit = bvh.ray_cast(o, d, dist)
        if hit[0] is not None:
            occl += 1.0 - hit[3] / dist
    return 1.0 - occl / len(dirs)


def _soft(x: float, knee: float) -> float:
    if x <= knee:
        return max(x, 0.0)
    return knee + (1.0 - knee) * (1.0 - math.exp(-(x - knee) / (1.0 - knee)))


def bake_lighting(targets: Sequence[Pair], occluders: Sequence[Pair], lighting: Lighting) -> None:
    """Replace each target's corner colour (albedo) by albedo * baked lighting."""
    bvh = build_bvh(occluders)
    dirs = _hemisphere(lighting.ao_samples)
    pts = [(to_bl(p.pos), p) for p in lighting.points]
    dls = [(to_bl(d.direction).normalized(), d) for d in lighting.dirs]
    amb = Vector(lighting.ambient)

    def irradiance(p: Vector, n: Vector, key: int) -> Vector:
        o = p + n * EPS
        e = amb * (1.0 - lighting.ao_strength * (1.0 - _ao(bvh, o, n, dirs, lighting.ao_distance, _angle(key))))
        for pos, pl in pts:
            to_l = pos - p
            d2 = to_l.length_squared
            ndl = n.dot(to_l.normalized())
            if ndl <= 0.0:
                continue
            vis = 0.0
            jit = _JITTER[: max(1, min(pl.samples, len(_JITTER)))]
            for j in jit:
                target = pos + Vector(j) * (pl.size * 0.577)
                ray = target - o
                ln = ray.length
                hit = bvh.ray_cast(o, ray / ln, ln - 1e-3)
                if hit[0] is None:
                    vis += 1.0
            vis /= len(jit)
            e += Vector(pl.color) * (pl.power * ndl * vis / (d2 + pl.soft))
        for ld, dl in dls:
            ndl = (n.dot(ld) + dl.wrap) / (1.0 + dl.wrap)
            if ndl <= 0.0:
                continue
            vis = 1.0
            if dl.shadow:
                vis = 0.0
                t, b = _frame(ld)
                for jx, jy, _ in _JITTER:
                    d = (ld + (t * jx + b * jy) * dl.spread).normalized()
                    if bvh.ray_cast(o, d, 30.0)[0] is None:
                        vis += 1.0
                vis /= len(_JITTER)
            e += Vector(dl.color) * (dl.power * ndl * vis)
        return e

    for ob, b in targets:
        me = ob.data
        mw = ob.matrix_world
        rot = mw.to_3x3()
        normals = [0.0] * (len(me.loops) * 3)
        me.corner_normals.foreach_get("vector", normals)
        attr = me.color_attributes["Color"]
        cols = [0.0] * (len(me.loops) * 4)
        attr.data.foreach_get("color", cols)
        cache: dict[tuple[int, int, int, int], Vector] = {}
        loop_vert = [0] * len(me.loops)
        me.loops.foreach_get("vertex_index", loop_vert)
        for poly in me.polygons:
            if not b.bake[poly.index]:
                continue
            for li in poly.loop_indices:
                vi = loop_vert[li]
                n = (rot @ Vector(normals[3 * li : 3 * li + 3])).normalized()
                key = (vi, round(n.x * 500), round(n.y * 500), round(n.z * 500))
                e = cache.get(key)
                if e is None:
                    e = irradiance(mw @ me.vertices[vi].co, n, vi)
                    cache[key] = e
                for c in range(3):
                    cols[4 * li + c] = _soft(cols[4 * li + c] * e[c] * lighting.exposure, lighting.knee)
        attr.data.foreach_set("color", cols)
        me.update()


def bake_ao(targets: Sequence[Pair], *, distance: float, strength: float, samples: int = 24) -> None:
    """Multiply albedo by a mild self-AO term (for runtime-lit assets)."""
    dirs = _hemisphere(samples)
    for ob, b in targets:
        bvh = build_bvh([(ob, b)])
        me = ob.data
        normals = [0.0] * (len(me.loops) * 3)
        me.corner_normals.foreach_get("vector", normals)
        attr = me.color_attributes["Color"]
        cols = [0.0] * (len(me.loops) * 4)
        attr.data.foreach_get("color", cols)
        loop_vert = [0] * len(me.loops)
        me.loops.foreach_get("vertex_index", loop_vert)
        cache: dict[tuple[int, int, int, int], float] = {}
        for poly in me.polygons:
            if not b.bake[poly.index]:
                continue
            for li in poly.loop_indices:
                vi = loop_vert[li]
                n = Vector(normals[3 * li : 3 * li + 3]).normalized()
                key = (vi, round(n.x * 500), round(n.y * 500), round(n.z * 500))
                a = cache.get(key)
                if a is None:
                    p = me.vertices[vi].co
                    a = _ao(bvh, p + n * EPS, n, dirs, distance, _angle(vi))
                    cache[key] = a
                k = 1.0 - strength * (1.0 - a)
                for c in range(3):
                    cols[4 * li + c] *= k
        attr.data.foreach_set("color", cols)
        me.update()
