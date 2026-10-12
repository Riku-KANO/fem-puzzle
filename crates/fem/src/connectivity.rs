//! Face (6-neighbour) connectivity over solid voxels.

use crate::grid::Grid;

/// Marks in `out` every `solid` element that is face-connected (through solid elements)
/// to a solid `seed` element. `queue` is scratch space (cleared; reuse it to avoid
/// allocations). All slices have one entry per element.
pub fn connected_to_seeds(
    grid: &Grid,
    solid: &[bool],
    seed: &[bool],
    out: &mut [bool],
    queue: &mut Vec<usize>,
) {
    let n = grid.elements();
    assert!(solid.len() == n && seed.len() == n && out.len() == n);
    out.fill(false);
    queue.clear();
    for e in 0..n {
        if solid[e] && seed[e] {
            out[e] = true;
            queue.push(e);
        }
    }
    // Depth-first flood fill; order does not matter.
    while let Some(e) = queue.pop() {
        grid.for_each_face_neighbour(e, |nb| {
            if solid[nb] && !out[nb] {
                out[nb] = true;
                queue.push(nb);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flood_fill_respects_face_adjacency_only() {
        let g = Grid {
            nx: 3,
            ny: 3,
            nz: 1,
            h: 1.0,
        };
        // Layout (y down):  S X .      S = seed+solid, X = solid
        //                   . . X      (2,1) only touches (1,0) by an edge → not connected
        //                   X X X      bottom row touches (2,1) by a face
        let mut solid = vec![false; 9];
        for e in [0, 1, 5, 6, 7, 8] {
            solid[e] = true;
        }
        let mut seed = vec![false; 9];
        seed[0] = true;
        let mut out = vec![false; 9];
        let mut q = Vec::new();
        connected_to_seeds(&g, &solid, &seed, &mut out, &mut q);
        let got: Vec<usize> = (0..9).filter(|&e| out[e]).collect();
        assert_eq!(got, vec![0, 1]);

        // Connecting (2,0) joins everything.
        solid[2] = true;
        connected_to_seeds(&g, &solid, &seed, &mut out, &mut q);
        assert_eq!(out, solid);

        // A seed that is not solid seeds nothing.
        solid[0] = false;
        connected_to_seeds(&g, &solid, &seed, &mut out, &mut q);
        assert!(out.iter().all(|&b| !b));
    }
}
