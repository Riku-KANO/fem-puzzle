//! Pure-Rust conversions between the solver's types and what crosses the JS boundary
//! (`f32` typed arrays, `u32` indices). Kept free of `wasm-bindgen` types so they can be
//! unit-tested natively.

/// Narrow solver output to `f32` for `Float32Array`s. Values outside the `f32` range
/// become `±inf` (never happens for physical results), NaN stays NaN.
pub fn to_f32(values: &[f64]) -> Vec<f32> {
    values.iter().map(|&v| v as f32).collect()
}

/// Element indices for `Uint32Array`s. Callers guarantee every index fits in `u32`
/// (`Session::new` rejects grids with more than `u32::MAX` elements).
pub fn to_u32(indices: &[usize]) -> Vec<u32> {
    indices
        .iter()
        .map(|&i| u32::try_from(i).unwrap_or(u32::MAX))
        .collect()
}

/// Validate a `set_solid(indices, solid)` batch against the problem and turn it into the
/// solver's change list. The whole batch is rejected on the first bad index, so a
/// failing call never applies half a diff.
///
/// Rules (stage-format.md):
/// - every index must be `< elements`;
/// - only *domain* elements (initially solid) can become solid again;
/// - *keep* elements (incl. implicit support/load cells) cannot be carved.
pub fn validate_changes(
    indices: &[u32],
    solid: bool,
    domain: &[bool],
    keep: &[bool],
) -> Result<Vec<(usize, bool)>, String> {
    let n = domain.len();
    let mut changes = Vec::with_capacity(indices.len());
    for &raw in indices {
        let e = raw as usize;
        if e >= n {
            return Err(format!(
                "set_solid: element index {raw} out of range (elements = {n})"
            ));
        }
        if solid && !domain[e] {
            return Err(format!(
                "set_solid: element {raw} is not part of the design domain and cannot become solid"
            ));
        }
        if !solid && keep.get(e).copied().unwrap_or(false) {
            return Err(format!(
                "set_solid: element {raw} is protected (keep / support / load) and cannot be carved"
            ));
        }
        changes.push((e, solid));
    }
    Ok(changes)
}

/// Check a load-case index coming from JS.
pub fn check_case(case: u32, count: usize) -> Result<usize, String> {
    let c = case as usize;
    if c < count {
        Ok(c)
    } else {
        Err(format!("case index {case} out of range (cases = {count})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f32_narrowing() {
        let v = to_f32(&[0.0, -1.5, 1e-12, 3.0e38, 1e300, f64::NAN]);
        assert_eq!(v[0], 0.0);
        assert_eq!(v[1], -1.5);
        assert!((v[2] - 1e-12).abs() < 1e-18);
        assert_eq!(v[3], 3.0e38);
        assert!(v[4].is_infinite());
        assert!(v[5].is_nan());
    }

    #[test]
    fn u32_indices() {
        assert_eq!(to_u32(&[0, 7, 4_000_000_000]), vec![0, 7, 4_000_000_000]);
        assert!(to_u32(&[]).is_empty());
    }

    #[test]
    fn changes_ok() {
        let domain = [true, true, false, true];
        let keep = [true, false, false, false];
        assert_eq!(
            validate_changes(&[1, 3], false, &domain, &keep),
            Ok(vec![(1, false), (3, false)])
        );
        // restoring a keep element is a harmless no-op request
        assert_eq!(
            validate_changes(&[0, 1], true, &domain, &keep),
            Ok(vec![(0, true), (1, true)])
        );
        assert_eq!(validate_changes(&[], true, &domain, &keep), Ok(vec![]));
    }

    #[test]
    fn changes_rejected() {
        let domain = [true, true, false, true];
        let keep = [true, false, false, false];
        let out_of_range = validate_changes(&[1, 4], false, &domain, &keep).unwrap_err();
        assert!(out_of_range.contains("out of range"), "{out_of_range}");
        let not_domain = validate_changes(&[2], true, &domain, &keep).unwrap_err();
        assert!(not_domain.contains("design domain"), "{not_domain}");
        let protected = validate_changes(&[3, 0], false, &domain, &keep).unwrap_err();
        assert!(protected.contains("protected"), "{protected}");
        // carving a non-domain element (already empty) is allowed: it is a no-op
        assert_eq!(
            validate_changes(&[2], false, &domain, &keep),
            Ok(vec![(2, false)])
        );
    }

    #[test]
    fn case_index() {
        assert_eq!(check_case(0, 1), Ok(0));
        assert_eq!(check_case(2, 3), Ok(2));
        assert!(check_case(1, 1).is_err());
        assert!(check_case(u32::MAX, 3).is_err());
    }
}
