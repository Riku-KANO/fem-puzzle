//! Problem definition and its construction from a stage (`docs/specs/stage-format.md`).

use crate::grid::{Grid, HEX8_NODE_OFFSETS};
use std::fmt;

/// Isotropic linear-elastic material.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Material {
    /// Young's modulus `E₀` (Pa) of solid material.
    pub e: f64,
    /// Poisson ratio.
    pub nu: f64,
    /// Allowable von Mises stress (Pa); utilisation = `σ_vm / allowable`.
    pub allowable: f64,
}

/// One load case: nodal forces plus the cells the loads were applied to.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadCase {
    /// Case name (`"default"` for a stage without `loadCases`).
    pub name: String,
    /// Nodal force per DOF (N), length `3 * nodes`.
    pub force: Vec<f64>,
    /// Loaded elements (sorted, unique).
    pub load_cells: Vec<usize>,
}

/// A voxel FEM problem: grid, material, design domain, supports and load cases.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    /// Voxel grid (`h` = stage `voxelSize`).
    pub grid: Grid,
    /// Solid material (`E₀`, `ν`, allowable stress).
    pub material: Material,
    /// Per element: initially solid (the design domain).
    pub domain: Vec<bool>,
    /// Per element: protected (`keep` plus implicit support/load cells).
    pub keep: Vec<bool>,
    /// Per element: domain element with at least one node fixed by a support.
    pub supported: Vec<bool>,
    /// Per DOF: held at `u = 0` by a support.
    pub fixed: Vec<bool>,
    /// Load cases (at least one).
    pub cases: Vec<LoadCase>,
}

/// Errors building a [`Problem`].
#[derive(Debug, Clone, PartialEq)]
pub enum FemError {
    /// The stage failed validation (`stage::Stage::validate`).
    Stage(stage::StageError),
    /// The problem is inconsistent (e.g. array lengths do not match the grid).
    Invalid(String),
}

impl fmt::Display for FemError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FemError::Stage(e) => write!(f, "{e}"),
            FemError::Invalid(msg) => write!(f, "invalid problem: {msg}"),
        }
    }
}

impl std::error::Error for FemError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            FemError::Stage(e) => Some(e),
            FemError::Invalid(_) => None,
        }
    }
}

impl From<stage::StageError> for FemError {
    fn from(e: stage::StageError) -> Self {
        FemError::Stage(e)
    }
}

/// Local node numbers (0..8) lying on `face` of an element.
fn face_local_nodes(face: stage::Face) -> impl Iterator<Item = usize> {
    let axis = face.axis();
    let side = usize::from(face.is_positive());
    (0..8).filter(move |&a| HEX8_NODE_OFFSETS[a][axis] == side)
}

