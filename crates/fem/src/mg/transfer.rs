//! Trilinear prolongation `P` between two levels, its transpose, and the per-child
//! interpolation weights used for the element-wise Galerkin product.
//!
//! Fine DOFs that are masked (not free) are excluded on both sides, i.e. the operators
//! implemented here are `M_f P` and `Pᵀ M_f`. With `A_f = M K M + (I − M)` this makes
//! `(M_f P)ᵀ A_f (M_f P) = Pᵀ M K M P = Σ_e P_eᵀ (M_e K_e M_e) P_e` exactly.

use super::grid::grid;
use crate::grid::{Grid, HEX8_NODE_OFFSETS as LOCAL_NODES};

/// Interpolation weights from the 8 coarse-element nodes to the 8 nodes of one fine
/// child element: for fine local node `a`, `ent[a][..cnt[a]]` lists `(A, w)` with
/// `W[a][A] = w ≠ 0`.
#[derive(Clone, Debug)]
pub(crate) struct ChildMap {
    pub cnt: [usize; 8],
    pub ent: [[(usize, f64); 8]; 8],
}

impl ChildMap {
    /// `offset` = child position inside the parent per axis (`< f`), `f` = factors.
    fn new(offset: [usize; 3], f: [usize; 3]) -> Self {
        let mut cnt = [0usize; 8];
        let mut ent = [[(0usize, 0.0f64); 8]; 8];
        for (a, la) in LOCAL_NODES.iter().enumerate() {
            for (ca, lc) in LOCAL_NODES.iter().enumerate() {
                let mut w = 1.0;
                for ax in 0..3 {
                    // Local coordinate of the fine node inside the coarse element.
                    let t = (offset[ax] + la[ax]) as f64 / f[ax] as f64;
                    w *= if lc[ax] == 0 { 1.0 - t } else { t };
                }
                if w != 0.0 {
                    ent[a][cnt[a]] = (ca, w);
                    cnt[a] += 1;
                }
            }
        }
        Self { cnt, ent }
    }

    /// Dense `W` (8×8, `W[a][A]`), for tests.
    #[cfg(test)]
    pub fn dense(&self) -> [[f64; 8]; 8] {
        let mut w = [[0.0; 8]; 8];
        for (a, row) in w.iter_mut().enumerate() {
            for &(ca, v) in &self.ent[a][..self.cnt[a]] {
                row[ca] = v;
            }
        }
        w
    }
}

/// `out += scale · (W⊗I₃)ᵀ k (W⊗I₃)` for a 24×24 row-major `k`.
pub(crate) fn galerkin_add(k: &[f64], map: &ChildMap, scale: f64, out: &mut [f64]) {
    debug_assert!(k.len() == 576 && out.len() == 576);
    // t = k (W⊗I₃)
    let mut t = [0.0f64; 576];
    for r in 0..24 {
        let kr = &k[r * 24..r * 24 + 24];
        let tr = &mut t[r * 24..r * 24 + 24];
        for b in 0..8 {
            let kb = [kr[3 * b], kr[3 * b + 1], kr[3 * b + 2]];
            if kb == [0.0; 3] {
                continue;
            }
            for &(cb, w) in &map.ent[b][..map.cnt[b]] {
                tr[3 * cb] += w * kb[0];
                tr[3 * cb + 1] += w * kb[1];
                tr[3 * cb + 2] += w * kb[2];
            }
        }
    }
    // out += scale (W⊗I₃)ᵀ t
    for a in 0..8 {
        for &(ca, w) in &map.ent[a][..map.cnt[a]] {
            let ws = w * scale;
            for i in 0..3 {
                let src = &t[(3 * a + i) * 24..(3 * a + i) * 24 + 24];
                let dst = &mut out[(3 * ca + i) * 24..(3 * ca + i) * 24 + 24];
                for (d, s) in dst.iter_mut().zip(src) {
                    *d += ws * s;
                }
            }
        }
    }
}

/// One 1-D interpolation stencil: up to two `(coarse index, weight)` pairs.
type Stencil1 = [(usize, f64); 2];

/// Transfer operators between `fine` and `coarse = fine / f`.
#[derive(Clone, Debug)]
pub(crate) struct Transfer {
    pub fine: Grid,
    pub coarse: Grid,
    pub f: [usize; 3],
    axis: [Vec<Stencil1>; 3],
    /// Indexed by child id `ox + 2*(oy + 2*oz)`; only offsets `< f` are meaningful.
    pub child: Vec<ChildMap>,
}

