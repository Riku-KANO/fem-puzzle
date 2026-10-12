# w2-04 — simply supported beam with an off-centre load (quarter span): no symmetry, the
# nearer support carries more. Grid 32 x 8 x 8, voxel 0.01 m. See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-04",
    title="片寄った荷重",
    world=2,
    hints=[
        "荷重は左寄り。左右対称の答えにはならない。",
        "荷重に近い支点のほうが多くの力を受け持つ。左右の色の濃さを比べよう。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.support("pin", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("roller", (30, 0, 0), (32, 1, 8), face="y-", fix="y")
sk.load("load", (8, 7, 0), (10, 8, 8), force=(0, -20000, 0))  # 2x1x8 strip, top, quarter span
