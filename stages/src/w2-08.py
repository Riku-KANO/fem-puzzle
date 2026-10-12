# w2-08 — continuous beam over three supports (pin left, rollers centre and right), one load
# in each span. Over the middle support the top is in tension.
# Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-08",
    title="三つの支点",
    world=2,
    hints=[
        "まん中にも支点がある。左右の荷重を、それぞれ近い支点へ流そう。",
        "まん中の支点の上では、上側が引っぱられて赤くなる(ふつうのはりと逆)。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.support("left", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("middle", (15, 0, 0), (17, 1, 8), face="y-", fix="y")
sk.support("right", (30, 0, 0), (32, 1, 8), face="y-", fix="y")
sk.load("a", (7, 7, 0), (9, 8, 8), force=(0, -20000, 0))  # 2x1x8 strips, middle of each span
sk.load("b", (23, 7, 0), (25, 8, 8), force=(0, -20000, 0))
