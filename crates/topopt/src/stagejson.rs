//! Deterministic rewrite of stage JSON files.
//!
//! The Blender exporter (T-103, `tools/blender/stagecore.py`) writes exactly
//! `serde_json::to_string_pretty(&Value) + "\n"`: keys sorted (serde_json's default
//! `BTreeMap`), 2-space indent, arrays one element per line, floats in ryu layout, every
//! `f64` field written as a float, `-0.0` normalised to `0.0`. We therefore edit the
//! parsed `Value` in place and re-serialise the same way; untouched fields round-trip
//! byte-identically (`float_roundtrip` is enabled so float parsing is exact).
//!
//! Only `loads[].force` (and `loadCases[].loads[].force`), `targets` and `benchmark` are
//! ever changed.

use crate::{Error, Result, err};
use serde_json::Value;

pub fn parse(text: &str) -> Result<Value> {
    Ok(serde_json::from_str(text)?)
}

/// Serialise like the exporter.
pub fn to_text(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).unwrap_or_default();
    s.push('\n');
    s
}

/// `0.0` for any zero (no `-0.0` in files).
pub fn norm_zero(x: f64) -> f64 {
    if x == 0.0 { 0.0 } else { x }
}

/// Round to `digits` significant digits, toward zero (so a scaled load never exceeds the
/// exact calibrated value). Returns the nearest `f64` to the short decimal.
pub fn round_sig_toward_zero(x: f64, digits: usize) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return norm_zero(x);
    }
    let digits = digits.max(1);
    let exp = x.abs().log10().floor() as i32;
    let scale_pow = digits as i32 - 1 - exp;
    // Work on the decimal string to avoid 10^k rounding noise: mantissa as an integer.
    let m = (x.abs() * 10f64.powi(scale_pow)).trunc();
    // guard against log10 off-by-one at exact powers of ten
    let m = if m >= 10f64.powi(digits as i32) {
        (m / 10.0).trunc() * 10.0
    } else {
        m
    };
    let s = format!("{}e{}", m as u64, -scale_pow);
    let v: f64 = s.parse().unwrap_or(x.abs());
    norm_zero(v.copysign(x))
}

/// Round half away from zero to `decimals` places via the decimal string.
pub fn round_decimals(x: f64, decimals: usize) -> f64 {
    let s = format!("{:.*}", decimals, x);
    norm_zero(s.parse().unwrap_or(x))
}

fn loads_arrays(v: &Value) -> Vec<&Vec<Value>> {
    let mut out = Vec::new();
    if let Some(Value::Array(loads)) = v.get("loads") {
        out.push(loads);
    }
    if let Some(Value::Array(cases)) = v.get("loadCases") {
        for c in cases {
            if let Some(Value::Array(loads)) = c.get("loads") {
                out.push(loads);
            }
        }
    }
    out
}

fn force_of(load: &Value) -> Result<[f64; 3]> {
    let f = load
        .get("force")
        .and_then(Value::as_array)
        .ok_or_else(|| Error("load without force array".into()))?;
    if f.len() != 3 {
        return err("force must have 3 components");
    }
    let mut out = [0.0; 3];
    for (o, c) in out.iter_mut().zip(f) {
        *o = c
            .as_f64()
            .ok_or_else(|| Error("force component is not a number".into()))?;
    }
    Ok(out)
}

/// Every force vector in file order: `loads[]` then `loadCases[].loads[]`.
pub fn forces(v: &Value) -> Result<Vec<[f64; 3]>> {
    loads_arrays(v)
        .into_iter()
        .flatten()
        .map(force_of)
        .collect()
}

