# w1-03 — cantilever with a protected (keep) pillar in the middle, load at the free end.
# Grid 24 x 8 x 4, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w1-03",
    title="柱のある片持ちはり",
    world=1,
    hints=[
        "まん中の柱は保護されたブロック。削れないし、応力の判定にも入らない。",
        "先端の荷重を、柱を経由して壁まで流す道すじを考えよう。",
        "一度にたくさん削らず、色の変化を見ながら少しずつ。",
    ],
)
sk.domain_box((0, 0, 0), (24, 8, 4))
sk.support("wall", (0, 0, 0), (1, 8, 4), face="x-", fix="xyz", whole_face=True)
sk.keep("pillar", (11, 0, 0), (13, 8, 4))  # full-height 2x8x4 pillar
sk.load("tip", (22, 7, 0), (24, 8, 4), force=(0, -4000, 0))  # 2x1x4 strip, top of free end
