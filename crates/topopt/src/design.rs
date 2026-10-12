//! 0/1 designs: 6-connectivity (the player rules of stage-format.md) and thresholding of
//! a continuous SIMP density field into a design the player-mode judge accepts.

use crate::layout::{Dims, Layout};
use crate::{Result, err};

/// Label the 6-connected components of `solid`; `usize::MAX` for empty cells.
pub fn components(dims: Dims, solid: &[bool]) -> (Vec<usize>, usize) {
    let n = dims.len();
    let mut label = vec![usize::MAX; n];
    let mut count = 0;
    let mut stack = Vec::new();
    for s in 0..n {
        if !solid[s] || label[s] != usize::MAX {
            continue;
        }
        label[s] = count;
        stack.push(s);
        while let Some(e) = stack.pop() {
            for f in dims.face_neighbors(e) {
                if solid[f] && label[f] == usize::MAX {
                    label[f] = count;
                    stack.push(f);
                }
            }
        }
        count += 1;
    }
    (label, count)
}

/// Solid cells whose component contains a supported solid cell (the player's *active* set).
pub fn anchored(dims: Dims, solid: &[bool], supported: &[bool]) -> Vec<bool> {
    let (label, count) = components(dims, solid);
    let mut good = vec![false; count];
    for e in 0..solid.len() {
        if solid[e] && supported[e] {
            good[label[e]] = true;
        }
    }
    (0..solid.len())
        .map(|e| solid[e] && good[label[e]])
        .collect()
}

/// Does `solid` satisfy the rules we require of a benchmark design: every keep cell solid,
/// every load cell and every keep cell anchored to a support?
///
/// Keep cells must be anchored too (stricter than the game's load rule): a floating keep
/// cell cannot be carved away, so whether it counts as debris would make the benchmark
/// volume ambiguous.
pub fn is_valid(layout: &Layout, solid: &[bool]) -> bool {
    let anchored = anchored(layout.dims, solid, &layout.supported);
    let keep_ok = (0..solid.len()).all(|e| !layout.keep[e] || anchored[e]);
    keep_ok && layout.load_cells.iter().all(|&c| anchored[c])
}

/// A thresholded design.
#[derive(Debug, Clone, PartialEq)]
pub struct Design {
    pub solid: Vec<bool>,
    /// Solid cell count.
    pub count: usize,
    /// `count / initial solid count`.
    pub volume: f64,
    /// Cells added beyond the requested count to connect loads/keep cells.
    pub added_for_connectivity: usize,
    /// Floating cells removed.
    pub removed_floating: usize,
}

impl Design {
    pub fn from_solid(layout: &Layout, solid: Vec<bool>) -> Design {
        let count = solid.iter().filter(|&&s| s).count();
        Design {
            volume: count as f64 / layout.domain_count() as f64,
            solid,
            count,
            added_for_connectivity: 0,
            removed_floating: 0,
        }
    }
}

