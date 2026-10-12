# w2-02 — simply supported beam, two symmetric point loads (four-point bending).
# Same supports as w2-01. Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up).
import stagekit as sk

sk.stage_props(
    id="w2-02",
    title="二点で押されるはり",
    world=2,
    hints=[
        "二つの荷重のあいだは、どこでも同じ大きさで曲げられている。",
        "それぞれの荷重から支点へ、力がまっすぐ流れる道を残そう。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.support("pin", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("roller", (30, 0, 0), (32, 1, 8), face="y-", fix="y")
# 2x1x8 strips centred 10 cells from each support centre (symmetric about x = 16)
sk.load("left", (10, 7, 0), (12, 8, 8), force=(0, -12000, 0))
sk.load("right", (20, 7, 0), (22, 8, 8), force=(0, -12000, 0))
