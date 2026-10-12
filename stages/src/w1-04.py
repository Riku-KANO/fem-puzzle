# w1-04 — horizontal pull on the free end: the answer is a straight tie, not a truss.
# Grid 24 x 8 x 4, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w1-04",
    title="まっすぐ引っぱる",
    world=1,
    hints=[
        "荷重は右向きの引っぱり。色のついた帯が、壁までまっすぐ続いているはず。",
        "帯の上と下の青いところは、引っぱりをほとんど受けていない。",
        "力は荷重の向きに、いちばん近い道を通って支点へ流れる。",
    ],
)
sk.domain_box((0, 0, 0), (24, 8, 4))
sk.support("wall", (0, 0, 0), (1, 8, 4), face="x-", fix="xyz", whole_face=True)
sk.load("pull", (23, 3, 0), (24, 5, 4), force=(3000, 0, 0))  # 1x2x4 strip, mid-height of the free end
