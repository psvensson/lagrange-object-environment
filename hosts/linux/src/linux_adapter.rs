//! The `LinuxRendererAdapter` (ADR 0013 / Bead e01 L3): ONE native adapter
//! implementing the EXISTING six-op RendererAdapter contract UNCHANGED
//! (`docs/contracts/renderer-adapter.md`), dispatching tool kinds
//! (navigator / inspector / unavailable-reference / unauthorized-reference) to
//! the L2 GTK realizer and the `glb` kind to the L1 `GlbHost` offscreen path.
//!
//! This is the SIBLING of the browser's `BrowserRendererAdapter`: it proves the
//! Compositor-facing contract is host-portable by realizing BOTH native routes
//! (native GTK tool controls + the native GLB Component) behind ONE adapter and
//! ONE opaque-handle surface map — exactly the contract's "one host, one
//! adapter" rule. It implements EXACTLY the six ops; `read_pixels` /
//! `take_intent` are HOST-SIDE inspection seams (NOT contract ops), mirroring
//! the browser's `readRenderedPixels` / `onIntent`.
//!
//! THREAD MODEL (plan-review resolution): GTK is main-thread-only, so all GTK
//! work happens on the thread that owns the adapter (the test's `#[test]`
//! thread); the GLB Component's Store + start-task are async and live on a
//! tokio runtime. The six ops are the only crossing: the GLB attach is
//! dispatched to a runtime `block_on` via an injected `glb_runner`, GTK attach
//! is synchronous. The adapter never runs GTK on a tokio worker.
//!
//! The contract's `RENDERER_ADAPTER_METHODS` is EXACTLY these six (the
//! `RendererAdapterOps` trait below is the compile-time "no widening"
//! falsification — a 7th op would have to be added there, and nothing does):
//!   create_surface / attach_presentation / detach_presentation / resize /
//!   destroy_surface / destroy_all.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;

use crate::projector::project;
use crate::semantic_gtk::{realize, GtkRealization, Intent};
use crate::{GlbHost, GlbInstance};

/// The RendererAdapter contract's six operations (and ONLY those six).
///
/// A native handle is an OPAQUE, TRANSIENT, Session-scoped string; a GTK
/// widget tree or a Wasmtime instance NEVER crosses the boundary as identity.
/// Every descriptor argument is data-representable JSON (see
/// `assert_data_representable`). This trait is the compile-time "no widening"
/// falsification: the L3 test names it, so a 7th contract op would be a
/// visible, deliberate change — and there is none.
pub trait RendererAdapterOps {
    fn create_surface(&mut self, view_descriptor: &Value) -> Result<String, String>;
    fn attach_presentation(&mut self, handle: &str, presentation_descriptor: &Value)
        -> Result<(), String>;
    fn detach_presentation(&mut self, handle: &str) -> Result<(), String>;
    fn resize(&mut self, handle: &str, width: u32, height: u32) -> Result<(), String>;
    fn destroy_surface(&mut self, handle: &str) -> Result<(), String>;
    fn destroy_all(&mut self) -> Result<(), String>;
}

/// The tool presentation kinds (mirrors `TOOL_KINDS` in
/// src/browser-renderer/dom-realizer.js). Anything else is a Component kind
/// (only `glb` is supported by this native host today).
const TOOL_KINDS: &[&str] = &[
    "navigator",
    "inspector",
    "unavailable-reference",
    "unauthorized-reference",
];

fn is_tool_kind(kind: &str) -> bool {
    TOOL_KINDS.contains(&kind)
}

/// A GLB async runner: the host wiring that bridges the SYNC adapter ops to
/// the tokio runtime the GLB Component's async work lives on. The test injects
/// a closure over its `tokio::runtime::Runtime::block_on`. This is the ONE
/// place the sync GTK thread crosses into async GLB work. The future drives
/// the live instance and returns it back (spawn returns a fresh one;
/// pump_frames returns the same one), so one bridge shape serves both.
pub type GlbRunner = Box<
    dyn FnMut(
        Pin<Box<dyn Future<Output = Result<GlbInstance, String>> + Send>>,
    ) -> Result<GlbInstance, String>,
