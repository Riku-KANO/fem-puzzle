"""Headless stage exporter: Blender scene → ``<out>/<id>.json`` (contract format).

    # procedural source (stages/src/<id>.py builds the scene with stagekit)
    blender -b --factory-startup -P tools/blender/export_stage.py -- --source stages/src/w1-01.py --out stages/
    # hand-made .blend following the naming convention
    blender -b --factory-startup stages/src/foo.blend -P tools/blender/export_stage.py -- --out stages/

Options (after ``--``):
    --source PATH     run a stagekit source first (the scene is reset)
    --out DIR         write <DIR>/<id>.json (omit for a dry run)
    --expect-id ID    fail unless the stage id equals ID (build script: id = source basename)
    --save-blend PATH save the built scene as a .blend (inspection / tests)

The stage is validated with the contract rules (``stagecore.validate_stage``) plus the
exporter checks (rigid-body modes removed, single connected solid, support faces on the
boundary, ...). Any error → exit code 1 and nothing is written. Without ``-b`` the scene is
left open in the UI for inspection.
"""

from __future__ import annotations

import argparse
import os
import runpy
import sys
import traceback

sys.dont_write_bytecode = True  # keep tools/blender free of __pycache__
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402

import stagecore as sc  # noqa: E402
import stagekit  # noqa: E402
import voxelize  # noqa: E402

LOG_PREFIX = "[stage]"


def log(msg: str) -> None:
    print(f"{LOG_PREFIX} {msg}", flush=True)


def run_source(path: str) -> None:
    """Reset the scene and execute a stagekit source file."""
    stagekit.reset()
    runpy.run_path(os.path.abspath(path), run_name="__stage_source__")


def build(expect_id: str | None = None) -> tuple[dict, list[str], list[str], list[str]]:
    """Voxelise + check the current scene. Returns (stage, report, errors, warnings)."""
    built = voxelize.voxelize_scene(bpy.context.scene)
    stage = built.stage
    errors, warnings = sc.check_stage(stage)
    if expect_id is not None and stage["id"] != expect_id:
        errors.insert(0, f"stage id {stage['id']!r} != expected {expect_id!r} (source file name)")
    return stage, built.report, errors, warnings


def write(stage: dict, out_dir: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{stage['id']}.json")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(sc.dumps(stage))
    return path


def parse_args(argv: list[str]) -> argparse.Namespace:
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    p = argparse.ArgumentParser(prog="export_stage.py", description=__doc__.splitlines()[0])
    p.add_argument("--source")
    p.add_argument("--out")
    p.add_argument("--expect-id")
    p.add_argument("--save-blend")
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    label = args.source or bpy.data.filepath or "<scene>"
    try:
        if args.source:
            run_source(args.source)
        elif not bpy.data.filepath:
            log("error: give --source <file.py> or open a .blend")
            return 1
        if args.save_blend:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_blend), check_existing=False)
        stage, report, errors, warnings = build(args.expect_id)
    except voxelize.StageBuildError as e:
        log(f"{label}: error: {e}")
        return 1
    except Exception:  # source bugs etc.: show the traceback, fail the build
        traceback.print_exc()
        log(f"{label}: error: exception while building the stage")
        return 1
    for line in report:
        log(f"{stage['id']}: {line}")
    for w in warnings:
        log(f"{stage['id']}: warning: {w}")
    if errors:
        for e in errors:
            log(f"{stage['id']}: error: {e}")
        return 1
    if args.out:
        log(f"{stage['id']}: wrote {write(stage, args.out)}")
    else:
        log(f"{stage['id']}: ok (dry run)")
    return 0


if __name__ == "__main__":
    code = main(sys.argv)
    if bpy.app.background:  # in the UI, keep the built scene open for inspection
        sys.exit(code)
