"""Print a size / vertex-count table for .glb files (plain Python 3, no dependencies).

    python3 tools/blender/assets/glbstat.py apps/web/public/assets/*.glb
"""

from __future__ import annotations

import json
import struct
import sys

COMPONENT_BYTES = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def stat(path: str) -> dict:
    with open(path, "rb") as f:
        data = f.read()
    magic, _version, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError(f"{path}: not a glb")
    clen, _ = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20 : 20 + clen])
    verts = tris = 0
    attrs: dict[str, str] = {}
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            pos = gltf["accessors"][prim["attributes"]["POSITION"]]
            verts += pos["count"]
            tris += gltf["accessors"][prim["indices"]]["count"] // 3
            for name, idx in prim["attributes"].items():
                acc = gltf["accessors"][idx]
                attrs[name] = f"{acc['type']}x{COMPONENT_BYTES[acc['componentType']]}B"
    return {
        "bytes": length,
        "nodes": len(gltf.get("nodes", [])),
        "materials": len(gltf.get("materials", [])),
        "verts": verts,
        "tris": tris,
        "attrs": " ".join(f"{k}:{v}" for k, v in sorted(attrs.items())),
        "ext": ",".join(gltf.get("extensionsUsed", [])),
    }


def main(paths: list[str]) -> int:
    total = 0
    print(f"{'file':<22}{'bytes':>9}{'verts':>8}{'tris':>8}{'nodes':>6}{'mats':>5}  attributes / extensions")
    for p in paths:
        s = stat(p)
        total += s["bytes"]
        name = p.rsplit("/", 1)[-1]
        print(f"{name:<22}{s['bytes']:>9}{s['verts']:>8}{s['tris']:>8}{s['nodes']:>6}{s['materials']:>5}  "
              f"{s['attrs']} {s['ext']}")
    print(f"{'total':<22}{total:>9}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
