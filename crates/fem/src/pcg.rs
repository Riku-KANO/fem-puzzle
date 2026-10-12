//! Resumable preconditioned conjugate gradients on the masked operator.
//!
//! The state (`r`, `z`, `p`, `q`, `rᵀz`) lives here between calls so the solver can run
//! a few iterations at a time (`Solver::iterate`). Work vectors are allocated once.

use crate::operator::Operator;
use crate::precond::Precond;

/// How often a recursive-residual "convergence" may be refuted by the true residual
/// (each refutation restarts CG from the current iterate) before giving up.
const MAX_RESTARTS: usize = 4;

/// Outcome of one PCG iteration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Step {
    /// Not converged yet; current relative residual.
    Continue(f64),
    /// `‖r‖/‖f‖ ≤ tol` (checked with the true residual).
    Converged(f64),
    /// No further progress possible (`pᵀAp ≤ 0`, non-finite values, or the true
    /// residual repeatedly fails to follow the recursive one).
    Stalled(f64),
}

#[derive(Debug, Clone)]
pub(crate) struct Pcg {
    r: Vec<f64>,
    z: Vec<f64>,
    p: Vec<f64>,
    q: Vec<f64>,
    rz: f64,
    f_norm: f64,
    rel: f64,
    restarts: usize,
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

impl Pcg {
    pub(crate) fn new(n: usize) -> Pcg {
        Pcg {
            r: vec![0.0; n],
            z: vec![0.0; n],
            p: vec![0.0; n],
            q: vec![0.0; n],
            rz: 0.0,
            f_norm: 0.0,
            rel: 0.0,
            restarts: 0,
        }
    }

    /// `r = M (f − A x)`; returns `‖r‖`.
    fn true_residual(&mut self, op: &Operator, f: &[f64], x: &[f64]) -> f64 {
        op.apply(x, &mut self.q);
        let mut rr = 0.0;
        for (((r, &fi), &ax), &free) in self.r.iter_mut().zip(f).zip(&self.q).zip(op.free()) {
            *r = if free { fi - ax } else { 0.0 };
            rr += *r * *r;
        }
        rr.sqrt()
    }

    /// `z = B r`, `p = z`, `rz = rᵀz`.
    fn restart_direction(&mut self, pc: &mut dyn Precond) {
        pc.apply(&self.r, &mut self.z);
        self.p.copy_from_slice(&self.z);
        self.rz = dot(&self.r, &self.z);
    }

    /// Start a solve of `A x = M f` from the initial guess `x` (masked in place; non-finite
    /// entries are reset to 0). Returns the initial relative residual (0 if `M f = 0`,
    /// in which case `x` is set to 0).
    pub(crate) fn start(
        &mut self,
        op: &Operator,
        pc: &mut dyn Precond,
        f: &[f64],
        x: &mut [f64],
    ) -> f64 {
        self.restarts = 0;
        let mut ff = 0.0;
        for ((xi, &fi), &free) in x.iter_mut().zip(f).zip(op.free()) {
            if !free || !xi.is_finite() {
                *xi = 0.0;
            }
            if free {
                ff += fi * fi;
            }
        }
        self.f_norm = ff.sqrt();
        if self.f_norm == 0.0 || !self.f_norm.is_finite() {
            x.fill(0.0);
            self.r.fill(0.0);
            self.rel = 0.0;
            return 0.0;
        }
        self.rel = self.true_residual(op, f, x) / self.f_norm;
        self.restart_direction(pc);
        self.rel
    }

    /// Current relative residual `‖r‖ / ‖M f‖`.
    pub(crate) fn rel_residual(&self) -> f64 {
        self.rel
    }

    /// One PCG iteration, updating `x` in place.
    pub(crate) fn step(
        &mut self,
        op: &Operator,
        pc: &mut dyn Precond,
        f: &[f64],
        x: &mut [f64],
        tol: f64,
    ) -> Step {
        op.apply(&self.p, &mut self.q);
        let pq = dot(&self.p, &self.q);
        if !(pq > 0.0 && pq.is_finite() && self.rz.is_finite()) {
            return Step::Stalled(self.rel);
        }
        let alpha = self.rz / pq;
        let mut rr = 0.0;
        for (((xi, ri), &pi), &qi) in x.iter_mut().zip(&mut self.r).zip(&self.p).zip(&self.q) {
            *xi += alpha * pi;
            *ri -= alpha * qi;
            rr += *ri * *ri;
        }
        self.rel = rr.sqrt() / self.f_norm;
        if !self.rel.is_finite() {
            return Step::Stalled(self.rel);
        }
        if self.rel <= tol {
            // Guard against drift of the recursive residual.
            self.rel = self.true_residual(op, f, x) / self.f_norm;
            if self.rel <= tol {
                return Step::Converged(self.rel);
            }
            if self.restarts >= MAX_RESTARTS {
                return Step::Stalled(self.rel);
            }
            self.restarts += 1;
            self.restart_direction(pc);
            return Step::Continue(self.rel);
        }
        pc.apply(&self.r, &mut self.z);
        let rz_new = dot(&self.r, &self.z);
        let beta = rz_new / self.rz;
        self.rz = rz_new;
        for (pi, &zi) in self.p.iter_mut().zip(&self.z) {
            *pi = zi + beta * *pi;
        }
        Step::Continue(self.rel)
    }
}