>;

/// Data-representable loud-reject (the native analogue of the Compositor's
/// `assertDataRepresentable`): JSON round-trip deep-equality. A `serde_json`
/// `Value` is already JSON-data by construction (it cannot hold a callback,
/// class instance, Symbol, or undefined), so a native caller physically cannot
/// smuggle a live object across — but the check is re-implemented to keep the
/// boundary honest and to mirror the JS Compositor's enforcement, which is NOT
/// in this loop.
pub fn assert_data_representable(value: &Value, label: &str) -> Result<(), String> {
    let serialized = serde_json::to_string(value)
        .map_err(|e| format!("{label} must be data-representable (JSON-serializable): {e}"))?;
    let round_trip: Value = serde_json::from_str(&serialized).map_err(|e| {
        format!("{label} must be data-representable: JSON round-trip failed to parse: {e}")
    })?;
    if &round_trip != value {
        return Err(format!(
            "{label} must be data-representable: it does not survive a JSON round trip (a callback, class instance or non-JSON value would cross the renderer boundary)"
        ));
    }
    Ok(())
}

/// A PROCESS-GLOBAL handle ordinal: handles are opaque, transient, and unique
/// across every adapter instance in the process, so a recreated composition
/// (a fresh adapter minting handles) NEVER collides with a destroyed adapter's
/// handles. This makes "a handle is never durable identity / never reused"
/// observable: recreate-from-intent always yields FRESH, distinct handles.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(0);

/// One surface's native realization. A surface starts EMPTY (`create_surface`
/// only allocates the slot + size) and is realized by `attach_presentation`.
enum Realization {
    /// A native GTK tool pane (navigator / inspector / unavailable /
    /// unauthorized). Carries the SemanticUi document's source descriptor so
    /// the fixture can resolve key->ref via `descriptor_references`.
    Gtk {
        realization: GtkRealization,
        descriptor: Value,
    },
    /// A live native GLB Component instance (held open across frames).
    Glb(GlbInstance),
}

struct SurfaceEntry {
    width: u32,
    height: u32,
    realization: Option<Realization>,
}

/// The native Linux RendererAdapter. ONE surface map behind ONE adapter; a
/// GTK widget tree / Wasmtime instance never crosses as identity (only the
/// opaque string handle does).
pub struct LinuxRendererAdapter {
    glb_host: Arc<GlbHost>,
    glb_runner: GlbRunner,
    surfaces: HashMap<String, SurfaceEntry>,
}

impl LinuxRendererAdapter {
    pub fn new(glb_runner: GlbRunner) -> Self {
        Self {
            glb_host: Arc::new(GlbHost::new()),
            glb_runner,
            surfaces: HashMap::new(),
        }
    }

    fn require_live(&self, handle: &str, method: &str) -> Result<&SurfaceEntry, String> {
        self.surfaces
            .get(handle)
            .ok_or_else(|| format!("linux renderer: {method} on unknown/destroyed surface {handle}"))
    }

    fn require_live_mut(&mut self, handle: &str, method: &str) -> Result<&mut SurfaceEntry, String> {
        self.surfaces
            .get_mut(handle)
            .ok_or_else(|| format!("linux renderer: {method} on unknown/destroyed surface {handle}"))
    }

    // -- HOST-SIDE SEAMS (NOT contract ops) ---------------------------------

    /// Host-side inspection seam (the native analogue of the browser's
    /// `readRenderedPixels`; NOT a contract op): a `glb` handle -> the latest
    /// captured frame (Some(BGRA bytes)); a GTK handle -> None (like the DOM
    /// realizer). The caller applies its own pixel predicate (mesh_pixels).
    pub fn read_pixels(&self, handle: &str) -> Result<Option<Vec<u8>>, String> {
        let entry = self.require_live(handle, "read_pixels")?;
        Ok(match &entry.realization {
            Some(Realization::Glb(instance)) => instance.read_latest_frame(),
            _ => None,
        })
    }

