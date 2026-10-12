"""Stage format core: bitmask codec, canonical JSON, validation and mechanics checks.

Pure Python + numpy (no ``bpy``), so it is importable both inside Blender and from a
plain interpreter. Normative spec: ``docs/specs/stage-format.md``.

``validate_stage`` mirrors ``validateStage`` (packages/protocol/src/stage.ts) and
``Stage::validate`` (crates/stage) rule for rule; ``check_stage`` adds exporter-only
checks (rigid-body modes, connectivity, support faces, ...).

Canonical JSON (``dumps``) is byte-identical to Rust's
``serde_json::to_string_pretty(&serde_json::Value)`` + ``"\\n"``: keys sorted (serde_json's
default ``Map`` is a ``BTreeMap``), two-space indent, floats formatted like serde_json
(``70000000000.0``, ``0.01``, ``0.00001``, ``1e-7``, ``1e+16``), non-ASCII text unescaped. Fields that are ``f64``
in ``crates/stage`` are always written as floats, ``usize`` fields as integers, so a
Rust tool can round-trip a stage through ``serde_json::Value`` without a diff.
"""

from __future__ import annotations

import base64
import json
import math
import re
from collections import deque
from typing import Any, Iterable, Sequence

import numpy as np

FORMAT_VERSION = 1
FACES = ("x-", "x+", "y-", "y+", "z-", "z+")
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")

Cell = tuple[int, int, int]

# ---------------------------------------------------------------------------
# Axes. Blender is Z-up, stages are Y-up (glTF): stage (x, y, z) = Blender (x, z, -y).


def blender_to_stage(v: Sequence[float]) -> tuple[float, float, float]:
    return (float(v[0]), float(v[2]), -float(v[1]))


def stage_to_blender(v: Sequence[float]) -> tuple[float, float, float]:
    return (float(v[0]), -float(v[2]), float(v[1]))


# ---------------------------------------------------------------------------
# Indexing


def element_count(grid: Sequence[int]) -> int:
    return int(grid[0]) * int(grid[1]) * int(grid[2])


def element_index(grid: Sequence[int], x: int, y: int, z: int) -> int:
    """e = x + nx * (y + ny * z)"""
    return x + grid[0] * (y + grid[1] * z)


