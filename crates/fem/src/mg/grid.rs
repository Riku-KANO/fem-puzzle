//! Level geometry helpers on top of [`crate::Grid`]: coarsening rule and node → element
//! adjacency. Every level uses unit voxels (`h = 1`; `coef` carries the scale).

use crate::grid::Grid;

/// Grid with `nx × ny × nz` unit voxels.
pub(crate) fn grid(nx: usize, ny: usize, nz: usize) -> Grid {
    Grid { nx, ny, nz, h: 1.0 }
}

/// Per-axis coarsening factor: 2 when the element count is even and > 1, else 1.
pub(crate) fn coarsening_factors(g: &Grid) -> [usize; 3] {
    let f = |n: usize| if n > 1 && n.is_multiple_of(2) { 2 } else { 1 };
    [f(g.nx), f(g.ny), f(g.nz)]
}

/// Next coarser level and the factors used, or `None` when no axis can be coarsened.
pub(crate) fn coarsen(g: &Grid) -> Option<(Grid, [usize; 3])> {
    let f = coarsening_factors(g);
    if f == [1, 1, 1] {
        return None;
    }
    Some((grid(g.nx / f[0], g.ny / f[1], g.nz / f[2]), f))
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
    fn semi_coarsening() {
        assert_eq!(coarsen(&grid(24, 8, 4)), Some((grid(12, 4, 2), [2, 2, 2])));
        assert_eq!(coarsen(&grid(6, 3, 1)), Some((grid(3, 3, 1), [2, 1, 1])));
        assert_eq!(coarsen(&grid(3, 3, 1)), None);
    }
}
