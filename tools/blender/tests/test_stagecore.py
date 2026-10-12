"""stagecore: codec, canonical JSON, contract validation, rigid-mode and connectivity checks."""

import base64
import unittest

import numpy as np

import stagecore as sc


def sample(grid=(4, 2, 2)):
    """Same stage as the contract tests in crates/stage and packages/protocol."""
    n = sc.element_count(grid)
    keep = np.zeros(n, dtype=bool)
    keep[0] = True
    return {
        "version": 1,
        "id": "t-01",
        "title": "test",
        "world": 1,
        "grid": list(grid),
        "voxelSize": 0.01,
        "material": {"E": 70e9, "nu": 0.33, "allowable": 120e6},
        "solid": sc.encode_bitmask(np.ones(n, dtype=bool)),
        "keep": sc.encode_bitmask(keep),
        "supports": [{"face": "x-", "fix": "xyz"}],
        "loads": [{"cells": [[3, 0, 0], [3, 0, 1]], "force": [0.0, -500.0, 0.0]}],
        "targets": {"star1": 0.7, "star2": 0.55, "star3": 0.45},
        "hints": ["h"],
    }


class BitmaskTest(unittest.TestCase):
    def test_lsb_first_like_the_contract(self):
        bits = [False] * 11
        bits[0] = bits[9] = True
        self.assertEqual(sc.encode_bitmask(bits), base64.b64encode(bytes([1, 2])).decode())
        self.assertEqual(sc.encode_bitmask(bits), "AQI=")  # padded
        self.assertEqual(sc.decode_bitmask("AQI=", 11).tolist(), [int(b) for b in bits])

    def test_length_mismatch_raises(self):
        with self.assertRaises(ValueError):
            sc.decode_bitmask(sc.encode_bitmask([True, False]), 17)

    def test_indexing_inverse(self):
        grid = (5, 3, 4)
        for e in range(60):
            self.assertEqual(sc.element_index(grid, *sc.element_coords(grid, e)), e)
        self.assertEqual(sc.element_index(grid, 1, 2, 3), 1 + 5 * (2 + 3 * 3))
        self.assertEqual(sc.node_index(grid, 1, 2, 3), 1 + 6 * (2 + 4 * 3))


class JsonTest(unittest.TestCase):
    def test_float_layout_matches_serde_json(self):
        # golden values printed by serde_json 1.x (`Value::from(f64)`), see T-103 log
        golden = {
            70e9: "70000000000.0",
            120e6: "120000000.0",
            0.01: "0.01",
            0.33: "0.33",
            -500.0: "-500.0",
            1e-5: "0.00001",
            5e-5: "0.00005",
            1e-7: "1e-7",
            1.5e-7: "1.5e-7",
            1e16: "1e+16",
            1.2345678901234568e17: "1.2345678901234568e+17",
            0.1 + 0.2: "0.30000000000000004",
            2700.0: "2700.0",
            1e15: "1000000000000000.0",
            123456.789: "123456.789",
            0.0: "0.0",
            -0.0: "0.0",
        }
        for v, s in golden.items():
            self.assertEqual(sc.format_float(v), s, repr(v))
        for v in (0.7, 0.55, 0.45, 1 / 3, 6.02e23, 2.5e-300, 9.999999999999999e15):
            self.assertEqual(float(sc.format_float(v)), v)
        with self.assertRaises(ValueError):
            sc.format_float(float("nan"))

    def test_pretty_layout(self):
        out = sc.dumps({"b": [1, [2, 3]], "a": {"y": 1.0, "E": "応力"}, "c": [], "d": {}, "t": True})
        expected = (
            "{\n"
            '  "a": {\n'
            '    "E": "応力",\n'
            '    "y": 1.0\n'
            "  },\n"
            '  "b": [\n'
            "    1,\n"
            "    [\n"
            "      2,\n"
            "      3\n"
            "    ]\n"
            "  ],\n"
            '  "c": [],\n'
            '  "d": {},\n'
            '  "t": true\n'
            "}\n"
        )
        self.assertEqual(out, expected)

    def test_escapes_like_serde(self):
        self.assertEqual(sc.dumps('a"b\\c\n\x01'), '"a\\"b\\\\c\\n\\u0001"\n')


class ValidateTest(unittest.TestCase):
    def test_good_stage(self):
        self.assertEqual(sc.validate_stage(sample()), [])
        self.assertEqual(sc.check_stage(sample()), ([], []))

    def test_rules_mirror_validate_stage(self):
        cases = {
            "unsupported version": lambda s: s.update(version=2),
            "grid dimensions must be positive": lambda s: s.update(grid=[4, 0, 2]),
            "voxelSize must be positive": lambda s: s.update(voxelSize=0.0),
            "material constants out of range": lambda s: s["material"].update(nu=0.5),
            "solid is empty": lambda s: s.update(solid=sc.encode_bitmask(np.zeros(16, bool)), keep=sc.encode_bitmask(np.zeros(16, bool))),
            "keep must be a subset of solid": lambda s: s.update(solid=sc.encode_bitmask(np.arange(16) > 0)),
            "block must not intersect solid": lambda s: s.update(block=sc.encode_bitmask(np.arange(16) == 5)),
            "at least one support is required": lambda s: s.update(supports=[]),
            "bad support fix": lambda s: s["supports"][0].update(fix="xw"),
            "support cell 9,0,0 is not a solid cell": lambda s: s["supports"][0].update(cells=[[9, 0, 0]]),
            "load cell 9,0,1 is not a solid cell": lambda s: s["loads"][0]["cells"].append([9, 0, 1]),
            "load without cells": lambda s: s["loads"][0].update(cells=[]),
            "load case default has no loads": lambda s: s.update(loads=[]),
            "targets must satisfy": lambda s: s["targets"].update(star2=0.8),
            "bytes, expected": lambda s: s.update(keep="AA=="),
        }
        for message, mutate in cases.items():
            s = sample()
            mutate(s)
            errors = sc.validate_stage(s)
            self.assertTrue(any(message in e for e in errors), f"{message!r} not in {errors}")

    def test_load_cases_replace_loads(self):
        s = sample()
        s["loadCases"] = [{"name": "a", "loads": [{"cells": [[9, 9, 9]], "force": [1.0, 0.0, 0.0]}]}]
        self.assertTrue(any("load cell 9,9,9" in e for e in sc.validate_stage(s)))


