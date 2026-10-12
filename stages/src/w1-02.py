# w1-02 — cantilever loaded at mid-span: everything beyond the load carries nothing.
# Grid 24 x 8 x 4, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w1-02",
    title="途中で押される片持ちはり",
    world=1,
    hints=[
        "荷重より先の部分は何も支えていない。どんな色になっているか見てみよう。",
        "根元に近いほど曲げが大きく、赤くなりやすい。",
    ],
)
sk.domain_box((0, 0, 0), (24, 8, 4))
sk.support("wall", (0, 0, 0), (1, 8, 4), face="x-", fix="xyz", whole_face=True)
sk.load("mid", (11, 7, 0), (13, 8, 4), force=(0, -6000, 0))  # 2x1x4 strip, top at mid-span
