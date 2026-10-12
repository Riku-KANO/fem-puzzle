# w1-09 — crane: L-shaped domain (mast on the floor + arm), load hanging under the arm end.
# Grid 24 x 16 x 4, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w1-09",
    title="クレーン",
    world=1,
    hints=[
        "吊り荷の力は、腕を通って柱へ、柱を通って床へ流れる。",
        "L字の内側の角には応力が集まる。角のまわりの色をよく見よう。",
        "角に斜めの支えを残すと、腕も柱も楽になる。",
    ],
)
sk.domain_box((0, 0, 0), (6, 16, 4), name="domain_mast")
sk.domain_box((0, 10, 0), (24, 16, 4), name="domain_arm")
sk.support("floor", (0, 0, 0), (6, 1, 4), face="y-", fix="xyz")  # foot of the mast
sk.load("hook", (22, 10, 0), (24, 11, 4), force=(0, -3000, 0))  # 2x1x4 strip under the arm end
