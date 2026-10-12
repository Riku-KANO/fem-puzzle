//! CLI commands (`run`, `calibrate`, `eval`): file handling and printing.

use crate::ascii;
use crate::cli::{CalibrateArgs, RunArgs};
use crate::driver::{
    self, CalibrationSettings, FemAnalysis, JUDGE_TOL, Judge, Judgement, Model, RunOutcome,
    SIMP_TOL, VERIFY_TOL,
};
use crate::layout::Layout;
use crate::simp::{IterInfo, Simp, SimpOptions};
use crate::{Error, Result, calibrate, stagejson};
use std::path::Path;
use std::time::Instant;

fn read(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).map_err(|e| Error(format!("{}: {e}", path.display())))
}

fn print_iter(h: &IterInfo) {
    println!(
        "  it {:>3}  c {:.6e}  vol {:.4}  change {:.4}  grey {:.3}  cg {:>5}",
        h.iter, h.compliance, h.volume, h.change, h.grayness, h.solver_iterations
    );
}

fn print_design(layout: &Layout, solid: &[bool]) {
    println!("  design slices z = 0.. (# solid, K keep, S supported, L load, x block):");
    let slices: Vec<String> = (0..layout.dims.nz)
        .map(|z| ascii::design_slice(layout, solid, z))
        .collect();
    for row in 0..layout.dims.ny {
        let line: Vec<&str> = slices
            .iter()
            .map(|s| s.lines().nth(row).unwrap_or(""))
            .collect();
        println!("    {}", line.join(" "));
    }
    println!("  design, solid cells per z-column:");
    for line in ascii::design_projection(layout, solid).lines() {
        println!("    {line}");
    }
}

fn describe_judgement(j: &Judgement) -> String {
    format!(
        "max utilisation {:.4}{}{}",
        j.max_utilization,
        if j.loads_connected {
            ""
        } else {
            ", LOADS DISCONNECTED"
        },
        if j.converged { "" } else { ", not converged" }
    )
}

/// `topopt run`.
pub fn run(args: &RunArgs) -> Result<()> {
    let model = Model::from_json(&read(&args.stage)?)?;
    let l = &model.layout;
    let d = l.dims;
    println!(
        "{}: grid {}x{}x{}, domain {} cells, keep {}, volfrac {}",
        model.stage.id,
        d.nx,
        d.ny,
        d.nz,
        l.domain_count(),
        l.keep_count(),
        args.volfrac
    );
    let simp = Simp::new(l, args.rmin)?;
    let mut analysis = FemAnalysis::new(model.problem.clone(), SIMP_TOL);
    let mut judge = Judge::new(model.problem.clone(), JUDGE_TOL);
    let opts = SimpOptions {
        volfrac: args.volfrac,
        penal: args.penal,
        rmin: args.rmin,
        max_iters: args.iters,
        ..SimpOptions::default()
    };
    let out = driver::run_one(
        &model,
        &simp,
        &mut analysis,
        &mut judge,
        &opts,
        None,
        &mut print_iter,
    )?;
    println!(
        "{} after {} iterations ({:.1} s)",
        if out.converged {
            "converged"
        } else {
            "stopped"
        },
        out.history.len(),
        out.seconds
    );
    if args.ascii {
        let mid = d.nz / 2;
        println!("  density, slice z = {mid}:");
        for line in ascii::density_slice(l, &out.rho, mid).lines() {
            println!("    {line}");
        }
        print_design(l, &out.design.solid);
    }
    report_design(&out);
    let full = driver::judge(&model.problem, &l.domain, VERIFY_TOL)?;
    println!("  full block: {}", describe_judgement(&full));
    Ok(())
}

fn report_design(out: &RunOutcome) {
    println!(
        "  thresholded: {} cells, volume {:.4} (+{} for connectivity, -{} floating), {}",
        out.design.count,
        out.design.volume,
        out.design.added_for_connectivity,
        out.design.removed_floating,
        describe_judgement(&out.judgement)
    );
}

