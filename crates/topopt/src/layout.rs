//! Grid indexing and the per-element masks the optimiser works with.

use crate::{Result, err};

/// Voxel grid dimensions. Element index `e = x + nx * (y + ny * z)` (stage-format.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dims {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
}

impl Dims {
    pub fn new(nx: usize, ny: usize, nz: usize) -> Dims {
        Dims { nx, ny, nz }
    }

    /// Number of elements.
    pub fn len(&self) -> usize {
        self.nx * self.ny * self.nz
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn index(&self, x: usize, y: usize, z: usize) -> usize {
        x + self.nx * (y + self.ny * z)
    }

    pub fn coords(&self, e: usize) -> [usize; 3] {
        let x = e % self.nx;
        let y = (e / self.nx) % self.ny;
        let z = e / (self.nx * self.ny);
        [x, y, z]
    }

    /// The (up to 6) face neighbours of element `e`.
    pub fn face_neighbors(&self, e: usize) -> impl Iterator<Item = usize> {
        let [x, y, z] = self.coords(e);
        let d = *self;
        let cand: [Option<usize>; 6] = [
            (x > 0).then(|| e - 1),
            (x + 1 < d.nx).then(|| e + 1),
            (y > 0).then(|| e - d.nx),
            (y + 1 < d.ny).then(|| e + d.nx),
            (z > 0).then(|| e - d.nx * d.ny),
            (z + 1 < d.nz).then(|| e + d.nx * d.ny),
        ];
        cand.into_iter().flatten()
    }
}

/// What the optimiser needs to know about a stage, as flat per-element arrays.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub dims: Dims,
    /// Initially solid (design domain incl. keep). Block / outside cells are `false`.
    pub domain: Vec<bool>,
    /// Protected cells (explicit keep + implicit support and load cells), `keep ⊆ domain`.
    pub keep: Vec<bool>,
    /// Cells with at least one fixed node.
    pub supported: Vec<bool>,
    /// Load cells of all load cases (sorted, unique).
    pub load_cells: Vec<usize>,
    /// Obstacle cells (display only).
    pub block: Vec<bool>,
}

impl Layout {
    pub fn n(&self) -> usize {
        self.dims.len()
    }

    pub fn domain_count(&self) -> usize {
        self.domain.iter().filter(|&&d| d).count()
    }

    pub fn keep_count(&self) -> usize {
        self.keep.iter().filter(|&&k| k).count()
    }

    /// Domain cells the optimiser may change.
    pub fn is_free(&self, e: usize) -> bool {
        self.domain[e] && !self.keep[e]
    }

    pub fn validate(&self) -> Result<()> {
        let n = self.n();
        if n == 0 {
            return err("empty grid");
        }
        for (name, v) in [
            ("domain", &self.domain),
            ("keep", &self.keep),
            ("supported", &self.supported),
            ("block", &self.block),
        ] {
            if v.len() != n {
                return err(format!("{name} has {} entries, expected {n}", v.len()));
            }
        }
        if (0..n).any(|e| self.keep[e] && !self.domain[e]) {
            return err("keep must be a subset of the domain");
        }
        if !(0..n).any(|e| self.supported[e] && self.domain[e]) {
            return err("no supported domain cell");
        }
        if self.load_cells.is_empty() {
            return err("no load cells");
        }
        if let Some(&c) = self.load_cells.iter().find(|&&c| c >= n || !self.domain[c]) {
            return err(format!("load cell {c} is not a domain cell"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_roundtrip_and_neighbors() {
        let d = Dims::new(4, 3, 2);
        for e in 0..d.len() {
            let [x, y, z] = d.coords(e);
            assert_eq!(d.index(x, y, z), e);
        }
        // corner has 3 neighbours, an interior-ish cell more
        assert_eq!(d.face_neighbors(0).count(), 3);
        let e = d.index(1, 1, 0);
        let mut nb: Vec<usize> = d.face_neighbors(e).collect();
        nb.sort();
        assert_eq!(
            nb,
            vec![
                d.index(1, 0, 0),
                d.index(0, 1, 0),
                d.index(2, 1, 0),
                d.index(1, 2, 0),
                d.index(1, 1, 1)
            ]
        );
    }
}
