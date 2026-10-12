//! Pluggable preconditioners for the PCG solve.
//!
//! # Extension point (T-201 multigrid)
//!
//! A preconditioner implements [`Precond`]. The solver owns it as `Box<dyn Precond>`,
//! created by `make_precond` in `solver.rs` from [`Preconditioner`](crate::Preconditioner):
//!
//! - [`Precond::rebuild`] is called from `Solver::begin` (and `Solver::new`) whenever the
//!   fine operator changed (per-element `coef = E_e·h` or the free-DOF mask). The
//!   [`OperatorView`] carries everything a geometric multigrid needs: grid size, `Ke1`,
//!   per-element coefficients (0 = element skipped) and the DOF mask. The view is only
//!   borrowed for the call, so an implementation keeps its own copies and may diff
//!   against them for incremental rebuilds.
//! - [`Precond::apply`] computes `z = B r` for an SPD `B ≈ A⁻¹`, where the fine operator is
//!   `A = M K M + (I − M)`. On non-free DOFs it must return `z = r` (PCG keeps `r = 0`
//!   there, so `z` stays masked). It takes `&mut self` so implementations can keep work
//!   buffers and stay allocation-free per call.
//! - [`Precond::levels`] reports the number of multigrid levels (0 = not multigrid); it
//!   is surfaced as `Solver::levels()` for the worker's `ready.levels`.

use crate::operator::OperatorView;

/// A preconditioner `B ≈ A⁻¹` (symmetric positive definite) for the masked operator.
pub trait Precond: Send {
    /// Re-derive internal data after the operator changed.
    fn rebuild(&mut self, op: &OperatorView<'_>);
    /// `z = B r`. `z = r` on non-free DOFs.
    fn apply(&mut self, r: &[f64], z: &mut [f64]);
    /// Number of multigrid levels (0 = single-level preconditioner such as Jacobi).
    fn levels(&self) -> usize {
        0
    }
}

/// Diagonal (Jacobi) preconditioner `B = diag(A)⁻¹`.
#[derive(Debug, Clone, Default)]
pub struct Jacobi {
    inv_diag: Vec<f64>,
}

impl Precond for Jacobi {
    fn rebuild(&mut self, op: &OperatorView<'_>) {
        self.inv_diag.resize(op.free.len(), 0.0);
        op.diagonal(&mut self.inv_diag);
        for d in &mut self.inv_diag {
            *d = 1.0 / *d;
        }
    }

    fn apply(&mut self, r: &[f64], z: &mut [f64]) {
        for ((zi, ri), di) in z.iter_mut().zip(r).zip(&self.inv_diag) {
            *zi = ri * di;
        }
    }
}
