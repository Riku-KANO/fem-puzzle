//! Parsing of the `optionsJson` constructor argument.
//!
//! The JSON is the `SolverOptionsMsg` of `packages/protocol/src/worker.ts`
//! (`{ tol?, maxIters?, preconditioner?, progressEveryMs?, backend? }`). Only the fields
//! the solver needs are read; JS-side fields (`progressEveryMs`, `backend`) and unknown
//! fields are ignored so the worker can forward the message unchanged.

use serde::Deserialize;

/// Relative residual target when `tol` is not given. The game default from
/// `SolverOptionsMsg` (the native solver default of `1e-6` is for offline tools).
pub const DEFAULT_TOL: f64 = 1e-4;

/// PCG iteration cap per load case when `maxIters` is not given. A safety net only:
/// a well-posed stage converges far below it, an ill-posed one (rigid-body modes left
/// by the supports) stops here with `done = true` instead of looping forever.
pub const DEFAULT_MAX_ITERS: usize = 20_000;

/// Which preconditioner the solver should use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Precond {
    Jacobi,
    Multigrid,
}

/// Validated session options.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SessionOptions {
    pub tol: f64,
    pub max_iters: usize,
    pub preconditioner: Precond,
}

impl Default for SessionOptions {
    fn default() -> Self {
        SessionOptions {
            tol: DEFAULT_TOL,
            max_iters: DEFAULT_MAX_ITERS,
            // solver.md: Multigrid is the default (the solver falls back to Jacobi
            // while multigrid is not available).
            preconditioner: Precond::Multigrid,
        }
    }
}

/// Raw JSON shape. Numbers are read as `f64` because that is what JS sends
/// (`JSON.stringify(1e3)` is `"1000"`, but hand-written JSON may say `1e3`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOptions {
    tol: Option<f64>,
    max_iters: Option<f64>,
    preconditioner: Option<String>,
}

/// Parse `optionsJson`. An empty string, `null` or `{}` gives the defaults.
pub fn parse_options(json: &str) -> Result<SessionOptions, String> {
    let json = json.trim();
    if json.is_empty() || json == "null" {
        return Ok(SessionOptions::default());
    }
    let raw: RawOptions =
        serde_json::from_str(json).map_err(|e| format!("invalid solver options: {e}"))?;
    let mut opts = SessionOptions::default();
    if let Some(tol) = raw.tol {
        if !(tol.is_finite() && tol > 0.0 && tol < 1.0) {
            return Err(format!(
                "invalid solver options: tol must be in (0, 1), got {tol}"
            ));
        }
        opts.tol = tol;
    }
    if let Some(n) = raw.max_iters {
        // `usize::MAX as f64` rounds up, so compare against a bound that is exact in f64.
        let ok = n.is_finite() && n >= 1.0 && n.fract() == 0.0 && n <= u32::MAX as f64;
        if !ok {
            return Err(format!(
                "invalid solver options: maxIters must be a positive integer, got {n}"
            ));
        }
        opts.max_iters = n as usize;
    }
    if let Some(p) = raw.preconditioner {
        opts.preconditioner = match p.as_str() {
            "jacobi" => Precond::Jacobi,
            "multigrid" => Precond::Multigrid,
            other => {
                return Err(format!(
                    "invalid solver options: preconditioner must be \"jacobi\" or \"multigrid\", got {other:?}"
                ));
            }
        };
    }
    Ok(opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_null_and_braces_give_defaults() {
        for json in ["", "  ", "null", "{}", " { } "] {
            assert_eq!(
                parse_options(json),
                Ok(SessionOptions::default()),
                "{json:?}"
            );
        }
        let d = SessionOptions::default();
        assert_eq!(d.tol, 1e-4);
        assert_eq!(d.max_iters, DEFAULT_MAX_ITERS);
        assert_eq!(d.preconditioner, Precond::Multigrid);
    }

    #[test]
    fn reads_all_fields() {
        let o = parse_options(r#"{"tol":1e-6,"maxIters":500,"preconditioner":"jacobi"}"#).unwrap();
        assert_eq!(
            o,
            SessionOptions {
                tol: 1e-6,
                max_iters: 500,
                preconditioner: Precond::Jacobi
            }
        );
        let o = parse_options(r#"{"preconditioner":"multigrid","maxIters":1e3}"#).unwrap();
        assert_eq!(o.preconditioner, Precond::Multigrid);
        assert_eq!(o.max_iters, 1000);
        assert_eq!(o.tol, DEFAULT_TOL);
    }

    #[test]
    fn ignores_js_side_and_unknown_fields() {
        let o = parse_options(
            r#"{"tol":1e-5,"progressEveryMs":60,"backend":"wasm","somethingNew":[1,2]}"#,
        )
        .unwrap();
        assert_eq!(o.tol, 1e-5);
    }

    #[test]
    fn null_fields_mean_default() {
        let o = parse_options(r#"{"tol":null,"maxIters":null,"preconditioner":null}"#).unwrap();
        assert_eq!(o, SessionOptions::default());
    }

    #[test]
    fn rejects_bad_values() {
        for json in [
            r#"{"tol":0}"#,
            r#"{"tol":-1e-4}"#,
            r#"{"tol":1}"#,
            r#"{"tol":"1e-4"}"#,
            r#"{"maxIters":0}"#,
            r#"{"maxIters":-5}"#,
            r#"{"maxIters":2.5}"#,
            r#"{"maxIters":1e300}"#,
            r#"{"preconditioner":"ilu"}"#,
            r#"{"preconditioner":"Jacobi"}"#,
            "[1,2]",
            "{",
            "42",
        ] {
            let err = parse_options(json).expect_err(json);
            assert!(err.starts_with("invalid solver options"), "{json}: {err}");
        }
    }
}
