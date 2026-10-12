# w2-09 — banks at different heights: a rock (block) fills the lower right corner and the
# right abutment sits on top of it; the deck (top layer) carries the load and is protected.
# Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-09",
    title="高さのちがう両岸",
    world=2,
    hints=[
        "右の岸は岩の上。左右で支点の高さがちがう。",
        "橋げた(いちばん上の段)は荷重を受けるので削れない。",
        "低い岸と高い岸へ、それぞれ斜めに押し下ろす形を探そう。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.block("rock", (26, 0, 0), (32, 4, 8))  # 6x4x8 rock under the right bank
sk.support("left", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("right", (28, 4, 0), (32, 5, 8), face="y-", fix="xyz")  # on top of the rock
sk.load("deck", (0, 7, 0), (32, 8, 8), force=(0, -12000, 0))  # distributed over the deck
