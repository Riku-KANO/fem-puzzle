//! Shared helpers for the integration tests: programmatic stages.
#![allow(dead_code)]

use stage::{Bitmask, Face, Load, Stage, Support, Targets};

pub const E: f64 = 70e9;
pub const NU: f64 = 0.3;
pub const H: f64 = 0.01;

/// A stage on an `nx × ny × nz` grid with the given solid set, supports and loads.
pub fn stage(
    [nx, ny, nz]: [usize; 3],
    solid: &[bool],
    supports: Vec<Support>,
    loads: Vec<Load>,
) -> Stage {
    let s = Stage {
        version: 1,
        id: "test".into(),
        title: String::new(),
        world: 0,
        grid: [nx, ny, nz],
        voxel_size: H,
        material: stage::Material {
            e: E,
            nu: NU,
            allowable: 100e6,
            density: None,
        },
        solid: Bitmask::from_bools(solid),
        keep: Bitmask::from_bools(&vec![false; solid.len()]),
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
    };
    s.validate().expect("test stage is valid");
    s
}

pub fn clamp(face: Face) -> Support {
    Support {
        face,
        fix: "xyz".into(),
        cells: None,
    }
}

/// Solid cantilever clamped at x-, loaded downwards (−y) on the whole x+ end layer.
pub fn cantilever([nx, ny, nz]: [usize; 3], total_force: f64) -> Stage {
    let cells = (0..nz)
        .flat_map(|z| (0..ny).map(move |y| [nx - 1, y, z]))
        .collect();
    stage(
        [nx, ny, nz],
        &vec![true; nx * ny * nz],
        vec![clamp(Face::XNeg)],
        vec![Load {
            cells,
            force: [0.0, -total_force, 0.0],
        }],
    )
}

pub fn max_abs(v: &[f64]) -> f64 {
    v.iter().fold(0.0f64, |m, x| m.max(x.abs()))
}