impl Transfer {
    pub fn new(fine: Grid, f: [usize; 3]) -> Self {
        let coarse = grid(fine.nx / f[0], fine.ny / f[1], fine.nz / f[2]);
        let fine_nodes = [fine.nx + 1, fine.ny + 1, fine.nz + 1];
        let axis = std::array::from_fn(|ax| {
            (0..fine_nodes[ax])
                .map(|i| {
                    if f[ax] == 1 || i % 2 == 0 {
                        [(i / f[ax], 1.0), (0, 0.0)]
                    } else {
                        [((i - 1) / 2, 0.5), (i.div_ceil(2), 0.5)]
                    }
                })
                .collect()
        });
        let child = (0..8)
            .map(|id| {
                let o = [id % 2, (id / 2) % 2, id / 4];
                let o = [o[0].min(f[0] - 1), o[1].min(f[1] - 1), o[2].min(f[2] - 1)];
                ChildMap::new(o, f)
            })
            .collect();
        Self {
            fine,
            coarse,
            f,
            axis,
            child,
        }
    }

    /// Parent coarse element and child id of fine element `e`.
    pub fn parent(&self, e: usize) -> (usize, usize) {
        let [x, y, z] = self.fine.element_coords(e);
        let f = self.f;
        let pe = self.coarse.element_index(x / f[0], y / f[1], z / f[2]);
        let id = (x % f[0]) + 2 * ((y % f[1]) + 2 * (z % f[2]));
        (pe, id)
    }

    /// Children `(fine element, child id)` of coarse element `ce`; returns the count.
    pub fn children(&self, ce: usize, out: &mut [(usize, usize); 8]) -> usize {
        let [cx, cy, cz] = self.coarse.element_coords(ce);
        let f = self.f;
        let mut n = 0;
        for oz in 0..f[2] {
            for oy in 0..f[1] {
                for ox in 0..f[0] {
                    let e = self
                        .fine
                        .element_index(cx * f[0] + ox, cy * f[1] + oy, cz * f[2] + oz);
                    out[n] = (e, ox + 2 * (oy + 2 * oz));
                    n += 1;
                }
            }
        }
        n
    }

    /// `zf += M_f P zc`.
    pub fn prolong_add(&self, zc: &[f64], free_f: &[bool], zf: &mut [f64]) {
        let (cx, cy) = (self.coarse.nx + 1, self.coarse.ny + 1);
        let mut n = 0;
        for sk in &self.axis[2] {
            for sj in &self.axis[1] {
                for si in &self.axis[0] {
                    let mut acc = [0.0f64; 3];
                    for &(k, wk) in sk {
                        if wk == 0.0 {
                            continue;
                        }
                        for &(j, wj) in sj {
                            if wj == 0.0 {
                                continue;
                            }
                            for &(i, wi) in si {
                                if wi == 0.0 {
                                    continue;
                                }
                                let w = wi * wj * wk;
                                let cn = 3 * (i + cx * (j + cy * k));
                                acc[0] += w * zc[cn];
                                acc[1] += w * zc[cn + 1];
                                acc[2] += w * zc[cn + 2];
                            }
                        }
                    }
                    for c in 0..3 {
                        if free_f[3 * n + c] {
                            zf[3 * n + c] += acc[c];
                        }
                    }
                    n += 1;
                }
            }
        }
        debug_assert_eq!(n, self.fine.nodes());
    }

