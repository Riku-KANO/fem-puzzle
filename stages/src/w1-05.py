# w1-05 — sign post: vertical cantilever on the floor, sideways load at the top.
# Grid 12 x 20 x 4, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w1-05",
    title="看板の柱",
    world=1,
    hints=[
        "支点は床、荷重は横向き。向きが変わっても、荷重から支点への流れを色で読むのは同じ。",
        "根元の左右のふちが赤いのは、柱が曲げられているしるし。",
        "まん中の青い芯をくり抜くと、二本の脚が見えてくる。",
    ],
)
sk.domain_box((0, 0, 0), (12, 20, 4))
sk.support("floor", (0, 0, 0), (12, 1, 4), face="y-", fix="xyz", whole_face=True)
sk.load("wind", (0, 18, 0), (1, 20, 4), force=(3000, 0, 0))  # 1x2x4 strip, top of the left face
