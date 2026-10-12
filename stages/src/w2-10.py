# w2-10 — W2 finale: a river (block) off to the left, the deck load plus a truck standing
# right of centre. Two pinned abutments. Left and right halves need different answers.
# Grid 32 x 8 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-10",
    title="川をまたぐ道路橋",
    world=2,
    hints=[
        "左寄りの川は障害物。トラックの重さは右側にかかっている。",
        "川の上はアーチで越え、トラックの下は近い支点へ短く流そう。",
        "左右でまったく違う形になってもいい。色が答えを教えてくれる。",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.block("river", (4, 0, 0), (18, 4, 8))  # 14x4x8 river bed
sk.support("left", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("right", (30, 0, 0), (32, 1, 8), face="y-", fix="xyz")
sk.load("deck", (0, 7, 0), (32, 8, 8), force=(0, -6000, 0))  # distributed over the deck
sk.load("truck", (22, 7, 0), (26, 8, 8), force=(0, -6000, 0))  # 4x1x8 patch right of centre
