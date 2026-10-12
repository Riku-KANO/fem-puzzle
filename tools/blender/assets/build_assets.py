"""Build the STRESS CARVE environment assets inside headless Blender.

    blender -b --factory-startup --python-exit-code 1 -P build_assets.py -- \\
        --out apps/web/public/assets [--previews tools/blender/assets/previews] [--icons] \\
        [--only workshop,jigs,...] [--check-against apps/web/public/assets]

Use tools/blender/assets/build.sh rather than calling this directly.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.dont_write_bytecode = True  # no __pycache__ next to the sources
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from assetkit import png  # noqa: E402
from assetdefs import debris, decal, icons, jigs, previews, workshop  # noqa: E402

FAMILIES = {
    "workshop": workshop.build,
    "jigs": jigs.build,
    "debris": debris.build,
    "decal": decal.build,
}
SIZE_BUDGET = 1_500_000  # bytes, everything under apps/web/public/assets
ICON_SIZE = 128


def _log(msg: str) -> None:
    print(f"[assets] {msg}", flush=True)


def build_all(out_dir: str, only: list[str]) -> dict[str, dict]:
    files: dict[str, dict] = {}
    for name, fn in FAMILIES.items():
        if only and name not in only:
            continue
        t = time.time()
        res = fn(out_dir)
        files.update(res)
        sizes = ", ".join(f"{k} {v['bytes']} B" for k, v in res.items())
        _log(f"{name}: {sizes} ({time.time() - t:.1f}s)")
    return files


def write_manifest(out_dir: str, files: dict[str, dict]) -> int:
    manifest = {
        "version": 1,
        "generator": "tools/blender/assets/build.sh (T-307)",
        "units": "metres, Y-up (glTF)",
        "conventions": "see tools/blender/assets/README.md",
        "files": files,
    }
    path = os.path.join(out_dir, "manifest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    return os.path.getsize(path)


def check_against(built: str, committed: str) -> list[str]:
    """Compare a fresh build with the committed assets; returns a list of problems."""
    problems: list[str] = []
    for root, _dirs, names in os.walk(built):
        for n in sorted(names):
            rel = os.path.relpath(os.path.join(root, n), built)
            ref = os.path.join(committed, rel)
            if not os.path.exists(ref):
                problems.append(f"missing in repo: {rel}")
                continue
            with open(os.path.join(root, n), "rb") as a, open(ref, "rb") as b:
                if a.read() != b.read():
                    problems.append(f"out of date: {rel} (run tools/blender/assets/build.sh)")
    total = 0
    for root, _dirs, names in os.walk(committed):
        for n in sorted(names):
            p = os.path.join(root, n)
            rel = os.path.relpath(p, committed)
            total += os.path.getsize(p)
            if rel.startswith("icons" + os.sep):
                if not n.endswith(".png"):
                    problems.append(f"unexpected file: {rel}")
                elif png.size_of(p) != (ICON_SIZE, ICON_SIZE):
                    problems.append(f"icon is not {ICON_SIZE}x{ICON_SIZE}: {rel}")
            elif not os.path.exists(os.path.join(built, rel)):
                problems.append(f"stale file (not produced by the build): {rel}")
    for name in icons.NAMES:
        if not os.path.exists(os.path.join(committed, "icons", f"{name}.png")):
            problems.append(f"missing icon: icons/{name}.png")
    _log(f"total size of {committed}: {total} B (budget {SIZE_BUDGET} B)")
    if total >= SIZE_BUDGET:
        problems.append(f"assets total {total} B >= budget {SIZE_BUDGET} B")
    return problems


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="build_assets.py")
    ap.add_argument("--out", required=True)
    ap.add_argument("--previews", default="")
    ap.add_argument("--icons", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--check-against", default="")
    args = ap.parse_args(argv)
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    only = [s for s in args.only.split(",") if s]

    files = build_all(out, only)
    if not only:
        size = write_manifest(out, files)
        _log(f"manifest.json {size} B")
    if args.icons:
        t = time.time()
        res = icons.build(os.path.join(out, "icons"), ICON_SIZE)
        _log(f"icons: {len(res)} files ({time.time() - t:.1f}s)")
    if args.previews:
        t = time.time()
        res = previews.build(out, os.path.abspath(args.previews), only)
        _log(f"previews: {len(res)} files ({time.time() - t:.1f}s)")
    if args.check_against:
        problems = check_against(out, os.path.abspath(args.check_against))
        for p in problems:
            _log(f"CHECK FAIL: {p}")
        if problems:
            return 1
        _log("check OK: committed assets are up to date")
    return 0


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    code = main(argv)
    if code:
        sys.exit(code)
