//! Voxel Hex8 linear-elastic FEM solver. Spec: `docs/specs/solver.md` (normative).
//!
//! - [`Problem::from_stage`] turns a stage into grid / masks / supports / nodal loads.
//! - [`Solver`] runs a matrix-free, masked, warm-started PCG ([`Precond`] is pluggable;
//!   [`Jacobi`] here, multigrid in `mg` by task T-201) and post-processes stresses.
//!
//! Conventions: element `x + nx*(y + ny*z)`, node `i + (nx+1)*(j + (ny+1)*k)`, DOF `3n+c`,
//! SI units. See [`grid`] and [`hex8`].

pub mod connectivity;
pub mod grid;
pub mod hex8;
pub mod mg;
pub mod operator;
mod pcg;
pub mod precond;
pub mod problem;
pub mod solver;

pub use grid::Grid;
pub use mg::{MgOptions, Multigrid};
pub use operator::{Operator, OperatorView};
pub use precond::{Jacobi, Precond};
pub use problem::{FemError, LoadCase, Material, Problem};
pub use solver::{Mode, Preconditioner, SolveStatus, Solver, SolverOptions};
