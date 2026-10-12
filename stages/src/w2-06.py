# w2-06 — hanging load: pinned at the top of both end faces, load under the bottom centre.
# The answer is an upside-down arch working in tension (a cable).
# Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-06",
    title="吊り下げる",
    world=2,
    hints=[
        "支点は両端の上のほう、荷重は下のまん中にぶら下がっている。",
        "ぶら下げる形はケーブルのように引っぱりで支える。アーチを逆さにした形を探そう。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.support("left", (0, 6, 0), (1, 8, 8), face="x-", fix="xyz")  # 1x2x8 cells, top of the left face
sk.support("right", (31, 6, 0), (32, 8, 8), face="x+", fix="xyz")  # top of the right face
sk.load("weight", (15, 0, 0), (17, 1, 8), force=(0, -20000, 0))  # 2x1x8 strip, bottom centre
