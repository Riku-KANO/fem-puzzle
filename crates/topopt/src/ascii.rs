//! Text renderings of density fields and designs, for `--ascii` debugging and the task log.
//! Slices are x (columns, left → right) by y (rows, top = +y since stages are Y-up).

use crate::layout::Layout;

const SHADES: [char; 5] = [' ', '.', ':', '+', '#'];

fn shade(rho: f64) -> char {
    let i = (rho.clamp(0.0, 1.0) * (SHADES.len() - 1) as f64).round() as usize;
    SHADES[i.min(SHADES.len() - 1)]
}

/// One z-slice of a continuous field. Block cells are `x`.
pub fn density_slice(layout: &Layout, rho: &[f64], z: usize) -> String {
    let d = layout.dims;
    let mut s = String::new();
    for y in (0..d.ny).rev() {
        s.push('|');
        for x in 0..d.nx {
            let e = d.index(x, y, z);
            s.push(if layout.block[e] { 'x' } else { shade(rho[e]) });
        }
        s.push_str("|\n");
    }
    s
}

/// One z-slice of a 0/1 design: `#` solid, `K` keep, `S` supported solid, `L` load cell,
/// `x` block, ` ` empty.
pub fn design_slice(layout: &Layout, solid: &[bool], z: usize) -> String {
    let d = layout.dims;
    let mut s = String::new();
    for y in (0..d.ny).rev() {
        s.push('|');
        for x in 0..d.nx {
            let e = d.index(x, y, z);
            let c = if layout.block[e] {
                'x'
            } else if !solid[e] {
                ' '
            } else if layout.load_cells.binary_search(&e).is_ok() {
                'L'
            } else if layout.supported[e] {
                'S'
            } else if layout.keep[e] {
                'K'
            } else {
                '#'
            };
            s.push(c);
        }
        s.push_str("|\n");
    }
    s
}

/// Column-wise projection along z of a 0/1 design: digit = number of solid cells in the
/// column (`.` = 0, `#` = all), so 3D shapes fit in one picture.
pub fn design_projection(layout: &Layout, solid: &[bool]) -> String {
    let d = layout.dims;
    let mut s = String::new();
    for y in (0..d.ny).rev() {
        s.push('|');
        for x in 0..d.nx {
            let k = (0..d.nz).filter(|&z| solid[d.index(x, y, z)]).count();
            let blocked = (0..d.nz).any(|z| layout.block[d.index(x, y, z)]);
            let c = if k == 0 {
                if blocked { 'x' } else { ' ' }
            } else if k == d.nz {
                '#'
            } else {
                char::from_digit(k as u32 % 10, 10).unwrap_or('?')
            };
            s.push(c);
        }
        s.push_str("|\n");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Dims;

    #[test]
    fn renders_top_row_first() {
        let dims = Dims::new(3, 2, 2);
        let n = dims.len();
        let mut supported = vec![false; n];
        supported[0] = true;
        let l = Layout {
            dims,
            domain: vec![true; n],
            keep: vec![false; n],
            supported,
            load_cells: vec![dims.index(2, 1, 0)],
            block: vec![false; n],
        };
        let mut solid = vec![false; n];
        solid[dims.index(0, 0, 0)] = true;
        solid[dims.index(1, 0, 0)] = true;
        solid[dims.index(2, 1, 0)] = true;
        solid[dims.index(1, 0, 1)] = true;
        assert_eq!(design_slice(&l, &solid, 0), "|  L|\n|S# |\n");
        assert_eq!(design_projection(&l, &solid), "|  1|\n|1# |\n");
        let rho: Vec<f64> = (0..n).map(|e| if e % 2 == 0 { 1.0 } else { 0.5 }).collect();
        assert_eq!(density_slice(&l, &rho, 0), "|:#:|\n|#:#|\n");
    }
}
