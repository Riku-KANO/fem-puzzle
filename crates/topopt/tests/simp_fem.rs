//! SIMP/OC and calibration against the real `fem` solver on small programmatic stages.

use stage::{Bitmask, Face, Load, Stage, Support, Targets};
use topopt::calibrate::TARGET_UTILIZATION;
use topopt::design;
use topopt::driver::{self, CalibrationSettings, FemAnalysis, Model, SIMP_TOL, VERIFY_TOL};
use topopt::simp::{Simp, SimpOptions};
use topopt::stagejson;

fn stage(grid: [usize; 3], supports: Vec<Support>, loads: Vec<Load>) -> Stage {
    let n = grid[0] * grid[1] * grid[2];
    let s = Stage {
        version: 1,
        id: "test".into(),
        title: String::new(),
        world: 0,
        grid,
        voxel_size: 0.01,
        material: stage::Material {
            e: 70e9,
            nu: 0.3,
            allowable: 120e6,
            density: None,
        },
        solid: Bitmask::from_bools(&vec![true; n]),
        keep: Bitmask::from_bools(&vec![false; n]),
        block: None,
        supports,
        loads,
        load_cases: None,
        max_displacement: None,
        targets: Targets {
            star1: 0.7,
            star2: 0.55,
            star3: 0.45,
        },
        benchmark: None,
        hints: vec![],
    };
    s.validate().expect("valid test stage");
    s
}

/// Half MBB beam as a one-voxel-thick plate: symmetry plane at x- (x and z fixed), roller
/// under the far bottom corner, point-like load on the top-left cell.
fn mbb(nx: usize, ny: usize) -> Stage {
    stage(
        [nx, ny, 1],
        vec![
            Support {
                face: Face::XNeg,
                fix: "xz".into(),
                cells: None,
            },
            Support {
                face: Face::YNeg,
                fix: "yz".into(),
                cells: Some(vec![[nx - 1, 0, 0]]),
            },
        ],
        vec![Load {
            cells: vec![[0, ny - 1, 0]],
            force: [0.0, -100.0, 0.0],
        }],
    )
}

#[test]
fn mbb_plate_converges_with_decreasing_compliance_and_exact_volume() {
    let model = Model::from_stage(mbb(30, 10)).unwrap();
    let simp = Simp::new(&model.layout, 1.5).unwrap();
    let mut analysis = FemAnalysis::new(model.problem.clone(), SIMP_TOL);
    let volfrac = 0.5;
    let opts = SimpOptions {
        volfrac,
        max_iters: 200,
        ..SimpOptions::default()
    };
    let res = simp.run(&mut analysis, &opts, None, &mut |_| {}).unwrap();
    let h = &res.history;
    assert!(res.converged, "not converged after {} iterations", h.len());

    // compliance decreases: overall by a lot, and step by step up to OC noise
    let c0 = h[0].compliance;
    let c_end = h.last().unwrap().compliance;
    assert!(c_end < 0.5 * c0, "compliance {c0} → {c_end}");
    let increases = h
        .windows(2)
        .filter(|w| w[1].compliance > w[0].compliance * (1.0 + 1e-3))
        .count();
    assert!(
        increases <= h.len() / 20,
        "{increases} compliance increases in {} iterations",
        h.len()
    );

    // volume constraint on the physical densities
    for r in h {
        assert!(
            (r.volume - volfrac).abs() < 1e-3,
            "iter {}: {}",
            r.iter,
            r.volume
        );
    }
    let nd = model.layout.domain_count() as f64;
    let v: f64 = res.rho.iter().sum::<f64>() / nd;
    assert!((v - volfrac).abs() < 1e-3, "final volume {v}");

    // the result is a structure, not grey mush: thresholding keeps it valid and passing
    let des = design::threshold(&model.layout, &res.rho, (volfrac * nd) as usize).unwrap();
    assert!(design::is_valid(&model.layout, &des.solid));
    assert!(des.added_for_connectivity < 5 && des.removed_floating < 5);
    let j = driver::judge(&model.problem, &des.solid, VERIFY_TOL).unwrap();
    assert!(j.loads_connected && j.converged && j.max_utilization > 0.0);
}

#[test]
fn calibration_scales_loads_and_reverifies() {
    // small 3D cantilever, clamped at x-, end load down
    let (nx, ny, nz) = (12, 4, 2);
    let cells: Vec<[usize; 3]> = (0..nz).map(|z| [nx - 1, ny - 1, z]).collect();
    let s = stage(
        [nx, ny, nz],
        vec![Support {
            face: Face::XNeg,
            fix: "xyz".into(),
            cells: None,
        }],
        vec![Load {
            cells,
            force: [0.0, -500.0, 0.0],
        }],
    );
    let text = s.to_json_pretty();
    let model = Model::from_json(&text).unwrap();
    let mut value = stagejson::parse(&text).unwrap();
    let settings = CalibrationSettings {
        volfracs: vec![0.6, 0.5, 0.4],
        simp: SimpOptions {
            max_iters: 60,
            ..SimpOptions::default()
        },
        efficiency_tol: 0.05,
    };
    let mut runs = 0;
    let cal = driver::calibrate(&model, &mut value, &settings, &mut |_| runs += 1).unwrap();
    assert_eq!(runs, 3);
    let out = stagejson::to_text(&value);
    let calibrated = Model::from_json(&out).unwrap();
    let b = calibrated.stage.benchmark.clone().unwrap();
    assert_eq!(b.method.as_deref(), Some("simp-oc"));
    let u = b.max_utilization.unwrap();
    assert!((u - TARGET_UTILIZATION).abs() < 2e-3, "utilisation {u}");
    assert_eq!(calibrated.stage.targets, cal.targets);
    assert!((calibrated.stage.targets.star3 - (b.volume + 0.05)).abs() < 1e-4);
    // load direction kept, magnitude scaled by the reported factor (4 significant digits)
    let f = calibrated.stage.loads[0].force;
    assert_eq!(f[0], 0.0);
    assert!((f[1] / (-500.0 * cal.scale) - 1.0).abs() < 1e-3);
    assert!(cal.full_block.max_utilization < 1.0);

    let bench = driver::verify_calibrated(&calibrated).unwrap();
    assert!((bench.max_utilization - u).abs() < 1e-3 * u);

    // tampering is caught
    let mut bad = value.clone();
    bad["benchmark"]["maxUtilization"] = serde_json::Value::from(0.8);
    let bad = Model::from_json(&stagejson::to_text(&bad)).unwrap();
    assert!(driver::verify_calibrated(&bad).is_err());

    // grafting the calibration onto the raw stage reproduces the file exactly
    let mut raw = stagejson::parse(&text).unwrap();
    assert_eq!(
        stagejson::skeleton(&raw).unwrap(),
        stagejson::skeleton(&value).unwrap()
    );
    stagejson::graft_calibration(&mut raw, &value).unwrap();
    assert_eq!(stagejson::to_text(&raw), out);
}