/// Threshold a density field (`rho`, physical densities in `[0, 1]`) to a valid 0/1 design
/// of about `target_count` cells.
///
/// 1. Keep cells, plus the `target_count − keep` densest free cells (densities quantised
///    to 1e-6; ties: lower index).
/// 2. If a load or keep cell is not anchored, add cells in density order until it is
///    (the smallest such prefix, by bisection — adding material never disconnects).
/// 3. Remove floating (unanchored) material.
pub fn threshold(layout: &Layout, rho: &[f64], target_count: usize) -> Result<Design> {
    let n = layout.n();
    if rho.len() != n {
        return err("density field has the wrong length");
    }
    let mut order: Vec<usize> = (0..n).filter(|&e| layout.is_free(e)).collect();
    // Rank on densities quantised to 1e-6 so that cells equal up to solver noise (e.g.
    // mirror-symmetric pairs) tie exactly and the index decides: the design then does not
    // flip with the last bits of the linear solve.
    let q = |e: usize| (rho[e].clamp(0.0, 1.0) * 1e6).round() as i64;
    order.sort_by(|&a, &b| q(b).cmp(&q(a)).then(a.cmp(&b)));
    let n_keep = layout.keep_count();
    let want = target_count.saturating_sub(n_keep).min(order.len());

    let build = |k: usize| -> Vec<bool> {
        let mut s = layout.keep.clone();
        for &e in &order[..k] {
            s[e] = true;
        }
        s
    };
    let mut k = want;
    if !is_valid(layout, &build(k)) {
        if !is_valid(layout, &build(order.len())) {
            return err("even the full design domain leaves a load or keep cell unsupported");
        }
        // smallest k' in (k, len] that is valid
        let (mut lo, mut hi) = (k, order.len());
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if is_valid(layout, &build(mid)) {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        k = hi;
    }
    let mut solid = build(k);
    let anchored = anchored(layout.dims, &solid, &layout.supported);
    let mut removed = 0;
    for e in 0..n {
        if solid[e] && !anchored[e] {
            solid[e] = false;
            removed += 1;
        }
    }
    let mut d = Design::from_solid(layout, solid);
    d.added_for_connectivity = k - want;
    d.removed_floating = removed;
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 6×3×1 plate, supported at x = 0, load at (5, 1, 0).
    fn plate() -> Layout {
        let dims = Dims::new(6, 3, 1);
        let n = dims.len();
        let mut supported = vec![false; n];
        let mut keep = vec![false; n];
        for y in 0..3 {
            supported[dims.index(0, y, 0)] = true;
        }
        let load = dims.index(5, 1, 0);
        keep[load] = true;
        Layout {
            dims,
            domain: vec![true; n],
            keep,
            supported,
            load_cells: vec![load],
            block: vec![false; n],
        }
    }

    #[test]
    fn components_and_anchoring() {
        let l = plate();
        let d = l.dims;
        let mut solid = vec![false; d.len()];
        for x in 0..3 {
            solid[d.index(x, 0, 0)] = true;
        }
        solid[d.index(5, 2, 0)] = true;
        let (_, count) = components(d, &solid);
        assert_eq!(count, 2);
        let a = anchored(d, &solid, &l.supported);
        assert!(a[d.index(2, 0, 0)]);
        assert!(!a[d.index(5, 2, 0)]);
        // diagonal contact is not a connection
        let mut diag = vec![false; d.len()];
        diag[d.index(0, 0, 0)] = true;
        diag[d.index(1, 1, 0)] = true;
        assert_eq!(components(d, &diag).1, 2);
    }

    #[test]
    fn threshold_connects_load_and_drops_floating() {
        let l = plate();
        let d = l.dims;
        let mut rho = vec![0.0; d.len()];
        // a strong bar along y = 1 except a weak link at x = 3, plus a dense island
        for x in 0..5 {
            rho[d.index(x, 1, 0)] = if x == 3 { 0.4 } else { 0.9 };
        }
        rho[d.index(4, 2, 0)] = 0.95; // touches the bar end only
        rho[d.index(1, 2, 0)] = 0.3;
        let des = threshold(&l, &rho, 5).unwrap();
        // 5 requested = keep(load) + 4 densest: (4,2) 0.95 and the 0.9 bar cells x = 0..2
        // (ties → lower index) → the load needs (4,1) (0.9) and the weak link (3,1) (0.4).
        assert!(des.solid[d.index(3, 1, 0)]);
        assert_eq!(des.added_for_connectivity, 2);
        assert!(is_valid(&l, &des.solid));
        assert!(!des.solid[d.index(1, 2, 0)]);
        assert_eq!(des.count, 7); // keep + 5 bar cells + (4,2)
        assert!((des.volume - 7.0 / 18.0).abs() < 1e-15);
    }

    #[test]
    fn threshold_removes_floating_material() {
        let l = plate();
        let d = l.dims;
        let mut rho = vec![0.0; d.len()];
        for x in 0..5 {
            rho[d.index(x, 1, 0)] = 1.0;
        }
        rho[d.index(3, 0, 0)] = 0.01;
        rho[d.index(5, 0, 0)] = 0.99; // attached to the keep load cell → anchored
        let des = threshold(&l, &rho, 7).unwrap();
        assert_eq!(des.removed_floating, 0);
        assert_eq!(des.count, 7);
        // ask for one more: next densest is (3,0) — anchored too.
        let mut rho2 = rho.clone();
        rho2[d.index(1, 2, 0)] = 0.5;
        rho2[d.index(0, 2, 0)] = 0.0;
        let des2 = threshold(&l, &rho2, 8).unwrap();
        assert!(des2.solid[d.index(1, 2, 0)]);
        assert_eq!(des2.removed_floating, 0);
        // an island that touches nothing solid is removed
        let mut rho3 = vec![0.0; d.len()];
        for x in 0..6 {
            rho3[d.index(x, 0, 0)] = 1.0;
        }
        rho3[d.index(2, 2, 0)] = 0.8;
        let des3 = threshold(&l, &rho3, 8).unwrap();
        assert!(!des3.solid[d.index(2, 2, 0)]);
        assert_eq!(des3.removed_floating, 1);
        assert_eq!(des3.count, 7);
        assert!(is_valid(&l, &des3.solid));
    }

    #[test]
    fn unsupported_domain_is_an_error() {
        let mut l = plate();
        // cut the domain at x = 3
        for y in 0..3 {
            let e = l.dims.index(3, y, 0);
            l.domain[e] = false;
        }
        let rho = vec![1.0; l.n()];
        assert!(threshold(&l, &rho, 10).is_err());
    }
}
