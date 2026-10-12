# w2-06 — bridge across a gap, held at deck level: pinned on the top two rows of both end
# faces, load on the deck centre. The material below the supports lets a hanging V (tension,
# like a cable) plus a post carry the load: depth below the deck is what makes it stiff.
# Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-06",
    title="谷にかける橋",
    world=2,
    hints=[
        "支点は両側の壁の上のほう。荷重も上の段のまん中にかかる。",
        "上の段だけで横につなぐと、曲げに弱い。下の青い部分の高さを使おう。",
        "ケーブルのように下へ垂れ下がる形が、力を両側の壁へ運ぶ。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.support("left", (0, 6, 0), (1, 8, 8), face="x-", fix="xyz")  # 1x2x8 cells, top of the left face
sk.support("right", (31, 6, 0), (32, 8, 8), face="x+", fix="xyz")  # top of the right face
sk.load("deck", (15, 7, 0), (17, 8, 8), force=(0, -20000, 0))  # 2x1x8 strip, top centre