/// Replace every force vector (same order as [`forces`]).
pub fn set_forces(v: &mut Value, new: &[[f64; 3]]) -> Result<()> {
    let mut it = new.iter();
    let mut set = |loads: &mut Value| -> Result<()> {
        if let Value::Array(loads) = loads {
            for l in loads {
                let f = it
                    .next()
                    .ok_or_else(|| Error("force count mismatch".into()))?;
                let arr = f.iter().map(|&c| Value::from(norm_zero(c))).collect();
                match l {
                    Value::Object(m) => {
                        m.insert("force".into(), Value::Array(arr));
                    }
                    _ => return err("load is not an object"),
                }
            }
        }
        Ok(())
    };
    if let Some(loads) = v.get_mut("loads") {
        set(loads)?;
    }
    if let Some(Value::Array(cases)) = v.get_mut("loadCases") {
        for c in cases {
            if let Some(loads) = c.get_mut("loads") {
                set(loads)?;
            }
        }
    }
    if it.next().is_some() {
        return err("force count mismatch");
    }
    Ok(())
}

fn object_mut(v: &mut Value) -> Result<&mut serde_json::Map<String, Value>> {
    v.as_object_mut()
        .ok_or_else(|| Error("stage JSON is not an object".into()))
}

pub fn set_targets(v: &mut Value, t: &stage::Targets) -> Result<()> {
    let t = stage::Targets {
        star1: norm_zero(t.star1),
        star2: norm_zero(t.star2),
        star3: norm_zero(t.star3),
    };
    object_mut(v)?.insert("targets".into(), serde_json::to_value(&t)?);
    Ok(())
}

pub fn set_benchmark(v: &mut Value, b: &stage::Benchmark) -> Result<()> {
    object_mut(v)?.insert("benchmark".into(), serde_json::to_value(b)?);
    Ok(())
}

/// The stage with everything calibration owns blanked out: `targets`, `benchmark` and
/// force values. Two stages with equal skeletons differ only in calibrated data.
pub fn skeleton(v: &Value) -> Result<Value> {
    let mut s = v.clone();
    let n = forces(v)?.len();
    set_forces(&mut s, &vec![[0.0; 3]; n])?;
    let m = object_mut(&mut s)?;
    m.remove("targets");
    m.remove("benchmark");
    Ok(s)
}

/// Copy the calibrated fields (forces, targets, benchmark) of `from` into `to`.
pub fn graft_calibration(to: &mut Value, from: &Value) -> Result<()> {
    set_forces(to, &forces(from)?)?;
    let src = from
        .as_object()
        .ok_or_else(|| Error("stage JSON is not an object".into()))?;
    let dst = object_mut(to)?;
    for key in ["targets", "benchmark"] {
        match src.get(key) {
            Some(val) => {
                dst.insert(key.into(), val.clone());
            }
            None => {
                dst.remove(key);
            }
        }
    }
    Ok(())
}

