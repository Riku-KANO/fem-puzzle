# w2-07 — overhanging beam: supports at x = 8..10 and 22..24, equal loads on both free ends
# (a balance toy). The top is in tension over the supports, the middle carries little.
# Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-07",
    title="両側に張り出したはり",
    world=2,
    hints=[
        "支点は内側の二か所、荷重は両端の張り出しにかかっている。",
        "支点の真上がいちばんつらい。そこでは上側が引っぱられる。",
        "支点のあいだのまん中は、あまり働いていない。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.support("pin", (8, 0, 0), (10, 1, 8), face="y-", fix="xyz")
sk.support("roller", (22, 0, 0), (24, 1, 8), face="y-", fix="y")
sk.load("left", (0, 7, 0), (2, 8, 8), force=(0, -10000, 0))  # 2x1x8 strips on both ends
sk.load("right", (30, 7, 0), (32, 8, 8), force=(0, -10000, 0))