    /// The frame geometry for a `glb` handle's `read_pixels` bytes
    /// (host-side; NOT a contract op). Returns (width, height, bytes_per_row)
    /// or None for a GTK handle (no readable frame).
    pub fn frame_geometry(&self, handle: &str) -> Result<Option<(u32, u32, u32)>, String> {
        let entry = self.require_live(handle, "frame_geometry")?;
        Ok(match &entry.realization {
            Some(Realization::Glb(instance)) => Some((
                instance.width(),
                instance.height(),
                instance.bytes_per_row(),
            )),
            _ => None,
        })
    }

    /// Host-side intent seam (the native analogue of the browser adapter's
    /// `onIntent` / a DOM button `.click()`; NOT a contract op): activate the
    /// GTK action with the given descriptor-local key on this surface's GTK
    /// realization and return the emitted `{kind:'activate-item', key}` intent
    /// — never a ref/subject. The fixture uses it to drive the selection loop
    /// (replicating `EnvironmentShell.handleActivateItem`). Returns None for a
    /// non-GTK handle or a stale key.
    pub fn activate_gtk_action(&self, handle: &str, key: i64) -> Result<Option<Intent>, String> {
        let entry = self.require_live(handle, "activate_gtk_action")?;
        Ok(match &entry.realization {
            Some(Realization::Gtk { realization, .. }) => realization.activate(key),
            _ => None,
        })
    }

    /// The descriptor behind a GTK surface's current realization (host-side;
    /// NOT a contract op): the fixture resolves key->ref against this via
    /// `descriptor_references`, replicating how `EnvironmentShell` reads the
    /// Compositor's OWN Presentation data. None for a GLB handle.
    pub fn gtk_descriptor(&self, handle: &str) -> Result<Option<Value>, String> {
        let entry = self.require_live(handle, "gtk_descriptor")?;
        Ok(match &entry.realization {
            Some(Realization::Gtk { descriptor, .. }) => Some(descriptor.clone()),
            _ => None,
        })
    }

    /// The visible text of a GTK surface's realization (host-side structural
    /// assertion; NOT a contract op). Empty for a GLB handle.
    pub fn gtk_visible_text(&self, handle: &str) -> Result<Vec<String>, String> {
        let entry = self.require_live(handle, "gtk_visible_text")?;
        Ok(match &entry.realization {
            Some(Realization::Gtk { realization, .. }) => realization.visible_text(),
            _ => Vec::new(),
        })
    }

    /// The action-button labels of a GTK surface's realization (host-side;
    /// NOT a contract op). Empty for a GLB handle.
    pub fn gtk_action_labels(&self, handle: &str) -> Result<Vec<String>, String> {
        let entry = self.require_live(handle, "gtk_action_labels")?;
        Ok(match &entry.realization {
            Some(Realization::Gtk { realization, .. }) => realization.action_labels(),
            _ => Vec::new(),
        })
    }

    /// Host-side frame pump (NOT a contract op): drive a `glb` surface's live
    /// Component through `n` animation frames so it presents, via the runtime
    /// bridge. The Component's async frame handler only advances while the
    /// tokio runtime is driven (inside the glb_runner's block_on), so the
    /// offscreen host pumps frames explicitly — the native analogue of the
    /// browser CI's run-to-completion offscreen driver. A GTK surface has no
    /// frame loop; pumping it is a no-op.
    pub fn pump_frames(&mut self, handle: &str, n: usize) -> Result<(), String> {
        // Take the realization out so the glb_runner (a &mut field) can be
        // borrowed alongside the instance; put it back afterward.
        let entry = self.require_live_mut(handle, "pump_frames")?;
        let realization = entry
            .realization
            .take()
            .ok_or_else(|| format!("linux renderer: pump_frames on unattached surface {handle}"))?;
        let realization = match realization {
            Realization::Glb(instance) => {
                // Drive until the Component presents a frame (load-independent),
                // not a fixed count: under host CPU contention a fixed count of
                // 30ms sleeps can elapse before the Component's frame handler is
                // scheduled through present(). `n` is the caller's attempt hint;
                // the bound is generous so a slow-but-live Component still lands.
                let max_frames = n.max(200);
                let fut: Pin<Box<dyn Future<Output = Result<GlbInstance, String>> + Send>> =
                    Box::pin(async move {
                        let presented = instance.drive_until_frame(max_frames).await;
                        if presented == 0 {
                            return Err(format!(
                                "linux renderer: GLB surface presented no frame within {max_frames} frames"
                            ));
                        }
                        Ok(instance)
                    });
                let instance = (self.glb_runner)(fut)?;
                Realization::Glb(instance)
            }
            gtk => gtk, // a GTK surface has no frame loop; leave it as-is.
        };
        self.require_live_mut(handle, "pump_frames")?.realization = Some(realization);
        Ok(())
    }
}

