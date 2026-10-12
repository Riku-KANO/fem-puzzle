//! wasm-bindgen bindings for `fem`. Spec: `docs/specs/worker-protocol.md`.
//!
//! `Session` is a thin wrapper over [`core::SessionCore`] (plain Rust, natively tested):
//! errors become `JsError` (a JS `Error` with the message), per-element / per-node results
//! are returned as freshly allocated `Float32Array` / `Uint32Array` copies (safe to
//! transfer to another thread), and `iterate` returns a plain `StepStatus` object.

pub mod convert;
pub mod core;
pub mod options;

use crate::core::{SessionCore, StepStatus};
use wasm_bindgen::prelude::*;

/// Crate version, handy for checking that the WASM bundle loaded.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen(typescript_custom_section)]
const TS_STEP_STATUS: &'static str = r#"
/** Returned by `Session.iterate` — a plain object (no `free()`, safe to `postMessage`). */
export interface StepStatus {
  /** load case being solved (the last one once `done`) */
  case: number;
  /** PCG iterations since the last `begin()`, summed over all load cases */
  iterations: number;
  /** ‖r‖ / ‖f‖ of `case`; once `done`, the maximum over all cases */
  rel_residual: number;
  /**
   * every case converged or stopped (`maxIters` per case, stagnation);
   * converged ⇔ done && rel_residual <= tol
   */
  done: boolean;
}
"#;

/// One solver session for one stage. See `docs/specs/worker-protocol.md`.
#[wasm_bindgen]
pub struct Session {
    core: SessionCore,
}

#[wasm_bindgen]
impl Session {
    /// Build the problem from a stage JSON and a `SolverOptionsMsg` JSON
    /// (`""`/`"{}"` = defaults: `tol` 1e-4, multigrid). Throws on a bad stage or options.
    #[wasm_bindgen(constructor)]
    pub fn new(
        #[wasm_bindgen(js_name = stageJson)] stage_json: &str,
        #[wasm_bindgen(js_name = optionsJson)] options_json: &str,
    ) -> Result<Session, JsError> {
        install_panic_hook();
        SessionCore::new(stage_json, options_json)
            .map(|core| Session { core })
            .map_err(|e| JsError::new(&e))
    }

    /// Element count `nx·ny·nz`.
    #[wasm_bindgen(getter)]
    pub fn elements(&self) -> u32 {
        self.core.elements() as u32
    }

    /// Node count `(nx+1)(ny+1)(nz+1)`.
    #[wasm_bindgen(getter)]
    pub fn nodes(&self) -> u32 {
        self.core.nodes() as u32
    }

    /// Multigrid levels in use (0 = Jacobi PCG).
    #[wasm_bindgen(getter)]
    pub fn levels(&self) -> u32 {
        self.core.levels() as u32
    }

    /// Carve (`solid = false`) or restore (`solid = true`) elements; idempotent. Throws
    /// (and changes nothing) on an out-of-range index, on carving a protected element
    /// (keep / support / load) or on restoring an element outside the design domain.
    pub fn set_solid(&mut self, indices: &[u32], solid: bool) -> Result<(), JsError> {
        self.core
            .set_solid(indices, solid)
            .map_err(|e| JsError::new(&e))
    }

    /// Start a (warm-started) solve of the current solid set.
    pub fn begin(&mut self) {
        self.core.begin();
    }

    /// Run at most `maxIters` PCG iterations (begins implicitly if the solid set changed).
    #[wasm_bindgen(unchecked_return_type = "StepStatus")]
    pub fn iterate(&mut self, #[wasm_bindgen(js_name = maxIters)] max_iters: u32) -> JsValue {
        step_status_to_js(self.core.iterate(max_iters))
    }

    pub fn case_count(&self) -> u32 {
        self.core.case_count() as u32
    }

    pub fn case_name(
        &self,
        #[wasm_bindgen(js_name = caseIdx)] case_idx: u32,
    ) -> Result<String, JsError> {
        self.core
            .case_name(case_idx)
            .map(str::to_owned)
            .map_err(|e| JsError::new(&e))
    }

    /// Per-element von Mises utilisation, 0 for inactive elements (fresh copy).
    pub fn utilization(
        &mut self,
        #[wasm_bindgen(js_name = caseIdx)] case_idx: u32,
    ) -> Result<Vec<f32>, JsError> {
        self.core
            .utilization(case_idx)
            .map_err(|e| JsError::new(&e))
    }

    /// Per-node displacement xyz in m, length `3 * nodes` (fresh copy).
    pub fn displacement(
        &self,
        #[wasm_bindgen(js_name = caseIdx)] case_idx: u32,
    ) -> Result<Vec<f32>, JsError> {
        self.core
            .displacement(case_idx)
            .map_err(|e| JsError::new(&e))
    }

    /// Max utilisation over active, non-keep elements.
    pub fn judged_max_utilization(
        &self,
        #[wasm_bindgen(js_name = caseIdx)] case_idx: u32,
    ) -> Result<f64, JsError> {
        self.core
            .judged_max_utilization(case_idx)
            .map_err(|e| JsError::new(&e))
    }

    /// Max displacement magnitude over the load cells' nodes (m).
    pub fn load_displacement(
        &self,
        #[wasm_bindgen(js_name = caseIdx)] case_idx: u32,
    ) -> Result<f64, JsError> {
        self.core
            .load_displacement(case_idx)
            .map_err(|e| JsError::new(&e))
    }

    /// Solid elements not connected to any support (fresh copy).
    pub fn floating(&self) -> Vec<u32> {
        self.core.floating()
    }

    /// Every load cell is connected to a support.
    pub fn loads_connected(&self) -> bool {
        self.core.loads_connected()
    }
}

fn step_status_to_js(s: StepStatus) -> JsValue {
    let obj = js_sys::Object::new();
    let set = |key: &str, value: JsValue| {
        // Setting a data property on a fresh plain object cannot fail.
        let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(key), &value);
    };
    set("case", JsValue::from(s.case as u32));
    set("iterations", JsValue::from(s.iterations as u32));
    set("rel_residual", JsValue::from(s.rel_residual));
    set("done", JsValue::from(s.done));
    obj.into()
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(msg: &str);
}

/// Route Rust panics to `console.error` before the (panic = abort) trap, so a worker
/// crash shows the message instead of a bare "unreachable".
fn install_panic_hook() {
    #[cfg(target_arch = "wasm32")]
    {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            std::panic::set_hook(Box::new(|info| {
                console_error(&format!("fem-wasm panic: {info}"));
            }));
        });
    }
}
