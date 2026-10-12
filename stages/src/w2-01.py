# w2-01 — simply supported beam, centre load.
# Pin (xyz) under the left end, roller (y) under the right end; both strips span the full
# depth (z) so the supports are not collinear and all 6 rigid-body modes are removed.
# Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-01",
    title="両端で支えるはり",
    world=2,
    hints=[
        "左はピン(動かない)、右はローラー(上下だけ支え、横には滑れる)。",
        "上側は押しつぶされ、下側は引っ張られる。どちらも赤くなる場所に注目。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.support("pin", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("roller", (30, 0, 0), (32, 1, 8), face="y-", fix="y")
sk.load("centre", (15, 7, 0), (17, 8, 8), force=(0, -20000, 0))  # 2x1x8 strip, top centre
