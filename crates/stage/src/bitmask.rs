use crate::StageError;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

/// Element bitmask, base64 encoded. Bit `e` is byte `e >> 3`, bit `e & 7` (LSB first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Bitmask(String);

impl Bitmask {
    pub fn from_bools(bits: &[bool]) -> Bitmask {
        let mut bytes = vec![0u8; bits.len().div_ceil(8)];
        for (e, _) in bits.iter().enumerate().filter(|(_, b)| **b) {
            bytes[e >> 3] |= 1 << (e & 7);
        }
        Bitmask(STANDARD.encode(bytes))
    }

    /// Decode into exactly `n` flags. Errors if the byte length does not match.
    pub fn to_bools(&self, n: usize) -> Result<Vec<bool>, StageError> {
        let bytes = STANDARD
            .decode(&self.0)
            .map_err(|e| StageError(format!("bad base64 bitmask: {e}")))?;
        if bytes.len() != n.div_ceil(8) {
            return Err(StageError(format!(
                "bitmask has {} bytes, expected {} for {n} elements",
                bytes.len(),
                n.div_ceil(8)
            )));
        }
        Ok((0..n)
            .map(|e| bytes[e >> 3] & (1 << (e & 7)) != 0)
            .collect())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_bit_order() {
        let mut bits = vec![false; 11];
        bits[0] = true;
        bits[9] = true;
        let m = Bitmask::from_bools(&bits);
        // byte0 = 0b0000_0001, byte1 = 0b0000_0010
        assert_eq!(m.as_str(), STANDARD.encode([1u8, 2u8]));
        assert_eq!(m.to_bools(11).unwrap(), bits);
        assert!(m.to_bools(17).is_err());
    }
}