/// If `scaled ≈ s · base` for one `s > 0` (relative to the largest component), return `s`.
pub fn common_scale(base: &[[f64; 3]], scaled: &[[f64; 3]], rel_tol: f64) -> Option<f64> {
    if base.len() != scaled.len() || base.is_empty() {
        return None;
    }
    let (mut num, mut den) = (0.0, 0.0);
    for (b, c) in base.iter().zip(scaled) {
        for k in 0..3 {
            num += b[k] * c[k];
            den += b[k] * b[k];
        }
    }
    if den <= 0.0 || num <= 0.0 {
        return None;
    }
    let s = num / den;
    let max = scaled
        .iter()
        .flat_map(|c| c.iter())
        .fold(0.0f64, |m, &x| m.max(x.abs()));
    let ok = base
        .iter()
        .zip(scaled)
        .all(|(b, c)| (0..3).all(|k| (c[k] - s * b[k]).abs() <= rel_tol * max));
    ok.then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
  "grid": [
    2,
    1,
    1
  ],
  "id": "t-01",
  "loads": [
    {
      "cells": [
        [
          1,
          0,
          0
        ]
      ],
      "force": [
        0.0,
        -500.0,
        0.0
      ]
    }
  ],
  "material": {
    "E": 70000000000.0,
    "allowable": 120000000.0,
    "density": 2700.0,
    "nu": 0.33
  },
  "targets": {
    "star1": 0.7,
    "star2": 0.55,
    "star3": 0.45
  },
  "title": "片持ち梁",
  "voxelSize": 0.01
}
"#;

    #[test]
    fn roundtrips_exporter_layout_byte_identically() {
        let v = parse(SAMPLE).unwrap();
        assert_eq!(to_text(&v), SAMPLE);
        let floats = r#"{
  "a": 1e-7,
  "b": 1.5e-7,
  "c": 1e+16,
  "d": 0.1,
  "e": 0.30000000000000004
}
"#;
        assert_eq!(to_text(&parse(floats).unwrap()), floats);
    }

    #[test]
    fn rounding_helpers() {
        assert_eq!(round_sig_toward_zero(-1228.35, 4), -1228.0);
        assert_eq!(round_sig_toward_zero(1234.9999, 4), 1234.0);
        assert_eq!(round_sig_toward_zero(0.0123456, 3), 0.0123);
        assert_eq!(round_sig_toward_zero(1000.0, 4), 1000.0);
        assert_eq!(round_sig_toward_zero(9999.99, 2), 9900.0);
        assert_eq!(round_sig_toward_zero(-0.0, 4).to_bits(), 0.0f64.to_bits());
        assert_eq!(round_decimals(0.36251, 3), 0.363);
        assert_eq!(round_decimals(0.1 + 0.2, 3), 0.3);
        assert_eq!(norm_zero(-0.0).to_bits(), 0.0f64.to_bits());
    }

    #[test]
    fn edits_forces_targets_benchmark() {
        let mut v = parse(SAMPLE).unwrap();
        assert_eq!(forces(&v).unwrap(), vec![[0.0, -500.0, 0.0]]);
        set_forces(&mut v, &[[-0.0, -1234.0, 0.0]]).unwrap();
        set_targets(
            &mut v,
            &stage::Targets {
                star1: 0.6,
                star2: 0.45,
                star3: 0.35,
            },
        )
        .unwrap();
        set_benchmark(
            &mut v,
            &stage::Benchmark {
                volume: 0.3,
                solid: stage::Bitmask::from_bools(&[true, true]),
                max_utilization: Some(0.9),
                method: Some("simp-oc".into()),
            },
        )
        .unwrap();
        let text = to_text(&v);
        assert!(
            text.contains("\"force\": [\n        0.0,\n        -1234.0,\n        0.0\n      ]")
        );
        assert!(text.contains("\"maxUtilization\": 0.9,"));
        assert!(text.contains("\"method\": \"simp-oc\","));
        assert!(text.starts_with("{\n  \"benchmark\": {\n    \"maxUtilization\""));
        // the stage crate accepts the result
        let s: stage::Stage = serde_json::from_str(&text.replace(
            "\"grid\"",
            "\"version\": 1, \"keep\": \"AA==\", \"solid\": \"Aw==\", \"supports\": [{\"face\": \"x-\", \"fix\": \"xyz\"}], \"grid\"",
        ))
        .unwrap();
        assert_eq!(s.targets.star3, 0.35);
        assert_eq!(s.loads[0].force, [0.0, -1234.0, 0.0]);
    }

    #[test]
    fn skeleton_graft_and_scale() {
        let fresh = parse(SAMPLE).unwrap();
        let mut cal = fresh.clone();
        set_forces(&mut cal, &[[0.0, -1234.0, 0.0]]).unwrap();
        set_targets(
            &mut cal,
            &stage::Targets {
                star1: 0.6,
                star2: 0.45,
                star3: 0.35,
            },
        )
        .unwrap();
        assert_eq!(skeleton(&fresh).unwrap(), skeleton(&cal).unwrap());
        let s = common_scale(&forces(&fresh).unwrap(), &forces(&cal).unwrap(), 1e-3).unwrap();
        assert!((s - 2.468).abs() < 1e-12);
        assert!(common_scale(&[[1.0, 0.0, 0.0]], &[[0.0, 1.0, 0.0]], 1e-3).is_none());
        assert!(common_scale(&[[1.0, 0.0, 0.0]], &[[-1.0, 0.0, 0.0]], 1e-3).is_none());
        let mut out = fresh.clone();
        graft_calibration(&mut out, &cal).unwrap();
        assert_eq!(to_text(&out), to_text(&cal));
        let mut other = fresh.clone();
        other["title"] = Value::from("x");
        assert_ne!(skeleton(&other).unwrap(), skeleton(&cal).unwrap());
    }
}
