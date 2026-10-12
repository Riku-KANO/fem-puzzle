"""Scene → stage: voxel counts, axis conversion, role objects, CLI on .py sources and .blend files."""

import json
import math
import os
import shutil
import subprocess
import tempfile
import unittest

import bpy
import numpy as np

import stagecore as sc
import stagekit as sk
import voxelize

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(TOOLS))
EXPORTER = os.path.join(TOOLS, "export_stage.py")
SOURCES = os.path.join(ROOT, "stages", "src")


def props(h=0.01, **kw):
    sk.stage_props(id=kw.pop("id", "t-01"), title="テスト", world=1, voxel_size=h, hints=["h"], **kw)


def mask(stage, key):
    return sc.decode_bitmask(stage[key], sc.element_count(stage["grid"]))


def raw_box(name, lo, hi):
    """Closed box from Blender-space corners, built without stagekit."""
    xs, ys, zs = zip(lo, hi)
    verts = [(x, y, z) for x in xs for y in ys for z in zs]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def run_exporter(*args):
    cmd = [bpy.app.binary_path, "-b", "--factory-startup", "--python-exit-code", "1", *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


class SceneTest(unittest.TestCase):
    def setUp(self):
        sk.reset()

    def build(self):
        built = voxelize.voxelize_scene()
        errors, _ = sc.check_stage(built.stage)
        return built.stage, errors


class VoxelCountTest(SceneTest):
    def test_box_voxel_count_exact(self):
        for h, size in [(0.01, (5, 3, 2)), (0.007, (7, 5, 3)), (0.01, (24, 8, 4)), (0.01, (32, 8, 8))]:
            sk.reset()
            props(h=h)
            sk.domain_box((0, 0, 0), size)
            sk.support("wall", (0, 0, 0), (1, size[1], size[2]), face="x-", whole_face=True)
            sk.load("tip", (size[0] - 1, size[1] - 1, 0), (size[0], size[1], size[2]), force=(0, -1, 0))
            for obj in bpy.context.scene.objects:  # absolute placement must not matter
                obj.location.x += 0.1234
                obj.location.y -= 0.567
            stage, errors = self.build()
            self.assertEqual(errors, [])
            self.assertEqual(stage["grid"], list(size))
            self.assertEqual(int(mask(stage, "solid").sum()), size[0] * size[1] * size[2])
            self.assertEqual(stage["loads"][0]["cells"], [[size[0] - 1, size[1] - 1, z] for z in range(size[2])])

    def test_union_of_domains_and_block(self):
        props()
        sk.domain_box((0, 0, 0), (6, 2, 2), name="domain_floor")
        sk.domain_box((0, 0, 0), (2, 6, 2), name="domain_wall")  # L-shape, overlaps 2x2x2
        sk.block("hole", (3, 0, 0), (4, 2, 2))
        sk.support("base", (0, 0, 0), (2, 1, 2), face="y-")
        sk.load("top", (0, 5, 0), (2, 6, 2), force=(10, 0, 0))
        stage, errors = self.build()
        self.assertEqual(stage["grid"], [6, 6, 2])
        self.assertEqual(int(mask(stage, "block").sum()), 4)
        self.assertEqual(int(mask(stage, "solid").sum()), 6 * 2 * 2 + 2 * 4 * 2 - 4)
        self.assertTrue(any("2 6-connected components" in e for e in errors), errors)  # the block cuts the floor


class AxisTest(SceneTest):
    def test_blender_z_up_maps_to_stage_y_up(self):
        props()
        # Blender x 4 cells, y 2 cells (towards -y), z 3 cells → stage grid [4, 3, 2]
        raw_box("domain", (0.0, -0.02, 0.0), (0.04, 0.0, 0.03))
        # stage cell (3, 2, 1): centre (0.035, 0.025, 0.015) → Blender (0.035, -0.015, 0.025)
        c = sc.stage_to_blender((0.035, 0.025, 0.015))
        self.assertEqual(c, (0.035, -0.015, 0.025))
        raw_box("keep_marker", tuple(v - 0.002 for v in c), tuple(v + 0.002 for v in c))
        raw_box("support_floor", (0.0, -0.02, 0.0), (0.04, 0.0, 0.01))  # Blender bottom = stage y-
        bpy.data.objects["support_floor"]["face"] = "y-"
        bpy.data.objects["support_floor"]["fix"] = "zyx"  # canonicalised to "xyz"
        raw_box("load_top", (0.03, -0.02, 0.02), (0.04, 0.0, 0.03))
        bpy.data.objects["load_top"]["force"] = [1.0, 2.0, 3.0]  # stage axes, passed through
        stage, errors = self.build()
        self.assertEqual(errors, [])
        self.assertEqual(stage["grid"], [4, 3, 2])
        self.assertEqual(np.flatnonzero(mask(stage, "keep")).tolist(), [sc.element_index([4, 3, 2], 3, 2, 1)])
        self.assertEqual(stage["supports"][0]["fix"], "xyz")
        self.assertEqual(stage["supports"][0]["cells"], [[x, 0, z] for z in range(2) for x in range(4)])
        self.assertEqual(stage["loads"][0], {"cells": [[3, 2, 0], [3, 2, 1]], "force": [1.0, 2.0, 3.0]})

    def test_stagekit_boxes_round_trip(self):
        props()
        sk.domain_box((0, 0, 0), (4, 3, 2))
        sk.keep("k", (1, 2, 1), (2, 3, 2))
        sk.support("s", (0, 0, 0), (4, 1, 2), face="y-")
        sk.load("l", (3, 2, 0), (4, 3, 2), force=(0, -1, 0))
        stage, errors = self.build()
        self.assertEqual(errors, [])
        self.assertEqual(np.flatnonzero(mask(stage, "keep")).tolist(), [sc.element_index([4, 3, 2], 1, 2, 1)])
        # stage +y is Blender +z, stage +z is Blender -y
        k = bpy.data.objects["keep_k"]
        self.assertAlmostEqual(k.location.z, 0.025)
        self.assertAlmostEqual(k.location.y, -0.015)


class RulesTest(SceneTest):
    def test_only_roller_fails_rigid_mode_check(self):
        props()
        sk.domain_box((0, 0, 0), (8, 2, 3))
        sk.support("roller", (0, 0, 0), (8, 1, 3), face="y-", fix="y")
        sk.load("mid", (3, 1, 0), (5, 2, 3), force=(0, -100, 0))
        _, errors = self.build()
        self.assertTrue(any("rigid-body modes free (rank 3 < 6)" in e for e in errors), errors)

    def test_open_mesh_is_rejected(self):
        props()
        dom = sk.domain_box((0, 0, 0), (2, 2, 2))
        import bmesh

        bm = bmesh.new()
        bm.from_mesh(dom.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[0]], context="FACES_ONLY")
        bm.to_mesh(dom.data)
        bm.free()
        with self.assertRaisesRegex(voxelize.StageBuildError, "not closed"):
            voxelize.voxelize_scene()

    def test_whole_face_support_must_lie_on_its_face(self):
        props()
        sk.domain_box((0, 0, 0), (4, 2, 2))
        sk.support("wall", (3, 0, 0), (4, 2, 2), face="x-", whole_face=True)
        sk.load("l", (3, 1, 0), (4, 2, 2), force=(0, -1, 0))
        with self.assertRaisesRegex(voxelize.StageBuildError, "boundary layer"):
            voxelize.voxelize_scene()

    def test_marker_outside_the_grid_is_rejected(self):
        props()
        sk.domain_box((0, 0, 0), (4, 2, 2))
        sk.support("wall", (0, 0, 0), (1, 2, 2), face="x-", whole_face=True)
        sk.load("away", (10, 0, 0), (11, 1, 1), force=(0, -1, 0))
        with self.assertRaisesRegex(voxelize.StageBuildError, "contains no cell centre"):
            voxelize.voxelize_scene()

    def test_load_in_block_fails_validation(self):
        props()
        sk.domain_box((0, 0, 0), (4, 2, 2))
        sk.block("b", (3, 0, 0), (4, 1, 2))
        sk.support("wall", (0, 0, 0), (1, 2, 2), face="x-", whole_face=True)
        sk.load("l", (3, 0, 0), (4, 2, 2), force=(0, -1, 0))
        _, errors = self.build()
        self.assertTrue(any("load cell 3,0,0 is not a solid cell" in e for e in errors), errors)


class ExporterCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="t103-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        sk.reset()

    def test_source_rejected_without_output(self):
        src = os.path.join(self.tmp, "bad-01.py")
        with open(src, "w", encoding="utf-8") as f:
            f.write(
                "import stagekit as sk\n"
                "sk.stage_props(id='bad-01', title='x', world=1, hints=['h'])\n"
                "sk.domain_box((0, 0, 0), (8, 2, 3))\n"
                "sk.support('roller', (0, 0, 0), (8, 1, 3), face='y-', fix='y')\n"
                "sk.load('mid', (3, 1, 0), (5, 2, 3), force=(0, -100, 0))\n"
            )
        out = os.path.join(self.tmp, "out")
        r = run_exporter("-P", EXPORTER, "--", "--source", src, "--out", out, "--expect-id", "bad-01")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("rigid-body modes", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(out, "bad-01.json")))

    def test_expect_id_mismatch_fails(self):
        r = run_exporter("-P", EXPORTER, "--", "--source", os.path.join(SOURCES, "w1-01.py"), "--expect-id", "w9-99")
        self.assertEqual(r.returncode, 1)
        self.assertIn("!= expected 'w9-99'", r.stdout)

    def test_hand_made_blend(self):
        """A .blend authored by hand (bpy.ops primitives, rotation/scale, props typed in) exports
        the same JSON as the equivalent stagekit source."""
        sk.reset()
        scene = bpy.context.scene
        scene["stage_id"] = "hm-01"
        scene["title"] = "手作り"
        scene["world"] = 1
        scene["voxel_size"] = 0.01
        scene["material_E"] = 70e9
        scene["material_nu"] = 0.33
        scene["material_allowable"] = 120e6
        scene["targets"] = [0.7, 0.55, 0.45]
        scene["hints"] = ["h"]
        # domain: stage 6 x 4 x 2 cells → Blender 0.06 (x) x 0.02 (y) x 0.04 (z), anywhere
        bpy.ops.mesh.primitive_cube_add(size=1, location=(1.03, 2.0 - 0.01, 3.02), scale=(0.06, 0.02, 0.04))
        bpy.context.active_object.name = "domain"
        # wall marker on stage x- layer, as a cube rotated 90° about Blender Z (dims swapped)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(1.005, 1.99, 3.02), rotation=(0, 0, math.pi / 2), scale=(0.02, 0.01, 0.04))
        wall = bpy.context.active_object
        wall.name = "support_wall"
        wall["face"], wall["fix"], wall["whole_face"] = "x-", "xyz", True
        # load on the top of the free end: stage cells x=5, y=3, z=0..1
        bpy.ops.mesh.primitive_cube_add(size=1, location=(1.055, 1.99, 3.035), scale=(0.01, 0.02, 0.01))
        load = bpy.context.active_object
        load.name = "load_tip"
        load["force"] = [0, -100, 0]  # ints typed by hand → floats in JSON
        # keep: stage cell (2, 1, 1) → centre (0.025, 0.015, 0.015) → Blender offset (0.025, -0.015, 0.015)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.004, location=(1.025, 2.0 - 0.015, 3.015))
        bpy.context.active_object.name = "keep_ball"
        blend = os.path.join(self.tmp, "hm-01.blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend, check_existing=False)

        out = os.path.join(self.tmp, "out")
        r = run_exporter(blend, "-P", EXPORTER, "--", "--out", out, "--expect-id", "hm-01")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(os.path.join(out, "hm-01.json"), encoding="utf-8") as f:
            text = f.read()
        stage = json.loads(text)
        self.assertEqual(stage["grid"], [6, 4, 2])
        self.assertEqual(int(mask(stage, "solid").sum()), 48)
        self.assertEqual(stage["supports"], [{"face": "x-", "fix": "xyz"}])
        self.assertEqual(stage["loads"], [{"cells": [[5, 3, 0], [5, 3, 1]], "force": [0.0, -100.0, 0.0]}])
        self.assertEqual(np.flatnonzero(mask(stage, "keep")).tolist(), [sc.element_index([6, 4, 2], 2, 1, 1)])

        # the same stage written as a stagekit source gives byte-identical JSON
        src = os.path.join(self.tmp, "hm-01.py")
        with open(src, "w", encoding="utf-8") as f:
            f.write(
                "import stagekit as sk\n"
                "sk.stage_props(id='hm-01', title='手作り', world=1, hints=['h'],\n"
                "               material=dict(E=70e9, nu=0.33, allowable=120e6))\n"
                "sk.domain_box((0, 0, 0), (6, 4, 2))\n"
                "sk.support('wall', (0, 0, 0), (1, 4, 2), face='x-', whole_face=True)\n"
                "sk.load('tip', (5, 3, 0), (6, 4, 2), force=(0, -100, 0))\n"
                "sk.keep('ball', (2, 1, 1), (3, 2, 2))\n"
            )
        out2 = os.path.join(self.tmp, "out2")
        r = run_exporter("-P", EXPORTER, "--", "--source", src, "--out", out2)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(os.path.join(out2, "hm-01.json"), encoding="utf-8") as f:
            self.assertEqual(f.read(), text)


class StarterStagesTest(unittest.TestCase):
    EXPECTED = {  # id: (grid, solid, keep, block, supports, loads)
        "w1-01": ([24, 8, 4], 768, 0, 0, 1, 1),
        "w1-02": ([24, 8, 4], 768, 0, 0, 1, 1),
        "w1-03": ([24, 8, 4], 768, 64, 0, 1, 1),
        "w2-01": ([32, 5, 8], 1280, 0, 0, 2, 1),  # shallow beam since T-305
        "w2-02": ([32, 8, 8], 2048, 0, 0, 2, 2),
        "w2-03": ([32, 8, 8], 1536, 0, 512, 2, 1),
    }

    def test_sources_build_deterministically(self):
        import export_stage

        for sid, (grid, solid, keep, block, nsup, nload) in self.EXPECTED.items():
            texts = []
            for _ in range(2):
                export_stage.run_source(os.path.join(SOURCES, f"{sid}.py"))
                stage, _, errors, warnings = export_stage.build(expect_id=sid)
                self.assertEqual((errors, warnings), ([], []), sid)
                texts.append(sc.dumps(stage))
            self.assertEqual(texts[0], texts[1], sid)
            self.assertEqual(stage["grid"], grid, sid)
            self.assertEqual(int(mask(stage, "solid").sum()), solid, sid)
            self.assertEqual(int(mask(stage, "keep").sum()), keep, sid)
            self.assertEqual(int(mask(stage, "block").sum()) if "block" in stage else 0, block, sid)
            self.assertEqual((len(stage["supports"]), len(stage["loads"])), (nsup, nload), sid)
            self.assertTrue(1 <= len(stage["hints"]) <= 3, sid)
            for ld in stage["loads"]:
                self.assertGreaterEqual(len(ld["cells"]), 8, f"{sid}: loads are spread over a strip")
        sk.reset()


if __name__ == "__main__":
    unittest.main()
