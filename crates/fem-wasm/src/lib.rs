//! wasm-bindgen bindings for `fem`. Spec: `docs/specs/worker-protocol.md`.
//!
//! The `Session` API is implemented by task `T-202`.

pub mod convert;
pub mod options;

use wasm_bindgen::prelude::*;

/// Crate version, handy for checking that the WASM bundle loaded.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
