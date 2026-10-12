# w1-08 — cantilever bolted to the wall only along its lower three rows: the load has to be
# brought down to the narrow support. Grid 24 x 8 x 4, voxel 0.01 m. See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w1-08",
    title="下だけ留めた腕",
    world=1,
    hints=[
        "壁に固定されているのは下の3段だけ。",
        "固定のすぐ上の角が赤くなりやすい。そこは削らずに太く残そう。",
        "上の角の青いところは、壁に留まっていないので働いていない。",
    ],
)
sk.domain_box((0, 0, 0), (24, 8, 4))
sk.support("wall", (0, 0, 0), (1, 3, 4), face="x-", fix="xyz")  # 1x3x4 cells on the wall face
sk.load("tip", (22, 7, 0), (24, 8, 4), force=(0, -3000, 0))  # 2x1x4 strip, top of free end
