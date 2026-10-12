//! Stage JSON format. The normative description is `docs/specs/stage-format.md`;
//! `packages/protocol/src/stage.ts` is the TypeScript twin of this module.

mod bitmask;

pub use bitmask::Bitmask;

use serde::{Deserialize, Serialize};
use std::fmt;

pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Face {
    #[serde(rename = "x-")]
    XNeg,
    #[serde(rename = "x+")]
    XPos,
    #[serde(rename = "y-")]
    YNeg,
    #[serde(rename = "y+")]
    YPos,
    #[serde(rename = "z-")]
    ZNeg,
    #[serde(rename = "z+")]
    ZPos,
}

impl Face {
    /// Axis index (0 = x, 1 = y, 2 = z).
    pub fn axis(self) -> usize {
        match self {
            Face::XNeg | Face::XPos => 0,
            Face::YNeg | Face::YPos => 1,
            Face::ZNeg | Face::ZPos => 2,
        }
    }

    pub fn is_positive(self) -> bool {
        matches!(self, Face::XPos | Face::YPos | Face::ZPos)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Material {
    #[serde(rename = "E")]
    pub e: f64,
    pub nu: f64,
    pub allowable: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Support {
    pub face: Face,
    /// Non-empty subset of "xyz".
    pub fix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cells: Option<Vec<[usize; 3]>>,
}

impl Support {
    /// Which components are fixed, as `[x, y, z]`.
    pub fn fixed_components(&self) -> [bool; 3] {
        [
            self.fix.contains('x'),
            self.fix.contains('y'),
            self.fix.contains('z'),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Load {
    pub cells: Vec<[usize; 3]>,
    /// Total force (N), split equally among `cells`.
    pub force: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoadCase {
    pub name: String,
    pub loads: Vec<Load>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Targets {
    pub star1: f64,
    pub star2: f64,
    pub star3: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Benchmark {
    pub volume: f64,
    pub solid: Bitmask,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_utilization: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub version: u32,
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub world: u32,
    pub grid: [usize; 3],
    pub voxel_size: f64,
    pub material: Material,
    pub solid: Bitmask,
    pub keep: Bitmask,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<Bitmask>,
    pub supports: Vec<Support>,
    #[serde(default)]
    pub loads: Vec<Load>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_cases: Option<Vec<LoadCase>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_displacement: Option<f64>,
    pub targets: Targets,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub benchmark: Option<Benchmark>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StageError(pub String);

impl fmt::Display for StageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid stage: {}", self.0)
    }
}

impl std::error::Error for StageError {}

fn err<T>(msg: impl Into<String>) -> Result<T, StageError> {
    Err(StageError(msg.into()))
}

impl Stage {
    /// Parse and validate.
    pub fn from_json(json: &str) -> Result<Stage, StageError> {
        let stage: Stage = serde_json::from_str(json).map_err(|e| StageError(e.to_string()))?;
        stage.validate()?;
        Ok(stage)
    }

    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(self).expect("stage serialises")
    }

    pub fn element_count(&self) -> usize {
        self.grid[0] * self.grid[1] * self.grid[2]
    }

    /// `e = x + nx * (y + ny * z)`
    pub fn element_index(&self, [x, y, z]: [usize; 3]) -> usize {
        x + self.grid[0] * (y + self.grid[1] * z)
    }

    /// Load cases to judge: `loadCases` if present, otherwise `loads` as one case.
    pub fn cases(&self) -> Vec<LoadCase> {
        match &self.load_cases {
            Some(cases) if !cases.is_empty() => cases.clone(),
            _ => vec![LoadCase {
                name: "default".into(),
                loads: self.loads.clone(),
            }],
        }
    }

    /// Cells of one support: the listed `cells`, or — for a face-only support — every
    /// initially solid cell touching that grid face.
    pub fn support_cells(&self, support: &Support, solid: &[bool]) -> Vec<usize> {
        if let Some(cells) = &support.cells {
            return cells.iter().map(|&c| self.element_index(c)).collect();
        }
        let axis = support.face.axis();
        let layer = if support.face.is_positive() {
            self.grid[axis] - 1
        } else {
            0
        };
        let [nx, ny, nz] = self.grid;
        let mut out = Vec::new();
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let e = self.element_index([x, y, z]);
                    if [x, y, z][axis] == layer && solid[e] {
                        out.push(e);
                    }
                }
            }
        }
        out
    }

    /// Per element: is it a supported cell of any support (stage-format.md, Support).
    /// Connectivity to supports is measured from exactly these cells.
    pub fn supported_cells(&self) -> Result<Vec<bool>, StageError> {
        let n = self.element_count();
        let solid = self.solid.to_bools(n)?;
        let mut supported = vec![false; n];
        for s in &self.supports {
            for e in self.support_cells(s, &solid) {
                supported[e] = true;
            }
        }
        Ok(supported)
    }

    /// `keep` plus implicitly protected supported cells and load cells.
    pub fn effective_keep(&self) -> Result<Vec<bool>, StageError> {
        let n = self.element_count();
        let mut keep = self.keep.to_bools(n)?;
        for (k, s) in keep.iter_mut().zip(self.supported_cells()?) {
            *k |= s;
        }
        for case in self.cases() {
            for l in &case.loads {
                for &c in &l.cells {
                    keep[self.element_index(c)] = true;
                }
            }
        }
        Ok(keep)
    }

    pub fn validate(&self) -> Result<(), StageError> {
        if self.version != FORMAT_VERSION {
            return err(format!("unsupported version {}", self.version));
        }
        let [nx, ny, nz] = self.grid;
        if nx == 0 || ny == 0 || nz == 0 {
            return err("grid dimensions must be positive");
        }
        let positive = |x: f64| x.is_finite() && x > 0.0;
        if !positive(self.voxel_size) {
            return err("voxelSize must be positive");
        }
        let m = &self.material;
        if !positive(m.e) || !positive(m.allowable) || !(m.nu > -1.0 && m.nu < 0.5) {
            return err("material constants out of range");
        }
        let n = self.element_count();
        let solid = self.solid.to_bools(n)?;
        let keep = self.keep.to_bools(n)?;
        if solid.iter().all(|s| !s) {
            return err("solid is empty");
        }
        if keep.iter().zip(&solid).any(|(&k, &s)| k && !s) {
            return err("keep must be a subset of solid");
        }
        if let Some(block) = &self.block {
            let block = block.to_bools(n)?;
            if block.iter().zip(&solid).any(|(&b, &s)| b && s) {
                return err("block must not intersect solid");
            }
        }
        let in_grid = |c: &[usize; 3]| c[0] < nx && c[1] < ny && c[2] < nz;
        if self.supports.is_empty() {
            return err("at least one support is required");
        }
        for s in &self.supports {
            if s.fix.is_empty() || !s.fix.chars().all(|c| matches!(c, 'x' | 'y' | 'z')) {
                return err(format!("bad support fix {:?}", s.fix));
            }
            for c in s.cells.iter().flatten() {
                if !in_grid(c) || !solid[self.element_index(*c)] {
                    return err(format!("support cell {c:?} is not a solid cell"));
                }
            }
        }
        let cases = self.cases();
        for case in &cases {
            if case.loads.is_empty() {
                return err(format!("load case {:?} has no loads", case.name));
            }
            for l in &case.loads {
                if l.cells.is_empty() {
                    return err("load without cells");
                }
                for c in &l.cells {
                    if !in_grid(c) || !solid[self.element_index(*c)] {
                        return err(format!("load cell {c:?} is not a solid cell"));
                    }
                }
            }
        }
        let t = &self.targets;
        let ordered = t.star1 > t.star2 && t.star2 > t.star3 && positive(t.star3);
        if !ordered || t.star1 > 1.0 {
            return err("targets must satisfy 1 >= star1 > star2 > star3 > 0");
        }
        if let Some(b) = &self.benchmark {
            b.solid.to_bools(n)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_json() -> String {
        let n = 4 * 2 * 2;
        let solid = Bitmask::from_bools(&vec![true; n]);
        let mut keep = vec![false; n];
        keep[0] = true;
        let keep = Bitmask::from_bools(&keep);
        format!(
            r#"{{
              "version": 1, "id": "t-01", "title": "test", "world": 1,
              "grid": [4, 2, 2], "voxelSize": 0.01,
              "material": {{ "E": 70e9, "nu": 0.33, "allowable": 120e6 }},
              "solid": "{}", "keep": "{}",
              "supports": [{{ "face": "x-", "fix": "xyz" }}],
              "loads": [{{ "cells": [[3, 0, 0], [3, 0, 1]], "force": [0, -500, 0] }}],
              "targets": {{ "star1": 0.7, "star2": 0.55, "star3": 0.45 }}
            }}"#,
            solid.as_str(),
            keep.as_str()
        )
    }

    #[test]
    fn parses_and_validates() {
        let s = Stage::from_json(&sample_json()).unwrap();
        assert_eq!(s.element_count(), 16);
        assert_eq!(s.supports[0].face, Face::XNeg);
        assert_eq!(s.cases().len(), 1);
        let keep = s.effective_keep().unwrap();
        assert!(keep[0]);
        assert!(keep[s.element_index([3, 0, 0])]);
        assert!(keep[s.element_index([3, 0, 1])]);
        assert!(!keep[s.element_index([1, 1, 1])]);
    }

    #[test]
    fn face_support_cells_are_supported_and_protected() {
        let s = Stage::from_json(&sample_json()).unwrap();
        let supported = s.supported_cells().unwrap();
        let keep = s.effective_keep().unwrap();
        for z in 0..2 {
            for y in 0..2 {
                let wall = s.element_index([0, y, z]);
                assert!(supported[wall] && keep[wall], "x- layer cell ({y},{z})");
                let inner = s.element_index([1, y, z]);
                assert!(!supported[inner]);
            }
        }
        assert_eq!(supported.iter().filter(|&&b| b).count(), 4);
    }

    #[test]
    fn roundtrips() {
        let s = Stage::from_json(&sample_json()).unwrap();
        let again = Stage::from_json(&s.to_json_pretty()).unwrap();
        assert_eq!(s, again);
    }

    #[test]
    fn rejects_load_outside_solid() {
        let bad = sample_json().replace("[3, 0, 1]]", "[9, 0, 1]]");
        assert!(Stage::from_json(&bad).is_err());
    }
}