class MechanicsTest(unittest.TestCase):
    def beam(self, supports, grid=(8, 2, 3)):
        s = sample(grid)
        s["keep"] = sc.encode_bitmask(np.zeros(sc.element_count(grid), bool))
        s["supports"] = supports
        nx, ny, nz = grid
        s["loads"] = [{"cells": [[nx // 2, ny - 1, z] for z in range(nz)], "force": [0.0, -100.0, 0.0]}]
        return s

    def strip(self, x0, x1, nz=3):
        return [[x, 0, z] for z in range(nz) for x in range(x0, x1)]

    def test_clamped_face_removes_all_modes(self):
        s = self.beam([{"face": "x-", "fix": "xyz"}])
        rank, free = sc.free_rigid_modes(s, np.ones(48, np.uint8))
        self.assertEqual((rank, free), (6, []))

    def test_pin_and_roller_remove_all_modes(self):
        s = self.beam([
            {"face": "y-", "fix": "xyz", "cells": self.strip(0, 1)},
            {"face": "y-", "fix": "y", "cells": self.strip(7, 8)},
        ])
        self.assertEqual(sc.check_stage(s)[0], [])

    def test_only_roller_fails(self):
        s = self.beam([{"face": "y-", "fix": "y", "cells": self.strip(0, 8)}])
        rank, free = sc.free_rigid_modes(s, np.ones(48, np.uint8))
        self.assertEqual(rank, 3)  # ty, rx, rz fixed; tx, tz, ry free
        self.assertEqual(len(free), 3)
        errors, _ = sc.check_stage(s)
        self.assertTrue(any("rigid-body modes" in e for e in errors), errors)

    def test_two_rollers_fail(self):
        s = self.beam([
            {"face": "y-", "fix": "y", "cells": self.strip(0, 1)},
            {"face": "y-", "fix": "y", "cells": self.strip(7, 8)},
        ])
        self.assertTrue(any("rigid-body modes" in e for e in sc.check_stage(s)[0]))

    def test_collinear_fixed_nodes_leave_rotation_free(self):
        # a cell face is a 2x2 node patch, so even one pinned cell is not collinear ...
        s = self.beam([{"face": "x-", "fix": "xyz", "cells": [[0, 0, 0]]}], grid=(4, 1, 1))
        s["loads"] = [{"cells": [[3, 0, 0]], "force": [0.0, -1.0, 0.0]}]
        rank, _ = sc.free_rigid_modes(s, np.ones(4, np.uint8))
        self.assertEqual(rank, 6)
        # ... but xyz on a single line of nodes leaves the rotation about that line free
        dofs = [((0, 0, k), c) for k in range(3) for c in range(3)]
        self.assertEqual(int(np.linalg.matrix_rank(sc.rigid_mode_matrix(dofs))), 5)

    def test_disconnected_solid_fails(self):
        grid = (5, 1, 1)
        s = self.beam([{"face": "x-", "fix": "xyz"}], grid=grid)
        s["solid"] = sc.encode_bitmask([1, 1, 0, 1, 1])
        s["loads"] = [{"cells": [[4, 0, 0], [3, 0, 0]], "force": [0.0, -1.0, 0.0]}]
        errors, _ = sc.check_stage(s)
        self.assertTrue(any("2 6-connected components" in e for e in errors), errors)

    def test_support_face_must_be_exposed(self):
        s = self.beam([{"face": "y+", "fix": "xyz", "cells": [[0, 0, 0]]}])  # y+ of a bottom cell is internal
        errors, _ = sc.check_stage(s)
        self.assertTrue(any("not on the solid boundary" in e for e in errors), errors)

    def test_zero_force_and_single_cell_warning(self):
        s = sample()
        s["loads"][0]["force"] = [0.0, 0.0, 0.0]
        self.assertTrue(any("force is zero" in e for e in sc.check_stage(s)[0]))
        s = sample()
        s["loads"][0]["cells"] = [[3, 0, 0]]
        errors, warnings = sc.check_stage(s)
        self.assertEqual(errors, [])
        self.assertTrue(any("single-cell" in w for w in warnings))

    def test_axis_conversion_roundtrip(self):
        self.assertEqual(sc.blender_to_stage((1.0, 2.0, 3.0)), (1.0, 3.0, -2.0))
        self.assertEqual(sc.stage_to_blender((1.0, 3.0, -2.0)), (1.0, 2.0, 3.0))
        for v in [(0.1, -0.2, 0.3), (5.0, 0.0, -7.5)]:
            self.assertEqual(sc.stage_to_blender(sc.blender_to_stage(v)), v)


if __name__ == "__main__":
    unittest.main()