impl Problem {
    /// Build the problem for a stage: validates the stage, decodes the masks, fixes the
    /// support nodes and distributes the loads (each load's force is split equally among
    /// its cells, each cell's share equally among its 8 nodes).
    pub fn from_stage(stage: &stage::Stage) -> Result<Problem, FemError> {
        stage.validate()?;
        let [nx, ny, nz] = stage.grid;
        let grid = Grid {
            nx,
            ny,
            nz,
            h: stage.voxel_size,
        };
        let n = grid.elements();
        let domain = stage.solid.to_bools(n)?;
        let mut keep = stage.effective_keep()?;
        for (k, &d) in keep.iter_mut().zip(&domain) {
            *k &= d;
        }

        // Supports → fixed DOFs.
        let mut fixed = vec![false; grid.dofs()];
        for s in &stage.supports {
            let comps = s.fixed_components();
            let mut fix_cell = |e: usize| {
                let nodes = grid.element_nodes(e);
                for a in face_local_nodes(s.face) {
                    for (c, &on) in comps.iter().enumerate() {
                        if on {
                            fixed[3 * nodes[a] + c] = true;
                        }
                    }
                }
            };
            match &s.cells {
                Some(cells) => {
                    for &[x, y, z] in cells {
                        fix_cell(grid.element_index(x, y, z));
                    }
                }
                None => {
                    let axis = s.face.axis();
                    let layer = if s.face.is_positive() {
                        [nx, ny, nz][axis] - 1
                    } else {
                        0
                    };
                    for e in (0..n).filter(|&e| domain[e]) {
                        if grid.element_coords(e)[axis] == layer {
                            fix_cell(e);
                        }
                    }
                }
            }
        }
        let supported = (0..n)
            .map(|e| {
                domain[e]
                    && grid
                        .element_nodes(e)
                        .iter()
                        .any(|&nd| fixed[3 * nd..3 * nd + 3].iter().any(|&f| f))
            })
            .collect();

        // Loads.
        let cases = stage
            .cases()
            .into_iter()
            .map(|case| {
                let mut force = vec![0.0; grid.dofs()];
                let mut load_cells = Vec::new();
                for load in &case.loads {
                    let share = 1.0 / (8.0 * load.cells.len() as f64);
                    for &[x, y, z] in &load.cells {
                        let e = grid.element_index(x, y, z);
                        load_cells.push(e);
                        for nd in grid.element_nodes(e) {
                            for c in 0..3 {
                                force[3 * nd + c] += load.force[c] * share;
                            }
                        }
                    }
                }
                load_cells.sort_unstable();
                load_cells.dedup();
                LoadCase {
                    name: case.name,
                    force,
                    load_cells,
                }
            })
            .collect();

        let problem = Problem {
            grid,
            material: Material {
                e: stage.material.e,
                nu: stage.material.nu,
                allowable: stage.material.allowable,
            },
            domain,
            keep,
            supported,
            fixed,
            cases,
        };
        problem.validate()?;
        Ok(problem)
    }

