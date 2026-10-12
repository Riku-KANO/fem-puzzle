//! Command-line parsing (no dependencies on purpose).

use crate::{Error, Result, err};
use std::path::PathBuf;

pub const USAGE: &str = "\
topopt — offline SIMP/OC optimiser for STRESS CARVE stages (T-203)

USAGE:
  topopt run <stage.json> --volfrac <v> [--iters <n>] [--penal <p>] [--rmin <r>] [--ascii]
      Compliance minimisation; prints convergence, the thresholded design and its judged
      max utilisation under the stage's current loads.
  topopt calibrate <stage.json>... [--write] [--cache <dir>] [--force]
                   [--vmin <v>] [--vmax <v>] [--vstep <dv>] [--iters <n>] [--ascii] [--quiet]
      Volfrac sweep → benchmark design → loads scaled to 90 % utilisation → star targets.
      --write   rewrite the stage files in place (exporter key order/format)
      --cache   directory of previously calibrated stages (same file names): reused when
                only calibrated fields differ and the stored benchmark re-verifies
      --force   ignore the cache
  topopt eval <stage.json>...
      Judge the stored benchmark design and the full block under the stage's loads.
";

/// Settings of one SIMP run.
#[derive(Debug, Clone, PartialEq)]
pub struct RunArgs {
    pub stage: PathBuf,
    pub volfrac: f64,
    pub iters: usize,
    pub penal: f64,
    pub rmin: f64,
    pub ascii: bool,
}

/// Settings of the calibration.
#[derive(Debug, Clone, PartialEq)]
pub struct CalibrateArgs {
    pub stages: Vec<PathBuf>,
    pub write: bool,
    pub cache: Option<PathBuf>,
    pub force: bool,
    pub vmin: f64,
    pub vmax: f64,
    pub vstep: f64,
    pub iters: usize,
    pub ascii: bool,
    pub quiet: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Run(RunArgs),
    Calibrate(CalibrateArgs),
    Eval(Vec<PathBuf>),
    Help,
}

pub const DEFAULT_ITERS: usize = 150;

fn number(flag: &str, v: Option<&String>) -> Result<f64> {
    let v = v.ok_or_else(|| Error(format!("{flag} needs a value")))?;
    match v.parse::<f64>() {
        Ok(x) if x.is_finite() => Ok(x),
        _ => err(format!("{flag}: not a number: {v:?}")),
    }
}

fn count(flag: &str, v: Option<&String>) -> Result<usize> {
    let v = v.ok_or_else(|| Error(format!("{flag} needs a value")))?;
    v.parse::<usize>()
        .map_err(|_| Error(format!("{flag}: not a count: {v:?}")))
}

/// Parse `args` (without the program name).
pub fn parse(args: &[String]) -> Result<Command> {
    let Some((cmd, rest)) = args.split_first() else {
        return Ok(Command::Help);
    };
    let mut files = Vec::new();
    let mut volfrac = None;
    let mut iters = DEFAULT_ITERS;
    let mut penal = 3.0;
    let mut rmin = 1.5;
    let mut ascii = false;
    let mut write = false;
    let mut cache = None;
    let mut force = false;
    let mut quiet = false;
    let (mut vmin, mut vmax, mut vstep) = (0.15, 0.6, 0.05);
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--volfrac" => volfrac = Some(number(a, it.next())?),
            "--iters" => iters = count(a, it.next())?,
            "--penal" => penal = number(a, it.next())?,
            "--rmin" => rmin = number(a, it.next())?,
            "--vmin" => vmin = number(a, it.next())?,
            "--vmax" => vmax = number(a, it.next())?,
            "--vstep" => vstep = number(a, it.next())?,
            "--cache" => {
                let d = it
                    .next()
                    .ok_or_else(|| Error("--cache needs a value".into()))?;
                cache = Some(PathBuf::from(d));
            }
            "--ascii" => ascii = true,
            "--write" => write = true,
            "--force" => force = true,
            "--quiet" | "-q" => quiet = true,
            "-h" | "--help" => return Ok(Command::Help),
            f if f.starts_with('-') => return err(format!("unknown option {f}")),
            f => files.push(PathBuf::from(f)),
        }
    }
    match cmd.as_str() {
        "run" => {
            let [stage] = <[PathBuf; 1]>::try_from(files)
                .map_err(|_| Error("run takes exactly one stage file".into()))?;
            let volfrac = volfrac.ok_or_else(|| Error("run needs --volfrac".into()))?;
            if !(volfrac > 0.0 && volfrac <= 1.0) {
                return err("--volfrac must be in (0, 1]");
            }
            if penal < 1.0 || rmin <= 0.0 || iters == 0 {
                return err("need --penal >= 1, --rmin > 0, --iters > 0");
            }
            Ok(Command::Run(RunArgs {
                stage,
                volfrac,
                iters,
                penal,
                rmin,
                ascii,
            }))
        }
        "calibrate" => {
            if files.is_empty() {
                return err("calibrate needs at least one stage file");
            }
            if !(0.0 < vmin && vmin <= vmax && vmax <= 1.0 && vstep > 0.0) || iters == 0 {
                return err("need 0 < --vmin <= --vmax <= 1, --vstep > 0, --iters > 0");
            }
            Ok(Command::Calibrate(CalibrateArgs {
                stages: files,
                write,
                cache,
                force,
                vmin,
                vmax,
                vstep,
                iters,
                ascii,
                quiet,
            }))
        }
        "eval" => {
            if files.is_empty() {
                return err("eval needs at least one stage file");
            }
            Ok(Command::Eval(files))
        }
        "help" | "-h" | "--help" => Ok(Command::Help),
        other => err(format!("unknown command {other:?}")),
    }
}

impl CalibrateArgs {
    /// The sweep from heavy to light (continuation runs downwards).
    pub fn volfracs(&self) -> Vec<f64> {
        let mut v = Vec::new();
        let n = ((self.vmax - self.vmin) / self.vstep + 1e-9).floor() as usize;
        for i in 0..=n {
            // round to 1e-6 so 0.15 + k·0.05 prints cleanly
            let x = self.vmax - i as f64 * self.vstep;
            v.push((x * 1e6).round() / 1e6);
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn parses_run() {
        let c = parse(&args(
            "run stages/w1-01.json --volfrac 0.3 --iters 50 --ascii",
        ))
        .unwrap();
        assert_eq!(
            c,
            Command::Run(RunArgs {
                stage: "stages/w1-01.json".into(),
                volfrac: 0.3,
                iters: 50,
                penal: 3.0,
                rmin: 1.5,
                ascii: true,
            })
        );
        assert!(parse(&args("run a.json")).is_err());
        assert!(parse(&args("run a.json b.json --volfrac 0.3")).is_err());
        assert!(parse(&args("run a.json --volfrac 1.5")).is_err());
        assert!(parse(&args("run a.json --volfrac x")).is_err());
        assert!(parse(&args("run a.json --bogus")).is_err());
    }

    #[test]
    fn parses_calibrate_and_sweep() {
        let Command::Calibrate(c) = parse(&args(
            "calibrate a.json b.json --write --cache stages --vmin 0.2",
        ))
        .unwrap() else {
            panic!("not calibrate");
        };
        assert_eq!(c.stages.len(), 2);
        assert!(c.write && !c.force);
        assert_eq!(c.cache, Some(PathBuf::from("stages")));
        assert_eq!(
            c.volfracs(),
            vec![0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2]
        );
        assert_eq!(parse(&[]).unwrap(), Command::Help);
        assert!(parse(&args("calibrate")).is_err());
        assert!(parse(&args("frobnicate x")).is_err());
    }
}
