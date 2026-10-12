# w2-03 — bridge over a tunnel: an obstacle (block) runs through z under the deck, the
# whole top layer carries the deck load (and is therefore protected). Both ends sit on
# pinned abutments (xyz), so an arch can push against them.
# Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-03",
    title="トンネルをまたぐ橋",
    world=2,
    hints=[
        "下の通り道は障害物。材料を置くことはできない。",
        "橋げた(いちばん上の段)は荷重を受けるので削れない。",
        "アーチの形にすると、力を両岸へ押し流せる。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.block("tunnel", (8, 0, 0), (24, 4, 8))  # 16x4x8 passage under the deck
sk.support("left", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("right", (30, 0, 0), (32, 1, 8), face="y-", fix="xyz")
sk.load("deck", (0, 7, 0), (32, 8, 8), force=(0, -12000, 0))  # distributed over the deck
