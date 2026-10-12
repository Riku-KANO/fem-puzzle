"""Scene reset, materials, glTF export and small render helpers."""

from __future__ import annotations

import math
import os
from collections.abc import Iterable, Sequence

import bpy
from mathutils import Vector

from . import png
from .geo import RGB, Vec, srgb_to_linear, to_bl

# --------------------------------------------------------------------------- scene


def reset() -> None:
    """Empty the current file (objects, meshes, materials, lights, cameras, images)."""
    for coll in (
        bpy.data.objects,
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.images,
        bpy.data.curves,
    ):
        for item in list(coll):
            coll.remove(item)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")


def empty(name: str, props: dict | None = None, parent: bpy.types.Object | None = None) -> bpy.types.Object:
    """A glTF node without a mesh (asset roots carry their metadata as `extras`)."""
    ob = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    for k, v in (props or {}).items():
        ob[k] = v
    return ob


def descendants(ob: bpy.types.Object) -> list[bpy.types.Object]:
    out = [ob]
    for c in sorted(ob.children, key=lambda o: o.name):
        out.extend(descendants(c))
    return out


# --------------------------------------------------------------------------- materials


def _color_attr_node(nt: bpy.types.NodeTree) -> bpy.types.Node:
    n = nt.nodes.new("ShaderNodeVertexColor")
    n.layer_name = "Color"
    return n


def mat_unlit(name: str, *, double_sided: bool = False) -> bpy.types.Material:
    """Exported as KHR_materials_unlit; colour = the (baked) vertex colour."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bg = nt.nodes.new("ShaderNodeBackground")
    nt.links.new(_color_attr_node(nt).outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    m.use_backface_culling = not double_sided
    return m


def mat_pbr(
    name: str,
    *,
    metallic: float = 0.0,
    roughness: float = 0.6,
    emission: float = 0.0,
    double_sided: bool = False,
) -> bpy.types.Material:
    """Metal/rough PBR; base colour = vertex colour (albedo x baked AO)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    col = _color_attr_node(nt)
    nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission > 0.0:
        nt.links.new(col.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emission
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    m.use_backface_culling = not double_sided
    return m


# --------------------------------------------------------------------------- export


def export_glb(path: str, roots: Sequence[bpy.types.Object], *, normals: bool = True) -> int:
    """Export the given roots (and their children) to a .glb; returns the file size."""
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for r in roots:
        for ob in descendants(r):
            ob.select_set(True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_extras=True,
        export_yup=True,
        export_apply=False,
        export_normals=normals,
        export_texcoords=False,
        export_tangents=False,
        export_materials="EXPORT",
        export_vertex_color="MATERIAL",
        export_all_vertex_colors=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_draco_mesh_compression_enable=False,
        export_meshopt_compression_enable=False,
        export_image_format="AUTO",  # "NONE" makes the exporter drop COLOR_0 on PBR materials
    )
    return os.path.getsize(path)


# --------------------------------------------------------------------------- rendering


def setup_render(
    width: int,
    height: int,
    *,
    engine: str = "BLENDER_EEVEE",
    transparent: bool = False,
    samples: int = 32,
    world: RGB = (0.05, 0.05, 0.06),
    world_strength: float = 1.0,
) -> bpy.types.Scene:
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = transparent
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 100
    # no date/time/render-time text chunks: keeps re-rendered PNGs byte-identical
    for prop in scene.render.bl_rna.properties:
        if prop.identifier.startswith("use_stamp") and prop.type == "BOOLEAN":
            setattr(scene.render, prop.identifier, False)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"
    if engine == "BLENDER_EEVEE":
        scene.eevee.taa_render_samples = samples
    elif engine == "CYCLES":
        # CPU path tracing with a fixed seed and no denoiser: repeatable output, so
        # re-running the build does not churn the committed PNGs
        c = scene.cycles
        c.device = "CPU"
        c.samples = samples
        c.use_adaptive_sampling = False
        c.use_denoising = False
        c.seed = 0
        c.use_animated_seed = False
        c.max_bounces = 4
    w = scene.world
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (*world, 1.0)
        bg.inputs["Strength"].default_value = world_strength
    return scene


def camera(
    eye: Vec,
    target: Vec,
    *,
    lens: float = 50.0,
    ortho: float | None = None,
) -> bpy.types.Object:
    """Camera at `eye` looking at `target` (glTF-space coordinates)."""
    cam = bpy.data.cameras.new("cam")
    if ortho is not None:
        cam.type = "ORTHO"
        cam.ortho_scale = ortho
    else:
        cam.lens = lens
    cam.clip_start = 0.005
    cam.clip_end = 50.0
    ob = bpy.data.objects.new("cam", cam)
    bpy.context.scene.collection.objects.link(ob)
    e, t = to_bl(eye), to_bl(target)
    ob.location = e
    ob.rotation_euler = (t - e).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = ob
    return ob


def light(
    kind: str,
    *,
    pos: Vec = (0.0, 0.0, 0.0),
    target: Vec | None = None,
    color: RGB = (1.0, 1.0, 1.0),
    energy: float = 1.0,
    size: float = 0.1,
) -> bpy.types.Object:
    """'SUN' | 'AREA' | 'POINT' light; `target` aims SUN/AREA lights (glTF space)."""
    ld = bpy.data.lights.new(f"light_{kind.lower()}", kind)
    ld.color = color
    ld.energy = energy
    if kind == "AREA":
        ld.size = size
    elif kind == "POINT":
        ld.shadow_soft_size = size
    elif kind == "SUN":
        ld.angle = math.radians(size * 10.0)
    ob = bpy.data.objects.new(ld.name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = to_bl(pos)
    if target is not None:
        d = to_bl(target) - to_bl(pos)
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return ob


def render(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene = bpy.context.scene
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    png.strip(path)


def hide_render(objects: Iterable[bpy.types.Object], hidden: bool = True) -> None:
    for ob in objects:
        ob.hide_render = hidden


def srgb3(c: Sequence[float]) -> RGB:
    return (srgb_to_linear(c[0]), srgb_to_linear(c[1]), srgb_to_linear(c[2]))


def fit_distance(size: float, lens: float = 50.0, sensor: float = 36.0, margin: float = 1.15) -> float:
    """Camera distance so that an object of `size` fills the frame width."""
    fov = 2.0 * math.atan(sensor / (2.0 * lens))
    return size * margin / (2.0 * math.tan(fov / 2.0))


def v3(*a: float) -> Vector:
    return Vector(a)
