# w2-05 — same centre load as a beam, but both ends pinned: the abutments push back
# sideways, so an arch without a tie carries the load. Grid 32 x 8 x 8, voxel 0.01 m.
import stagekit as sk

sk.stage_props(
    id="w2-05",
    title="両岸で押し返すアーチ",
    world=2,
    hints=[
        "今度は両端ともピン。左右どちらにも動かない。",
        "両岸が横から押し返してくれるので、アーチだけで支えられる。下の引っぱり材は必要かな?",
    ],
)
sk.domain_box((0, 0, 0), (32, 8, 8))
sk.support("left", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("right", (30, 0, 0), (32, 1, 8), face="y-", fix="xyz")
sk.load("centre", (15, 7, 0), (17, 8, 8), force=(0, -20000, 0))  # 2x1x8 strip, top centre
