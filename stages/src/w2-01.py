# w2-01 — simply supported shallow beam, centre load: top and bottom chords work, the
# neutral axis does not (an I-beam with holes). The beam is 5 cells tall: at 8 cells the full
# block sat at 18 % utilisation under the calibrated load (benchmark: a 15 % tied arch).
# Pin (xyz) under the left end, roller (y) under the right end; both strips span the full
# depth (z) so the supports are not collinear and all 6 rigid-body modes are removed.
# Grid 32 x 5 x 8, voxel 0.01 m (stage cells, Y-up). See tools/blender/README.md.
import stagekit as sk

sk.stage_props(
    id="w2-01",
    title="両端で支えるはり",
    world=2,
    hints=[
        "左はピン(動かない)、右はローラー(上下だけ支え、横には滑れる)。",
        "上のふちは押され、下のふちは引っぱられて赤くなる。高さのまん中(中立軸)は青い。",
        "中立軸のあたりに穴をあけても、はりの強さはあまり落ちない。",
    ],
)
sk.domain_box((0, 0, 0), (32, 5, 8))
sk.support("pin", (0, 0, 0), (2, 1, 8), face="y-", fix="xyz")
sk.support("roller", (30, 0, 0), (32, 1, 8), face="y-", fix="y")
sk.load("centre", (15, 4, 0), (17, 5, 8), force=(0, -20000, 0))  # 2x1x8 strip, top centre
