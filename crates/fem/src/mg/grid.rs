//! Level geometry helpers on top of [`crate::Grid`]: the coarsening rule and node → element
//! adjacency. Every level uses unit voxels (`h = 1`; `coef` carries the scale).
//!
//! # Coarsening rule
//! Every axis with `n > 1` cells is coarsened to `⌈n/2⌉` cells. For even `n` all coarse
//! cells are two fine cells wide; for odd `n` the **last** coarse cell is one fine cell
//! wide (its nodes coincide with fine nodes, so interpolation there is injection). The coarse
//! grid is then geometrically non-uniform, which the element-wise Galerkin product handles
//! exactly. `n = 1` axes are not coarsened. Even grids get the plain 2× hierarchy.

use crate::grid::Grid;

/// Grid with `nx × ny × nz` unit voxels.
pub(crate) fn grid(nx: usize, ny: usize, nz: usize) -> Grid {
    Grid { nx, ny, nz, h: 1.0 }
}

/// Child variant along one axis: left / right half of a two-cell-wide coarse cell, or the
/// only child of a one-cell-wide coarse cell.
pub(crate) const VARIANT_LEFT: usize = 0;
pub(crate) const VARIANT_RIGHT: usize = 1;
pub(crate) const VARIANT_SINGLE: usize = 2;

/// `(offset inside the coarse cell, coarse cell width)` of a child variant.
pub(crate) fn variant_offset_width(v: usize) -> (usize, usize) {
    match v {
        VARIANT_LEFT => (0, 2),
        VARIANT_RIGHT => (1, 2),
        _ => (0, 1),
    }
}

/// Coarsening of one axis from `fine` to `coarse` cells (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AxisCoarsening {
    pub fine: usize,
    pub coarse: usize,
}

impl AxisCoarsening {
    pub fn new(fine: usize) -> Self {
        let coarse = if fine > 1 { fine.div_ceil(2) } else { fine };
        Self { fine, coarse }
    }

    pub fn coarsened(&self) -> bool {
        self.coarse < self.fine
    }

    /// Coarse cell and child variant of fine cell `x`.
    pub fn cell(&self, x: usize) -> (usize, usize) {
        if !self.coarsened() {
            (x, VARIANT_SINGLE)
        } else if x < 2 * (self.fine / 2) {
            (x / 2, x % 2)
        } else {
            // The single-width last cell of an odd axis.
            (self.coarse - 1, VARIANT_SINGLE)
        }
    }

    /// Fine cells `(x, variant)` of coarse cell `c` and their count.
    pub fn children(&self, c: usize) -> ([(usize, usize); 2], usize) {
        if !self.coarsened() {
            ([(c, VARIANT_SINGLE), (0, 0)], 1)
        } else if 2 * c + 1 < self.fine {
            ([(2 * c, VARIANT_LEFT), (2 * c + 1, VARIANT_RIGHT)], 2)
        } else {
            ([(2 * c, VARIANT_SINGLE), (0, 0)], 1)
        }
    }

    /// Interpolation of fine node `i`: up to two `(coarse node, weight)` pairs (unused
    /// entries have weight 0).
    pub fn stencil(&self, i: usize) -> [(usize, f64); 2] {
        if !self.coarsened() || i.is_multiple_of(2) {
            [(if self.coarsened() { i / 2 } else { i }, 1.0), (0, 0.0)]
        } else if i == self.fine {
            // Last node of an odd axis = last coarse node.
            [(self.coarse, 1.0), (0, 0.0)]
        } else {
            [((i - 1) / 2, 0.5), (i.div_ceil(2), 0.5)]
        }
    }

    /// Position of coarse node `c` in fine node units.
    #[cfg(test)]
    pub fn coarse_node_position(&self, c: usize) -> usize {
        if self.coarsened() {
            (2 * c).min(self.fine)
        } else {
            c
        }
    }
}

/// Next coarser level and the per-axis coarsening, or `None` when no axis can be coarsened.
pub(crate) fn coarsen(g: &Grid) -> Option<(Grid, [AxisCoarsening; 3])> {
    let ax = [
        AxisCoarsening::new(g.nx),
        AxisCoarsening::new(g.ny),
        AxisCoarsening::new(g.nz),
    ];
    if !ax.iter().any(AxisCoarsening::coarsened) {
        return None;
    }
    Some((grid(ax[0].coarse, ax[1].coarse, ax[2].coarse), ax))
}

/// Elements touching node `n` (1 to 8), appended to `out` after clearing it.
pub(crate) fn node_elems(g: &Grid, n: usize, out: &mut Vec<usize>) {
    out.clear();
    let [i, j, k] = g.node_coords(n);
    for dz in 0..2 {
        for dy in 0..2 {
            for dx in 0..2 {
                // Element (i + dx − 1, j + dy − 1, k + dz − 1) when inside the grid.
                let (Some(x), Some(y), Some(z)) = (
                    (i + dx).checked_sub(1),
                    (j + dy).checked_sub(1),
                    (k + dz).checked_sub(1),
                ) else {
                    continue;
                };
                if x < g.nx && y < g.ny && z < g.nz {
                    out.push(g.element_index(x, y, z));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_elems_is_inverse_of_element_nodes() {
        let g = grid(4, 3, 2);
        let mut v = Vec::new();
        node_elems(&g, g.node_index(1, 1, 1), &mut v);
        assert_eq!(v.len(), 8);
        node_elems(&g, 0, &mut v);
        assert_eq!(v, vec![0]);
        for n in 0..g.nodes() {
            node_elems(&g, n, &mut v);
            for e in 0..g.elements() {
                assert_eq!(g.element_nodes(e).contains(&n), v.contains(&e));
            }
        }
    }

    #[test]
    fn coarsening_rule() {
        let dims = |c: Option<(Grid, [AxisCoarsening; 3])>| c.map(|(g, _)| [g.nx, g.ny, g.nz]);
        assert_eq!(dims(coarsen(&grid(24, 8, 4))), Some([12, 4, 2]));
        assert_eq!(dims(coarsen(&grid(6, 3, 1))), Some([3, 2, 1]));
        assert_eq!(dims(coarsen(&grid(31, 11, 11))), Some([16, 6, 6]));
        assert_eq!(dims(coarsen(&grid(3, 1, 1))), Some([2, 1, 1]));
        assert_eq!(coarsen(&grid(1, 1, 1)), None);
    }

    #[test]
    fn axis_cells_children_and_stencils_agree() {
        for n in 1..9 {
            let a = AxisCoarsening::new(n);
            // Every fine cell is the child of exactly the cell it maps to.
            let mut seen = vec![false; n];
            for c in 0..a.coarse {
                let (ch, cnt) = a.children(c);
                for &(x, v) in &ch[..cnt] {
                    assert_eq!(a.cell(x), (c, v), "n {n} x {x}");
                    assert!(!seen[x]);
                    seen[x] = true;
                }
            }
            assert!(seen.iter().all(|&s| s));
            // Stencils reproduce the coarse node positions (linear functions exactly).
            for i in 0..=n {
                let st = a.stencil(i);
                let w: f64 = st.iter().map(|s| s.1).sum();
                assert!((w - 1.0).abs() < 1e-15);
                let pos: f64 = st
                    .iter()
                    .map(|&(c, wt)| wt * a.coarse_node_position(c) as f64)
                    .sum();
                assert!((pos - i as f64).abs() < 1e-15, "n {n} node {i}");
                assert!(st.iter().all(|&(c, wt)| wt == 0.0 || c <= a.coarse));
            }
        }
    }
}
