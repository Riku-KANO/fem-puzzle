//! Structured voxel grid and its indexing conventions (`docs/specs/stage-format.md`).
//!
//! - element `e = x + nx * (y + ny * z)` for cell `(x, y, z)`;
//! - node `n = i + (nx+1) * (j + (ny+1) * k)` for node `(i, j, k)`;
//! - DOF `3 * n + c`, `c ∈ {0: x, 1: y, 2: z}`.

/// Local node offsets `(dx, dy, dz)` of the Hex8 element, in the spec's local node order.
pub const HEX8_NODE_OFFSETS: [[usize; 3]; 8] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
];

/// A grid of `nx × ny × nz` cubic voxels of edge `h` (m), origin at the min corner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    /// Voxel edge length (m).
    pub h: f64,
}

impl Grid {
    /// Number of elements (voxels).
    pub fn elements(&self) -> usize {
        self.nx * self.ny * self.nz
    }

    /// Number of nodes `(nx+1)(ny+1)(nz+1)`.
    pub fn nodes(&self) -> usize {
        (self.nx + 1) * (self.ny + 1) * (self.nz + 1)
    }

    /// Number of DOFs (`3 * nodes`).
    pub fn dofs(&self) -> usize {
        3 * self.nodes()
    }

    /// Element index of cell `(x, y, z)`.
    pub fn element_index(&self, x: usize, y: usize, z: usize) -> usize {
        x + self.nx * (y + self.ny * z)
    }

    /// Cell coordinates `(x, y, z)` of element `e`.
    pub fn element_coords(&self, e: usize) -> [usize; 3] {
        [
            e % self.nx,
            (e / self.nx) % self.ny,
            e / (self.nx * self.ny),
        ]
    }

    /// Node index of node `(i, j, k)`.
    pub fn node_index(&self, i: usize, j: usize, k: usize) -> usize {
        i + (self.nx + 1) * (j + (self.ny + 1) * k)
    }

    /// Node coordinates `(i, j, k)` of node `n`.
    pub fn node_coords(&self, n: usize) -> [usize; 3] {
        let sx = self.nx + 1;
        let sy = self.ny + 1;
        [n % sx, (n / sx) % sy, n / (sx * sy)]
    }

    /// Offsets of the 8 element nodes relative to the element's node 0, in local order.
    /// `element_nodes(e)[a] = node0(e) + node_offsets()[a]`.
    pub fn node_offsets(&self) -> [usize; 8] {
        let sx = self.nx + 1;
        let sxy = sx * (self.ny + 1);
        HEX8_NODE_OFFSETS.map(|[dx, dy, dz]| dx + sx * dy + sxy * dz)
    }

    /// Node 0 (min corner) of element `e`.
    pub fn element_node0(&self, e: usize) -> usize {
        let [x, y, z] = self.element_coords(e);
        self.node_index(x, y, z)
    }

    /// The 8 global node indices of element `e`, in the spec's local node order.
    pub fn element_nodes(&self, e: usize) -> [usize; 8] {
        let n0 = self.element_node0(e);
        self.node_offsets().map(|o| n0 + o)
    }

    /// The 24 global DOF indices of element `e`: `[n0x n0y n0z n1x … n7z]`.
    pub fn element_dofs(&self, e: usize) -> [usize; 24] {
        let nodes = self.element_nodes(e);
        std::array::from_fn(|i| 3 * nodes[i / 3] + i % 3)
    }

    /// Calls `f(neighbour)` for each face neighbour (6-adjacency) of element `e`.
    pub fn for_each_face_neighbour(&self, e: usize, mut f: impl FnMut(usize)) {
        let [x, y, z] = self.element_coords(e);
        let sxy = self.nx * self.ny;
        if x > 0 {
            f(e - 1);
        }
        if x + 1 < self.nx {
            f(e + 1);
        }
        if y > 0 {
            f(e - self.nx);
        }
        if y + 1 < self.ny {
            f(e + self.nx);
        }
        if z > 0 {
            f(e - sxy);
        }
        if z + 1 < self.nz {
            f(e + sxy);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> Grid {
        Grid {
            nx: 4,
            ny: 3,
            nz: 2,
            h: 0.5,
        }
    }

    #[test]
    fn counts() {
        let g = grid();
        assert_eq!(g.elements(), 24);
        assert_eq!(g.nodes(), 5 * 4 * 3);
        assert_eq!(g.dofs(), 3 * 60);
    }

    #[test]
    fn index_roundtrip() {
        let g = grid();
        for e in 0..g.elements() {
            let [x, y, z] = g.element_coords(e);
            assert_eq!(g.element_index(x, y, z), e);
        }
        for n in 0..g.nodes() {
            let [i, j, k] = g.node_coords(n);
            assert_eq!(g.node_index(i, j, k), n);
        }
    }

    #[test]
    fn element_nodes_follow_local_order() {
        let g = grid();
        let e = g.element_index(2, 1, 1);
        let nodes = g.element_nodes(e);
        for (a, [dx, dy, dz]) in HEX8_NODE_OFFSETS.iter().enumerate() {
            assert_eq!(nodes[a], g.node_index(2 + dx, 1 + dy, 1 + dz));
        }
        let dofs = g.element_dofs(e);
        assert_eq!(dofs[0], 3 * nodes[0]);
        assert_eq!(dofs[23], 3 * nodes[7] + 2);
    }

    #[test]
    fn face_neighbours() {
        let g = grid();
        let mut n = Vec::new();
        g.for_each_face_neighbour(0, |e| n.push(e));
        n.sort();
        assert_eq!(n, vec![1, 4, 12]);
        let mut n = Vec::new();
        g.for_each_face_neighbour(g.element_index(1, 1, 1), |e| n.push(e));
        assert_eq!(n.len(), 5);
    }
}