impl RendererAdapterOps for LinuxRendererAdapter {
    fn create_surface(&mut self, view_descriptor: &Value) -> Result<String, String> {
        assert_data_representable(view_descriptor, "viewDescriptor")?;
        let kind = view_descriptor.get("kind").and_then(|k| k.as_str());
        if kind.is_none_or(|k| k.is_empty()) {
            return Err("viewDescriptor.kind must be a non-empty string".to_string());
        }
        let width = view_descriptor
            .get("width")
            .and_then(|w| w.as_u64())
            .unwrap_or(0) as u32;
        let height = view_descriptor
            .get("height")
            .and_then(|h| h.as_u64())
            .unwrap_or(0) as u32;
        // An opaque, transient, Session-scoped handle. It is NEVER a durable
        // identity: recreate-from-intent mints a FRESH handle (process-unique).
        let ordinal = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);
        let handle = format!("linux-surface-{ordinal}");
        self.surfaces.insert(
            handle.clone(),
            SurfaceEntry {
                width,
                height,
                realization: None,
            },
        );
        Ok(handle)
    }

    fn attach_presentation(
        &mut self,
        handle: &str,
        presentation_descriptor: &Value,
    ) -> Result<(), String> {
        assert_data_representable(presentation_descriptor, "presentationDescriptor")?;
        let kind = presentation_descriptor
            .get("kind")
            .and_then(|k| k.as_str())
            .unwrap_or("");
        if kind.is_empty() {
            return Err(
                "presentationDescriptor.kind must be a non-empty string naming a renderer-resolved presentation kind"
                    .to_string(),
            );
        }
        let (width, height) = {
            let entry = self.require_live(handle, "attachPresentation")?;
            if entry.realization.is_some() {
                return Err(
                    "linux renderer: a presentation is already attached to this surface"
                        .to_string(),
                );
            }
            (entry.width, entry.height)
        };

        // Kind -> native realizer dispatch (the native analogue of the
        // browser's `realizerFor` seam): tool kinds -> the L2 GTK realizer
        // (project the descriptor to SemanticUi, then realize as GTK controls);
        // "glb" -> the L1 GlbHost offscreen path (a live GlbInstance).
        let realization = if is_tool_kind(kind) {
            let doc = project(presentation_descriptor)
                .map_err(|e| format!("linux renderer: project({kind}): {e}"))?;
            Realization::Gtk {
                realization: realize(&doc),
                descriptor: presentation_descriptor.clone(),
            }
        } else if kind == "glb" {
            // The attach-scoped asset allowlist from the descriptor's asset
            // bytes (the fixture supplies box.glb bytes as the 'main-model'
            // allowlist, mirroring L1's per-attach authorized bytes).
            let mut allowlist: HashMap<String, Vec<u8>> = HashMap::new();
            if let Some(assets) = presentation_descriptor
                .get("parameters")
                .and_then(|p| p.get("assets"))
                .and_then(|a| a.as_object())
            {
                for (name, bytes_val) in assets {
                    let b64 = bytes_val.as_str().ok_or_else(|| {
                        format!("linux renderer: glb asset {name:?} must be a base64 string")
                    })?;
                    let bytes = linux_adapter_base64::decode(b64).map_err(|e| {
                        format!("linux renderer: glb asset {name:?} base64: {e}")
                    })?;
                    allowlist.insert(name.clone(), bytes);
                }
            }
            let host = Arc::clone(&self.glb_host);
            let fut: Pin<Box<dyn Future<Output = Result<GlbInstance, String>> + Send>> =
                Box::pin(async move {
                    GlbInstance::spawn(&host, allowlist, width.max(1), height.max(1))
                        .await
                        .map_err(|e| format!("linux renderer: glb spawn: {e:#}"))
                });
            let instance = (self.glb_runner)(fut)?;
            Realization::Glb(instance)
        } else {
            return Err(format!(
                "linux renderer: no realizer for presentation kind {kind:?} (this host realizes tool kinds + glb)"
            ));
        };

        let entry = self.require_live_mut(handle, "attachPresentation")?;
        entry.realization = Some(realization);
        Ok(())
    }

    fn detach_presentation(&mut self, handle: &str) -> Result<(), String> {
        let entry = self.require_live_mut(handle, "detachPresentation")?;
        // Dropping the realization tears it down: a GTK widget tree is dropped
        // (GTK teardown); a GlbInstance's Drop aborts its start task, ending
        // the Component. The surface (slot + size) stays.
        entry.realization = None;
        Ok(())
    }

    fn resize(&mut self, handle: &str, width: u32, height: u32) -> Result<(), String> {
        let entry = self.require_live_mut(handle, "resize")?;
        entry.width = width;
        entry.height = height;
        if let Some(Realization::Glb(instance)) = &entry.realization {
            instance.resize(width.max(1), height.max(1));
        }
        Ok(())
    }

    fn destroy_surface(&mut self, handle: &str) -> Result<(), String> {
        let entry = self
            .surfaces
            .remove(handle)
            .ok_or_else(|| format!("linux renderer: destroySurface on unknown/destroyed surface {handle}"))?;
        // Drop the realization (GTK widget tree / GlbInstance) before removing.
        drop(entry.realization);
        Ok(())
    }

    fn destroy_all(&mut self) -> Result<(), String> {
        // Tear down EVERY surface's realization and clear the map: each GTK
        // widget tree and each live GlbInstance (its Component start task is
        // aborted). No process-global store to clear. The adapter stays
        // usable: a Session destroy is realized by DISCARDING this adapter and
        // constructing a fresh one (the Compositor owns Session lifecycle; the
        // recreated composition mints FRESH handles, never reusing a destroyed
        // one — handles are process-unique, see create_surface).
        for (_, entry) in self.surfaces.drain() {
            drop(entry.realization);
        }
        Ok(())
    }
}