def element_coords(grid: Sequence[int], e: int) -> Cell:
    nx, ny = grid[0], grid[1]
    return (e % nx, (e // nx) % ny, e // (nx * ny))


def node_index(grid: Sequence[int], i: int, j: int, k: int) -> int:
    """n = i + (nx+1) * (j + (ny+1) * k)"""
    return i + (grid[0] + 1) * (j + (grid[1] + 1) * k)


# ---------------------------------------------------------------------------
# Bitmask codec: bit e lives in byte e >> 3 at position e & 7 (LSB first), base64 with padding.


def encode_bitmask(bits: Iterable[bool] | np.ndarray) -> str:
    arr = np.asarray(bits, dtype=bool).ravel()
    packed = np.packbits(arr, bitorder="little")
    return base64.b64encode(packed.tobytes()).decode("ascii")


def decode_bitmask(mask: str, n: int) -> np.ndarray:
    """0/1 flags (uint8) of length n. Raises ValueError on a length mismatch."""
    raw = base64.b64decode(mask, validate=True)
    expected = (n + 7) // 8
    if len(raw) != expected:
        raise ValueError(f"bitmask has {len(raw)} bytes, expected {expected} for {n} elements")
    bits = np.unpackbits(np.frombuffer(raw, dtype=np.uint8), bitorder="little")
    return bits[:n].astype(np.uint8)


# ---------------------------------------------------------------------------
# Canonical JSON


def format_float(v: float) -> str:
    """Format an f64 exactly like serde_json (ryu digits).

    Python's ``repr`` and ryu both produce the shortest round-tripping digits; only the
    layout differs (serde_json: decimal notation for 1e-5 <= |v| < 1e16, otherwise
    ``1.5e-7`` / ``1e+16``). Golden values checked against serde_json 1.x in the tests.
    """
    v = float(v)
    if not math.isfinite(v):
        raise ValueError(f"non-finite number {v!r} cannot be written to JSON")
    if v == 0.0:
        return "0.0"  # also normalises -0.0
    r = repr(v)
    sign = ""
    if r.startswith("-"):
        sign, r = "-", r[1:]
    mant, _, exp_s = r.partition("e")
    exp = int(exp_s) if exp_s else 0
    int_part, _, frac_part = mant.partition(".")
    digits = (int_part + frac_part).lstrip("0")
    point = exp - len(frac_part)  # value = int(int_part + frac_part) * 10**point
    stripped = digits.rstrip("0")
    point += len(digits) - len(stripped)
    digits = stripped  # value = int(digits) * 10**point, no trailing zeros
    length = len(digits)
    kk = length + point  # 10**(kk-1) <= value < 10**kk
    if 0 <= point and kk <= 16:
        out = digits + "0" * point + ".0"
    elif 0 < kk <= 16:
        out = digits[:kk] + "." + digits[kk:]
    elif -5 < kk <= 0:
        out = "0." + "0" * (-kk) + digits
    else:
        e = kk - 1
        mantissa = digits if length == 1 else f"{digits[0]}.{digits[1:]}"
        out = f"{mantissa}e{'+' if e >= 0 else ''}{e}"  # serde_json writes 1e+16, 1e-7
    return sign + out


def _dump(v: Any, depth: int) -> str:
    pad = "  " * (depth + 1)
    end = "  " * depth
    if isinstance(v, dict):
        if not v:
            return "{}"
        keys = sorted(v)
        for k in keys:
            if not isinstance(k, str):
                raise TypeError(f"JSON object keys must be strings, got {k!r}")
        items = [f"{pad}{json.dumps(k, ensure_ascii=False)}: {_dump(v[k], depth + 1)}" for k in keys]
        return "{\n" + ",\n".join(items) + "\n" + end + "}"
    if isinstance(v, (list, tuple)):
        if not v:
            return "[]"
        return "[\n" + ",\n".join(pad + _dump(x, depth + 1) for x in v) + "\n" + end + "]"
    if isinstance(v, (bool, np.bool_)):
        return "true" if v else "false"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    if isinstance(v, (float, np.floating)):
        return format_float(float(v))
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if v is None:
        return "null"
    raise TypeError(f"cannot write {type(v).__name__} to stage JSON")


def dumps(obj: Any) -> str:
    """Canonical stage JSON (sorted keys, 2-space indent, ryu floats, trailing newline)."""
    return _dump(obj, 0) + "\n"


# ---------------------------------------------------------------------------
# Validation mirroring validateStage (TS) / Stage::validate (Rust)


def stage_cases(stage: dict) -> list[dict]:
    """``loadCases`` if present and non-empty, otherwise ``loads`` as one case."""
    cases = stage.get("loadCases")
    if cases:
        return list(cases)
    return [{"name": "default", "loads": stage.get("loads", [])}]


def _positive(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0


def _cell_str(c: Sequence[int]) -> str:
    return ",".join(str(v) for v in c)


def validate_stage(stage: dict) -> list[str]:
    """Contract validation. Returns problems (empty = valid); same rules as validateStage."""
    errors: list[str] = []
    if stage.get("version") != FORMAT_VERSION:
        errors.append(f"unsupported version {stage.get('version')}")
    grid = stage.get("grid")
    if not (isinstance(grid, (list, tuple)) and len(grid) == 3 and all(isinstance(g, int) and g > 0 for g in grid)):
        return [*errors, "grid dimensions must be positive"]
    nx, ny, nz = grid
    if not _positive(stage.get("voxelSize")):
        errors.append("voxelSize must be positive")
    m = stage.get("material", {})
    nu = m.get("nu")
    if not _positive(m.get("E")) or not _positive(m.get("allowable")) or not (isinstance(nu, (int, float)) and -1 < nu < 0.5):
        errors.append("material constants out of range")
    n = element_count(grid)
    try:
        solid = decode_bitmask(stage["solid"], n)
        keep = decode_bitmask(stage["keep"], n)
    except (KeyError, ValueError, TypeError) as e:
        return [*errors, str(e)]
    if not solid.any():
        errors.append("solid is empty")
    if np.any((keep == 1) & (solid == 0)):
        errors.append("keep must be a subset of solid")
    if "block" in stage:
        try:
            block = decode_bitmask(stage["block"], n)
            if np.any((block == 1) & (solid == 1)):
                errors.append("block must not intersect solid")
        except (ValueError, TypeError) as e:
            errors.append(str(e))

    def solid_cell(c: Sequence[int]) -> bool:
        return (
            len(c) == 3
            and all(isinstance(v, int) for v in c)
            and 0 <= c[0] < nx
            and 0 <= c[1] < ny
            and 0 <= c[2] < nz
            and solid[element_index(grid, c[0], c[1], c[2])] == 1
        )

    supports = stage.get("supports", [])
    if not supports:
        errors.append("at least one support is required")
    for s in supports:
        fix = s.get("fix", "")
        if not (isinstance(fix, str) and re.fullmatch(r"[xyz]+", fix)):
            errors.append(f"bad support fix {json.dumps(fix)}")
        for c in s.get("cells") or []:
            if not solid_cell(c):
                errors.append(f"support cell {_cell_str(c)} is not a solid cell")
    for lc in stage_cases(stage):
        loads = lc.get("loads", [])
        if not loads:
            errors.append(f"load case {lc.get('name')} has no loads")
        for ld in loads:
            if not ld.get("cells"):
                errors.append("load without cells")
            for c in ld.get("cells") or []:
                if not solid_cell(c):
                    errors.append(f"load cell {_cell_str(c)} is not a solid cell")
    t = stage.get("targets", {})
    s1, s2, s3 = t.get("star1"), t.get("star2"), t.get("star3")
    nums = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (s1, s2, s3))
    if not (nums and s1 > s2 > s3 > 0 and s1 <= 1):
        errors.append("targets must satisfy 1 >= star1 > star2 > star3 > 0")
    bench = stage.get("benchmark")
    if bench is not None:
        try:
            decode_bitmask(bench["solid"], n)
        except (KeyError, ValueError, TypeError) as e:
            errors.append(f"benchmark: {e}")
    return errors


# ---------------------------------------------------------------------------
# Mechanics checks (exporter only)

_FACE_AXIS = {"x-": (0, False), "x+": (0, True), "y-": (1, False), "y+": (1, True), "z-": (2, False), "z+": (2, True)}


def face_node_offsets(face: str) -> list[Cell]:
    """Node offsets (relative to the cell's min node) of the 4 nodes on a cell face."""
    axis, positive = _FACE_AXIS[face]
    out = []
    for a in (0, 1):
        for b in (0, 1):
            off = [0, 0, 0]
            off[axis] = 1 if positive else 0
            others = [d for d in range(3) if d != axis]
            off[others[0]] = a
            off[others[1]] = b
            out.append((off[0], off[1], off[2]))
    return out


def support_cells(stage: dict, solid: np.ndarray, support: dict) -> list[Cell]:
    """Cells a support acts on: its ``cells``, or every solid cell on that grid face."""
    if support.get("cells"):
        return [tuple(c) for c in support["cells"]]
    grid = stage["grid"]
    axis, positive = _FACE_AXIS[support["face"]]
    layer = grid[axis] - 1 if positive else 0
    cells = []
    for e in np.flatnonzero(solid):
        c = element_coords(grid, int(e))
        if c[axis] == layer:
            cells.append(c)
    return cells


def fixed_dofs(stage: dict, solid: np.ndarray) -> list[tuple[Cell, int]]:
    """(node (i, j, k), component) pairs fixed by the supports, deduplicated and sorted."""
    dofs: set[tuple[Cell, int]] = set()
    for s in stage["supports"]:
        comps = ["xyz".index(ch) for ch in s["fix"]]
        offsets = face_node_offsets(s["face"])
        for c in support_cells(stage, solid, s):
            for o in offsets:
                node = (c[0] + o[0], c[1] + o[1], c[2] + o[2])
                for comp in comps:
                    dofs.add((node, comp))
    return sorted(dofs)


_MODE_NAMES = ("translation x", "translation y", "translation z", "rotation about x", "rotation about y", "rotation about z")


def rigid_mode_matrix(dofs: Sequence[tuple[Cell, int]]) -> np.ndarray:
    """Rows = fixed DOFs, columns = the 6 rigid-body modes evaluated at that DOF."""
    if not dofs:
        return np.zeros((0, 6))
    p = np.array([d[0] for d in dofs], dtype=float)
    comp = np.array([d[1] for d in dofs], dtype=int)
    r = p - p.mean(axis=0)  # centred, in cell units, for conditioning
    rows = np.zeros((len(dofs), 6))
    rows[np.arange(len(dofs)), comp] = 1.0  # translations
    # rotation about axis a: u = e_a x r
    rot = np.zeros((len(dofs), 3, 3))  # [dof, axis, component]
    rot[:, 0] = np.stack([np.zeros(len(r)), -r[:, 2], r[:, 1]], axis=1)
    rot[:, 1] = np.stack([r[:, 2], np.zeros(len(r)), -r[:, 0]], axis=1)
    rot[:, 2] = np.stack([-r[:, 1], r[:, 0], np.zeros(len(r))], axis=1)
    for a in range(3):
        rows[:, 3 + a] = rot[np.arange(len(dofs)), a, comp]
    return rows


def free_rigid_modes(stage: dict, solid: np.ndarray) -> tuple[int, list[str]]:
    """Rank of the rigid-mode matrix at the fixed DOFs, and names of the modes left free."""
    rows = rigid_mode_matrix(fixed_dofs(stage, solid))
    if rows.shape[0] == 0:
        return 0, list(_MODE_NAMES)
    rank = int(np.linalg.matrix_rank(rows))
    if rank == 6:
        return 6, []
    _, s, vt = np.linalg.svd(rows)
    tol = s.max() * max(rows.shape) * np.finfo(float).eps
    null = vt[np.concatenate([s, np.zeros(6 - len(s))]) <= tol]
    names = []
    for v in null:
        dominant = np.flatnonzero(np.abs(v) > 0.3 * np.abs(v).max())
        names.append(" + ".join(_MODE_NAMES[i] for i in dominant))
    return rank, names


def solid_components(grid: Sequence[int], solid: np.ndarray) -> np.ndarray:
    """Label 6-connected components of the solid (0 = empty, 1..k = component id)."""
    nx, ny, nz = grid
    labels = np.zeros(element_count(grid), dtype=np.int32)
    current = 0
    for start in np.flatnonzero(solid):
        if labels[start]:
            continue
        current += 1
        labels[start] = current
        queue = deque([int(start)])
        while queue:
            e = queue.popleft()
            x, y, z = element_coords(grid, e)
            for dx, dy, dz in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)):
                a, b, c = x + dx, y + dy, z + dz
                if 0 <= a < nx and 0 <= b < ny and 0 <= c < nz:
                    f = element_index(grid, a, b, c)
                    if solid[f] and not labels[f]:
                        labels[f] = current
                        queue.append(f)
    return labels