/// `topopt calibrate`. Returns an error if any stage failed (after trying all).
pub fn calibrate(args: &CalibrateArgs) -> Result<()> {
    let mut failed = Vec::new();
    for path in &args.stages {
        if let Err(e) = calibrate_one(args, path) {
            eprintln!("topopt: {}: {e}", path.display());
            failed.push(path.display().to_string());
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(Error(format!(
            "calibration failed for {}",
            failed.join(", ")
        )))
    }
}

/// Why a cached stage cannot be reused (None = reusable).
fn cache_mismatch(fresh: &serde_json::Value, cached: &serde_json::Value) -> Result<Option<String>> {
    if stagejson::skeleton(fresh)? != stagejson::skeleton(cached)? {
        return Ok(Some("stage changed".into()));
    }
    if cached.get("benchmark").is_none() {
        return Ok(Some("not calibrated yet".into()));
    }
    let (f, c) = (stagejson::forces(fresh)?, stagejson::forces(cached)?);
    if stagejson::common_scale(&f, &c, 2e-3).is_none() {
        return Ok(Some("load directions/ratios changed".into()));
    }
    Ok(None)
}

fn calibrate_one(args: &CalibrateArgs, path: &Path) -> Result<()> {
    let t = Instant::now();
    let text = read(path)?;
    let mut value = stagejson::parse(&text)?;
    let model = Model::from_json(&text)?;
    let id = model.stage.id.clone();
    let name = path.file_name().ok_or_else(|| Error("not a file".into()))?;

    if let (Some(dir), false) = (&args.cache, args.force) {
        let cpath = dir.join(name);
        if cpath.is_file() {
            let ctext = read(&cpath)?;
            let cached = stagejson::parse(&ctext)?;
            match cache_mismatch(&value, &cached)? {
                None => {
                    match Model::from_json(&ctext).and_then(|m| driver::verify_calibrated(&m)) {
                        Ok(bench) => {
                            stagejson::graft_calibration(&mut value, &cached)?;
                            println!(
                                "{id}: reused cached calibration (benchmark re-verified: {}) [{:.2} s]",
                                describe_judgement(&bench),
                                t.elapsed().as_secs_f64()
                            );
                            return finish(args, path, &text, &value);
                        }
                        Err(e) => println!("{id}: cached calibration rejected ({e}); recomputing"),
                    }
                }
                Some(why) => println!("{id}: recalibrating ({why})"),
            }
        }
    }

    let settings = CalibrationSettings {
        volfracs: args.volfracs(),
        simp: SimpOptions {
            max_iters: args.iters,
            ..SimpOptions::default()
        },
        efficiency_tol: calibrate::EFFICIENCY_TOL,
    };
    if !args.quiet {
        println!("{id}: sweep {:?}", settings.volfracs);
        println!("    volfrac  iters  conv  compliance    cells  volume  util     v*u     time");
    }
    let quiet = args.quiet;
    let cal = driver::calibrate(&model, &mut value, &settings, &mut |r: &RunOutcome| {
        if !quiet {
            println!(
                "    {:.3}    {:>4}   {}     {:.4e}  {:>5}  {:.4}  {:.4}  {:.4}  {:.1} s",
                r.volfrac,
                r.history.len(),
                if r.converged { "y" } else { "n" },
                r.final_compliance(),
                r.design.count,
                r.design.volume,
                r.judgement.max_utilization,
                r.design.volume * r.judgement.max_utilization,
                r.seconds
            );
        }
    })?;
    let best = &cal.sweep[cal.chosen];
    if args.ascii {
        print_design(&model.layout, &best.design.solid);
    }
    println!(
        "{id}: benchmark volfrac {} → volume {:.4} ({} cells), loads ×{:.4} → utilisation {}, \
         targets ★3 {} ★2 {} ★1 {} [{:.1} s]",
        best.volfrac,
        cal.benchmark.volume,
        best.design.count,
        cal.scale,
        cal.benchmark.max_utilization.unwrap_or(f64::NAN),
        cal.targets.star3,
        cal.targets.star2,
        cal.targets.star1,
        t.elapsed().as_secs_f64()
    );
    if cal.full_block.max_utilization >= 1.0 {
        println!(
            "{id}: WARNING full initial block fails under the calibrated loads (utilisation {:.4})",
            cal.full_block.max_utilization
        );
    } else {
        println!(
            "{id}: full initial block utilisation {:.4}",
            cal.full_block.max_utilization
        );
    }
    if let Some(d) = model.stage.max_displacement {
        let bench = driver::verify_calibrated(&Model::from_json(&stagejson::to_text(&value))?);
        if let Err(e) = bench {
            return Err(Error(format!("{e}; raise maxDisplacement or drop it")));
        }
        println!("{id}: benchmark meets maxDisplacement {d:e} m");
    }
    finish(args, path, &text, &value)
}

fn finish(args: &CalibrateArgs, path: &Path, old: &str, value: &serde_json::Value) -> Result<()> {
    let new = stagejson::to_text(value);
    if args.write {
        if new != old {
            std::fs::write(path, &new)?;
            if !args.quiet {
                println!("  wrote {}", path.display());
            }
        }
    } else if new != old {
        println!("  (dry run: {} would change; pass --write)", path.display());
    }
    Ok(())
}

/// `topopt judge`.
pub fn judge(paths: &[std::path::PathBuf]) -> Result<()> {
    for p in paths {
        let model = Model::from_json(&read(p)?)?;
        let id = &model.stage.id;
        let full = driver::judge(&model.problem, &model.layout.domain, VERIFY_TOL)?;
        println!("{id}: full block {}", describe_judgement(&full));
        match &model.stage.benchmark {
            Some(_) => match driver::verify_calibrated(&model) {
                Ok(bench) => {
                    println!("{id}: benchmark ok, {}", describe_judgement(&bench));
                    let solid = model
                        .stage
                        .benchmark
                        .as_ref()
                        .map(|b| b.solid.to_bools(model.layout.n()))
                        .transpose()?
                        .unwrap_or_default();
                    print_design(&model.layout, &solid);
                }
                Err(e) => println!("{id}: benchmark INVALID: {e}"),
            },
            None => println!("{id}: no benchmark"),
        }
    }
    Ok(())
}
