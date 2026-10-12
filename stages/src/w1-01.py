# w1-01 — tutorial cantilever: wall on x-, load down on the top of the free end.
# Built by tools/blender/export_stage.py (see tools/blender/README.md). Cells are stage
# coordinates (Y-up): grid 24 x 8 x 4, voxel 0.01 m.
import stagekit as sk

sk.stage_props(
    id="w1-01",
    title="はじめての片持ちはり",
    world=1,
    hints=[
        "色は応力の大きさ。青いところはほとんど力を受けていないので、削っても安全。",
        "赤に近いほど限界が近い。赤いところを削ると壊れやすくなる。",
        "曲げられたはりは上下のふちがいちばん働き、まん中の芯は青くなりやすい。",
    ],
)
sk.domain_box((0, 0, 0), (24, 8, 4))
sk.support("wall", (0, 0, 0), (1, 8, 4), face="x-", fix="xyz", whole_face=True)
sk.load("tip", (22, 7, 0), (24, 8, 4), force=(0, -3000, 0))  # 2x1x4 strip, top of free end