def check_stage(stage: dict) -> tuple[list[str], list[str]]:
    """Contract validation + exporter checks. Returns (errors, warnings)."""
    errors = validate_stage(stage)
    warnings: list[str] = []
    if errors:
        return errors, warnings
    grid = stage["grid"]
    nx, ny, nz = grid
    n = element_count(grid)
    solid = decode_bitmask(stage["solid"], n)

    sid = stage.get("id")
    if not (isinstance(sid, str) and ID_PATTERN.match(sid)):
        errors.append(f"id {sid!r} must match {ID_PATTERN.pattern} (it is also the file name)")
    if not stage.get("title"):
        errors.append("title is empty")
    world = stage.get("world")
    if not (isinstance(world, int) and 0 <= world <= 5):
        errors.append(f"world {world!r} must be an integer in 0..5")

    def exposed(c: Cell, face: str) -> bool:
        axis, positive = _FACE_AXIS[face]
        nb = list(c)
        nb[axis] += 1 if positive else -1
        if not (0 <= nb[0] < nx and 0 <= nb[1] < ny and 0 <= nb[2] < nz):
            return True
        return solid[element_index(grid, *nb)] == 0

    for i, s in enumerate(stage["supports"]):
        face = s.get("face")
        if face not in FACES:
            errors.append(f"support {i}: bad face {face!r}")
            continue
        fix = s["fix"]
        if len(set(fix)) != len(fix):
            errors.append(f"support {i}: fix {fix!r} repeats a component")
        cells = s.get("cells")
        if cells is not None:
            if len({tuple(c) for c in cells}) != len(cells):
                errors.append(f"support {i}: duplicate cells")
            hidden = [c for c in cells if not exposed(tuple(c), face)]
            if hidden:
                errors.append(f"support {i}: face {face} of cell {_cell_str(hidden[0])} is not on the solid boundary")
        elif not support_cells(stage, solid, s):
            errors.append(f"support {i}: no solid cells on grid face {face}")

    for case in stage_cases(stage):
        for j, ld in enumerate(case["loads"]):
            force = ld.get("force")
            if not (isinstance(force, (list, tuple)) and len(force) == 3 and all(isinstance(f, (int, float)) and math.isfinite(f) for f in force)):
                errors.append(f"load {j}: force must be 3 finite numbers")
            elif not any(force):
                errors.append(f"load {j}: force is zero")
            cells = ld["cells"]
            if len({tuple(c) for c in cells}) != len(cells):
                errors.append(f"load {j}: duplicate cells")
            if len(cells) == 1:
                warnings.append(f"load {j}: single-cell load (stress singularity risk); spread it over a few cells")
    if errors:
        return errors, warnings

    rank, free = free_rigid_modes(stage, solid)
    if rank < 6:
        errors.append(f"supports leave rigid-body modes free (rank {rank} < 6): {'; '.join(free)}")

    labels = solid_components(grid, solid)
    ncomp = int(labels.max())
    if ncomp != 1:
        errors.append(f"solid has {ncomp} 6-connected components; every piece must be connected")

    hints = stage.get("hints") or []
    if not 1 <= len(hints) <= 3:
        warnings.append(f"{len(hints)} hints (1-3 recommended)")
    return errors, warnings