    /// `rc = Pᵀ M_f rf`.
    pub fn restrict(&self, rf: &[f64], free_f: &[bool], rc: &mut [f64]) {
        let (cx, cy) = (self.coarse.nx + 1, self.coarse.ny + 1);
        rc.fill(0.0);
        let mut n = 0;
        for sk in &self.axis[2] {
            for sj in &self.axis[1] {
                for si in &self.axis[0] {
                    let v = [
                        if free_f[3 * n] { rf[3 * n] } else { 0.0 },
                        if free_f[3 * n + 1] {
                            rf[3 * n + 1]
                        } else {
                            0.0
                        },
                        if free_f[3 * n + 2] {
                            rf[3 * n + 2]
                        } else {
                            0.0
                        },
                    ];
                    n += 1;
                    if v == [0.0; 3] {
                        continue;
                    }
                    for &(k, wk) in sk {
                        if wk == 0.0 {
                            continue;
                        }
                        for &(j, wj) in sj {
                            if wj == 0.0 {
                                continue;
                            }
                            for &(i, wi) in si {
                                if wi == 0.0 {
                                    continue;
                                }
                                let w = wi * wj * wk;
                                let cn = 3 * (i + cx * (j + cy * k));
                                rc[cn] += w * v[0];
                                rc[cn + 1] += w * v[1];
                                rc[cn + 2] += w * v[2];
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dense `P` (fine DOFs × coarse DOFs) built from the per-child maps.
    fn dense_p_from_children(t: &Transfer) -> Vec<Vec<f64>> {
        let nf = t.fine.dofs();
        let nc = t.coarse.dofs();
        let mut p = vec![vec![0.0; nc]; nf];
        for e in 0..t.fine.elements() {
            let (ce, id) = t.parent(e);
            let fn_ = t.fine.element_nodes(e);
            let cn = t.coarse.element_nodes(ce);
            let w = t.child[id].dense();
            for a in 0..8 {
                for ca in 0..8 {
                    for c in 0..3 {
                        let entry = &mut p[3 * fn_[a] + c][3 * cn[ca] + c];
                        // Consistent across elements sharing the fine node.
                        if w[a][ca] != 0.0 {
                            assert!(*entry == 0.0 || (*entry - w[a][ca]).abs() < 1e-15);
                            *entry = w[a][ca];
                        }
                    }
                }
            }
        }
        p
    }

    #[test]
    fn prolongation_matches_child_maps_and_is_trilinear() {
        for (fine, f) in [
            (grid(4, 2, 2), [2, 2, 2]),
            (grid(6, 3, 2), [2, 1, 2]),
            (grid(2, 1, 1), [2, 1, 1]),
        ] {
            let t = Transfer::new(fine, f);
            let p = dense_p_from_children(&t);
            let nc = t.coarse.dofs();
            let nf = t.fine.dofs();
            let free = vec![true; nf];
            // Column-by-column comparison of prolong_add against the dense P.
            for j in 0..nc {
                let mut zc = vec![0.0; nc];
                zc[j] = 1.0;
                let mut zf = vec![0.0; nf];
                t.prolong_add(&zc, &free, &mut zf);
                for i in 0..nf {
                    assert!((zf[i] - p[i][j]).abs() < 1e-15, "P mismatch at {i},{j}");
                }
            }
            // Restriction is the transpose.
            for i in 0..nf {
                let mut rf = vec![0.0; nf];
                rf[i] = 1.0;
                let mut rc = vec![0.0; nc];
                t.restrict(&rf, &free, &mut rc);
                for j in 0..nc {
                    assert!((rc[j] - p[i][j]).abs() < 1e-15);
                }
            }
            // A linear field on the coarse grid interpolates exactly.
            let lin = |x: f64, y: f64, z: f64| [1.0 + 2.0 * x - y, 0.5 * z + y, x - 3.0 * z];
            let [cx, cy, cz] = [t.coarse.nx + 1, t.coarse.ny + 1, t.coarse.nz + 1];
            let mut zc = vec![0.0; nc];
            for k in 0..cz {
                for j in 0..cy {
                    for i in 0..cx {
                        let n = t.coarse.node_index(i, j, k);
                        let v = lin((i * f[0]) as f64, (j * f[1]) as f64, (k * f[2]) as f64);
                        zc[3 * n..3 * n + 3].copy_from_slice(&v);
                    }
                }
            }
            let mut zf = vec![0.0; nf];
            t.prolong_add(&zc, &free, &mut zf);
            let [fx, fy, fz] = [t.fine.nx + 1, t.fine.ny + 1, t.fine.nz + 1];
            for k in 0..fz {
                for j in 0..fy {
                    for i in 0..fx {
                        let n = t.fine.node_index(i, j, k);
                        let v = lin(i as f64, j as f64, k as f64);
                        for c in 0..3 {
                            assert!((zf[3 * n + c] - v[c]).abs() < 1e-12);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn children_and_parent_agree() {
        let t = Transfer::new(grid(6, 4, 3), [2, 2, 1]);
        let mut seen = vec![false; t.fine.elements()];
        let mut buf = [(0, 0); 8];
        for ce in 0..t.coarse.elements() {
            let n = t.children(ce, &mut buf);
            assert_eq!(n, 4);
            for &(e, id) in &buf[..n] {
                assert_eq!(t.parent(e), (ce, id));
                assert!(!seen[e]);
                seen[e] = true;
            }
        }
        assert!(seen.iter().all(|&s| s));
    }
}