    /// Check array lengths and value ranges (useful for hand-built problems).
    pub fn validate(&self) -> Result<(), FemError> {
        let bad = |m: String| Err(FemError::Invalid(m));
        let g = &self.grid;
        let n = g.elements();
        if n == 0 || !(g.h.is_finite() && g.h > 0.0) {
            return bad(format!("bad grid {g:?}"));
        }
        let m = &self.material;
        let finite_pos = |v: f64| v.is_finite() && v > 0.0;
        if !finite_pos(m.e) || !finite_pos(m.allowable) || !(m.nu > -1.0 && m.nu < 0.5) {
            return bad(format!("bad material {m:?}"));
        }
        for (name, len) in [
            ("domain", self.domain.len()),
            ("keep", self.keep.len()),
            ("supported", self.supported.len()),
        ] {
            if len != n {
                return bad(format!("{name} has {len} entries, expected {n}"));
            }
        }
        if self.fixed.len() != g.dofs() {
            return bad(format!("fixed has {} entries", self.fixed.len()));
        }
        if self.cases.is_empty() {
            return bad("no load cases".into());
        }
        for c in &self.cases {
            if c.force.len() != g.dofs() || c.force.iter().any(|f| !f.is_finite()) {
                return bad(format!("load case {:?}: bad force vector", c.name));
            }
            if c.load_cells.iter().any(|&e| e >= n) {
                return bad(format!("load case {:?}: load cell out of range", c.name));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use stage::{Bitmask, Face, Load, Stage, Support, Targets};

    fn stage_with(supports: Vec<Support>, loads: Vec<Load>, solid: Vec<bool>) -> Stage {
        Stage {
            version: 1,
            id: "t".into(),
            title: String::new(),
            world: 0,
            grid: [4, 3, 2],
            voxel_size: 0.1,
            material: stage::Material {
                e: 1e9,
                nu: 0.3,
                allowable: 1e6,
                density: None,
            },
            keep: Bitmask::from_bools(&vec![false; solid.len()]),
            solid: Bitmask::from_bools(&solid),
            block: None,
            supports,
            loads,
            load_cases: None,
            max_displacement: None,
            targets: Targets {
                star1: 0.8,
                star2: 0.6,
                star3: 0.4,
            },
            benchmark: None,
            hints: vec![],
        }
    }

    fn tip_load() -> Vec<Load> {
        vec![Load {
            cells: vec![[3, 0, 0], [3, 0, 1]],
            force: [0.0, -80.0, 16.0],
        }]
    }

    #[test]
    fn face_support_fixes_only_nodes_of_solid_boundary_cells() {
        let mut solid = vec![true; 24];
        // Carve cell (0, 2, 1) from the x- face.
        solid[2 * 4 + 12] = false;
        let s = stage_with(
            vec![Support {
                face: Face::XNeg,
                fix: "xz".into(),
                cells: None,
            }],
            tip_load(),
            solid,
        );
        let p = Problem::from_stage(&s).unwrap();
        let g = p.grid;
        for n in 0..g.nodes() {
            let [i, j, k] = g.node_coords(n);
            // Node (0, 3, 2) only belongs to the carved cell.
            let expect = i == 0 && !(j == 3 && k == 2);
            assert_eq!(p.fixed[3 * n], expect, "node {i},{j},{k}");
            assert!(!p.fixed[3 * n + 1]);
            assert_eq!(p.fixed[3 * n + 2], expect);
        }
        for e in 0..g.elements() {
            let [x, ..] = g.element_coords(e);
            assert_eq!(p.supported[e], x == 0 && p.domain[e], "element {e}");
        }
    }

    #[test]
    fn cell_support_fixes_the_given_face_of_listed_cells() {
        let s = stage_with(
            vec![Support {
                face: Face::YNeg,
                fix: "y".into(),
                cells: Some(vec![[1, 0, 0]]),
            }],
            tip_load(),
            vec![true; 24],
        );
        let p = Problem::from_stage(&s).unwrap();
        let g = p.grid;
        let fixed_nodes: Vec<usize> = (0..g.nodes()).filter(|&n| p.fixed[3 * n + 1]).collect();
        let mut expect = vec![
            g.node_index(1, 0, 0),
            g.node_index(2, 0, 0),
            g.node_index(1, 0, 1),
            g.node_index(2, 0, 1),
        ];
        expect.sort();
        assert_eq!(fixed_nodes, expect);
        assert_eq!(p.fixed.iter().filter(|&&f| f).count(), 4);
        // Support cell is implicitly keep.
        assert!(p.keep[g.element_index(1, 0, 0)]);
        // Elements sharing a fixed node count as supported.
        assert!(p.supported[g.element_index(0, 0, 0)]);
        assert!(p.supported[g.element_index(2, 0, 1)]);
        assert!(!p.supported[g.element_index(3, 0, 0)]);
        assert!(!p.supported[g.element_index(1, 1, 0)]);
    }

    #[test]
    fn loads_are_split_over_cells_and_nodes() {
        let s = stage_with(
            vec![Support {
                face: Face::XNeg,
                fix: "xyz".into(),
                cells: None,
            }],
            tip_load(),
            vec![true; 24],
        );
        let p = Problem::from_stage(&s).unwrap();
        let g = p.grid;
        let c = &p.cases[0];
        assert_eq!(c.name, "default");
        assert_eq!(
            c.load_cells,
            vec![g.element_index(3, 0, 0), g.element_index(3, 0, 1)]
        );
        let total: [f64; 3] =
            std::array::from_fn(|k| (0..g.nodes()).map(|n| c.force[3 * n + k]).sum());
        assert!((total[0]).abs() < 1e-12);
        assert!((total[1] + 80.0).abs() < 1e-12);
        assert!((total[2] - 16.0).abs() < 1e-12);
        // A node shared by both load cells gets 2 × (80 / 2 / 8).
        let shared = g.node_index(4, 0, 1);
        assert!((c.force[3 * shared + 1] + 10.0).abs() < 1e-12);
        let single = g.node_index(3, 1, 0);
        assert!((c.force[3 * single + 1] + 5.0).abs() < 1e-12);
        assert!(p.keep[g.element_index(3, 0, 0)]);
    }

    #[test]
    fn invalid_stage_is_an_error_not_a_panic() {
        let mut s = stage_with(
            vec![Support {
                face: Face::XNeg,
                fix: "xyz".into(),
                cells: None,
            }],
            vec![Load {
                cells: vec![[9, 0, 0]],
                force: [0.0, -1.0, 0.0],
            }],
            vec![true; 24],
        );
        assert!(matches!(Problem::from_stage(&s), Err(FemError::Stage(_))));
        s.loads[0].cells = vec![[3, 0, 0]];
        s.solid = Bitmask::from_bools(&[true; 3]);
        assert!(Problem::from_stage(&s).is_err());
    }
}
