//! Offline SIMP/OC topology optimiser (task `T-203`).
//!
//! Computes the "algorithm's answer" for every stage and uses it to calibrate the stage:
//! loads are scaled so the thresholded benchmark design sits at 90 % utilisation, and the
//! star targets are placed relative to its volume. Numerics: `docs/specs/solver.md`;
//! stage semantics: `docs/specs/stage-format.md`.
//!
//! The pieces that do not need the FEM solver (density filter, OC update, thresholding,
//! connectivity, JSON rewrite) are plain functions over flat per-element arrays so they can
//! be unit-tested in isolation; [`simp`] drives them through the [`simp::Analysis`] trait.

pub mod ascii;
pub mod calibrate;
pub mod cli;
pub mod design;
pub mod filter;
pub mod layout;
pub mod oc;
pub mod simp;
pub mod stagejson;

use std::fmt;

/// Errors surfaced to the CLI. Messages are user-facing (stage authors).
#[derive(Debug, Clone, PartialEq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<stage::StageError> for Error {
    fn from(e: stage::StageError) -> Self {
        Error(e.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error(format!("json: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Shorthand for an `Err(Error(..))`.
pub fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error(msg.into()))
}