/// The base64 decode used for the glb asset bytes (kept dependency-free: the
/// descriptor carries asset bytes as base64 JSON strings, mirroring how the
/// browser receives resolved asset bytes for an attach).
pub mod linux_adapter_base64 {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn value_of(byte: u8) -> Option<u32> {
        ALPHABET.iter().position(|&b| b == byte).map(|p| p as u32)
    }

    pub fn decode(input: &str) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
        let mut i = 0;
        while i < bytes.len() {
            let chunk = &bytes[i..(i + 4).min(bytes.len())];
            let pad = chunk.iter().filter(|&&b| b == b'=').count();
            let mut vals = [0u32; 4];
            for (j, &b) in chunk.iter().enumerate() {
                vals[j] = if b == b'=' {
                    0
                } else {
                    value_of(b).ok_or_else(|| format!("invalid base64 byte {b:#x}"))?
                };
            }
            let n = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
            out.push((n >> 16) as u8);
            if pad < 2 {
                out.push((n >> 8) as u8);
            }
            if pad < 1 {
                out.push(n as u8);
            }
            i += 4;
        }
        Ok(out)
    }

    pub fn encode(input: &[u8]) -> String {
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[(n >> 18) as usize & 63] as char);
            out.push(ALPHABET[(n >> 12) as usize & 63] as char);
            out.push(if chunk.len() > 1 {
                ALPHABET[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                ALPHABET[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }
}
