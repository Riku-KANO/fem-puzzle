# w1-06 — shelf bracket: load distributed over the whole top face (the top layer is
# therefore protected), wall on x-. Grid 24 x 8 x 4, voxel 0.01 m. See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w1-06",
    title="棚受け",
    world=1,
    hints=[
        "上の面全体に荷重がのっている。荷重のかかる上の段は削れない。",
        "先のほうは青く、壁に近いほど赤い。荷重が根元に集まってくるから。",
        "先端からの道は細く、根元へ向かうほど太く残そう。",
    ],
)
sk.domain_box((0, 0, 0), (24, 8, 4))
sk.support("wall", (0, 0, 0), (1, 8, 4), face="x-", fix="xyz", whole_face=True)
sk.load("shelf", (1, 7, 0), (24, 8, 4), force=(0, -3000, 0))  # whole top layer except the wall column
