//! `cargo run -p fem-bench --release -- [--json] [options]`
//!
//! Native single-thread benchmark of the fem solver on the Phase 0 grids (see the crate
//! docs in `lib.rs`). Without `--json` it prints a table; with `--json` the report goes
//! to stdout and progress + the table to stderr. `scripts/bench-gate.mjs` consumes the
//! JSON together with `scripts/bench-wasm.mjs`'s.

use fem::Preconditioner;
use fem_bench::{
    Config, GRIDS, Machine, Report, SCHEMA, grid_name, parse_grid, run_scenario, table,
};
use std::process::ExitCode;

const USAGE: &str = "\
usage: fem-bench [--json] [--grid NXxNYxNZ[,..]] [--precond jacobi|multigrid|both]
                 [--carves N] [--repeats N] [--tol X] [--seed N]

  --json      JSON report on stdout (progress and table on stderr)
  --grid      grids to run (repeatable / comma list); default: 24x8x4 32x8x8 32x12x12
              40x12x12 60x20x20
  --precond   preconditioner(s) to request (alias: mg); default: both
  --carves    random 3x3 surface carves per scenario (warm = median); default 10
  --repeats   cold solves per scenario (median); default 3
  --tol       relative residual target; default 1e-4
  --seed      carve sequence seed; default 42";

struct Args {
    json: bool,
    grids: Vec<[usize; 3]>,
    preconds: Vec<Preconditioner>,
    cfg: Config,
}

fn parse_args() -> Result<Option<Args>, String> {
    let mut args = Args {
        json: false,
        grids: Vec::new(),
        preconds: vec![Preconditioner::Jacobi, Preconditioner::Multigrid],
        cfg: Config::default(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) => (f.to_string(), Some(v.to_string())),
            None => (a.clone(), None),
        };
        let mut value = |name: &str| -> Result<String, String> {
            inline
                .clone()
                .or_else(|| it.next())
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match flag.as_str() {
            "-h" | "--help" => return Ok(None),
            "--json" => args.json = true,
            "--grid" => {
                for g in value("--grid")?.split(',').filter(|s| !s.is_empty()) {
                    args.grids.push(parse_grid(g)?);
                }
            }
            "--precond" => {
                args.preconds = match value("--precond")?.as_str() {
                    "jacobi" => vec![Preconditioner::Jacobi],
                    "multigrid" | "mg" => vec![Preconditioner::Multigrid],
                    "both" | "all" => vec![Preconditioner::Jacobi, Preconditioner::Multigrid],
                    other => return Err(format!("unknown preconditioner {other:?}")),
                }
            }
            "--carves" => args.cfg.carves = parse_num(&value("--carves")?, "--carves")?,
            "--repeats" => {
                args.cfg.repeats = parse_num::<usize>(&value("--repeats")?, "--repeats")?.max(1)
            }
            "--seed" => args.cfg.seed = parse_num(&value("--seed")?, "--seed")?,
            "--tol" => {
                let tol: f64 = parse_num(&value("--tol")?, "--tol")?;
                if !(tol > 0.0 && tol < 1.0) {
                    return Err(format!("--tol must be in (0, 1), got {tol}"));
                }
                args.cfg.tol = tol;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    if args.grids.is_empty() {
        args.grids = GRIDS.to_vec();
    }
    Ok(Some(args))
}

fn parse_num<T: std::str::FromStr>(s: &str, name: &str) -> Result<T, String> {
    s.parse()
        .map_err(|_| format!("{name}: invalid number {s:?}"))
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(Some(a)) => a,
        Ok(None) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("fem-bench: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let mut results = Vec::new();
    for &dims in &args.grids {
        for &pc in &args.preconds {
            let r = run_scenario(dims, pc, &args.cfg);
            if args.json {
                eprintln!(
                    "fem-bench: {} {:<9} cold {:.1} ms ({} it), warm median {:.1} ms ({} it)",
                    grid_name(dims),
                    r.requested,
                    r.cold_ms,
                    r.cold_iters,
                    r.warm_median_ms,
                    r.warm_median_iters
                );
            }
            results.push(r);
        }
    }
    let all_converged = results.iter().all(|r| r.converged);
    let tbl = table(&results);
    if args.json {
        let report = Report {
            schema: SCHEMA,
            target: "native",
            scenario: "cantilever",
            machine: Machine::detect(),
            config: args.cfg,
            results,
        };
        match serde_json::to_string_pretty(&report) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                eprintln!("fem-bench: cannot serialise report: {e}");
                return ExitCode::FAILURE;
            }
        }
        eprint!("{tbl}");
    } else {
        print!("{tbl}");
    }
    if all_converged {
        ExitCode::SUCCESS
    } else {
        eprintln!("fem-bench: some solves did not reach tol");
        ExitCode::FAILURE
    }
}
