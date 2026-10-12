# w1-10 — W1 finale: inclined tip load, a window (block) and a protected stub that the load
# path may use. Grid 24 x 8 x 4, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w1-10",
    title="工房の卒業試験",
    world=1,
    hints=[
        "荷重はななめ下向き。どこへ流れていくか、色で確かめよう。",
        "下の小さな柱は保護領域。うまく使えば支えになる。",
        "窓をよけながら、荷重から壁まで道をつなごう。",
    ],
)
sk.domain_box((0, 0, 0), (24, 8, 4))
sk.block("window", (6, 3, 0), (12, 6, 4))  # 6x3x4 opening near the wall
sk.keep("stub", (16, 0, 0), (18, 4, 4))  # 2x4x4 protected stub on the bottom edge
sk.support("wall", (0, 0, 0), (1, 8, 4), face="x-", fix="xyz", whole_face=True)
sk.load("tip", (22, 7, 0), (24, 8, 4), force=(-1000, -2000, 0))  # 2x1x4 strip, pulls down and back
