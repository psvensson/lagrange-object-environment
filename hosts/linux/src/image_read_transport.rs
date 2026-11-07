//! Native HTTP(S) mechanics for the read-service connection. No Images schema,
//! authority or semantic error interpretation lives here. The guest receives
//! opaque status/body data, never the credential or an arbitrary URL capability.
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::{AbortHandle, Abortable, BoxFuture};
use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use rquickjs::{function::Async, Ctx, Function, Result as JsResult};
use serde::Serialize;

pub const HOST_BINDING_JS: &str = include_str!("image_read_transport.js");
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOKEN_BYTES: usize = 4096;
const MAX_PENDING: usize = 16;
const MAX_JS_ID: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    Configuration,
    Unavailable,
    TooLarge,
    Cancelled,
    Closed,
    Busy,
    Identity,
}

#[derive(Debug, Serialize)]
pub struct ReadResponse {
    pub status: u16,
    pub body: String,
}

struct State {
    closed: bool,
    pending: HashMap<u64, AbortHandle>,
}
struct Inner {
    network_executor: tokio::runtime::Handle,
    client: reqwest::Client,
    endpoint: reqwest::Url,
    authorization: HeaderValue,
    state: Mutex<State>,
    ordinal: AtomicU64,
}
#[derive(Clone)]
pub struct ImageReadTransport {
    inner: Arc<Inner>,
}

// No Debug on credential-bearing state. Errors contain only a local enum.
impl ImageReadTransport {
    /// The composition keeps this non-JavaScript executor alive through network
    /// shutdown. Guest progress must never be required to drive or cancel I/O.
    pub fn new(
        origin: &str,
        token: &str,
        ca_pem: Option<&[u8]>,
        timeout: Duration,
        network_executor: tokio::runtime::Handle,
    ) -> Result<Self, TransportError> {
        let mut endpoint =
            reqwest::Url::parse(origin).map_err(|_| TransportError::Configuration)?;
        if !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
            || endpoint.host_str().is_none()
            || timeout.is_zero()
            || timeout > Duration::from_secs(60)
        {
            return Err(TransportError::Configuration);
        }
        let loopback = matches!(endpoint.host_str(), Some("127.0.0.1" | "[::1]" | "::1"));
        if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && loopback) {
            return Err(TransportError::Configuration);
        }
        endpoint.set_path("/v1/read");
        if token.is_empty()
            || token.len() > MAX_TOKEN_BYTES
            || token.bytes().any(|b| !b.is_ascii_graphic())
        {
            return Err(TransportError::Configuration);
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| TransportError::Configuration)?;
        authorization.set_sensitive(true);
        let mut builder = reqwest::Client::builder()
            .tls_backend_native()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .referer(false)
            .http1_only()
            .pool_max_idle_per_host(0)
            .timeout(timeout)
            .connect_timeout(timeout);
        if let Some(pem) = ca_pem {
            let certificate =
                reqwest::Certificate::from_pem(pem).map_err(|_| TransportError::Configuration)?;
            builder = builder.add_root_certificate(certificate);
        }
        let client = builder.build().map_err(|_| TransportError::Configuration)?;
        Ok(Self {
            inner: Arc::new(Inner {
                network_executor,
                client,
                endpoint,
                authorization,
                state: Mutex::new(State {
                    closed: false,
                    pending: HashMap::new(),
                }),
                ordinal: AtomicU64::new(0),
            }),
        })
    }

    fn next_identity(&self) -> u64 {
        self.inner
            .ordinal
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| {
                (id < MAX_JS_ID).then_some(id + 1)
            })
            .map(|id| id + 1)
            .unwrap_or(0)
    }

    /// Registers synchronously, before the host Promise can be cancelled. A
    /// duplicate never replaces an existing request's cancellation handle.
    pub fn request(
        &self,
        id: u64,
        body: String,
    ) -> BoxFuture<'static, Result<ReadResponse, TransportError>> {
        let registration = (|| {
            if id == 0 || id > MAX_JS_ID {
                return Err(TransportError::Identity);
            }
            if body.len() > MAX_REQUEST_BYTES {
                return Err(TransportError::TooLarge);
            }
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| TransportError::Unavailable)?;
            if state.closed {
                return Err(TransportError::Closed);
            }
            if state.pending.contains_key(&id) {
                return Err(TransportError::Identity);
            }
            if state.pending.len() >= MAX_PENDING {
                return Err(TransportError::Busy);
            }
            let (handle, registration) = AbortHandle::new_pair();
            state.pending.insert(id, handle.clone());
            Ok((handle, registration))
        })();
        let (handle, registration) = match registration {
            Ok(value) => value,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
        let guard = Pending {
            inner: Arc::clone(&self.inner),
            id,
        };
        let cancellation = CancelOnDrop(handle);
        let inner = Arc::clone(&self.inner);
        let task = self.inner.network_executor.spawn(async move {
            let _guard = guard;
            Abortable::new(
                async move {
                    let mut response = inner
                        .client
                        .post(inner.endpoint.clone())
                        .header(CONTENT_TYPE, "application/json")
                        .header(AUTHORIZATION, inner.authorization.clone())
                        .body(body)
                        .send()
                        .await
                        .map_err(|_| TransportError::Unavailable)?;
                    let status = response.status().as_u16();
                    if response
                        .content_length()
                        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
                    {
                        return Err(TransportError::TooLarge);
                    }
                    let mut bytes = Vec::new();
                    while let Some(chunk) = response
                        .chunk()
                        .await
                        .map_err(|_| TransportError::Unavailable)?
                    {
                        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
                            return Err(TransportError::TooLarge);
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    let body = String::from_utf8(bytes).map_err(|_| TransportError::Unavailable)?;
                    Ok(ReadResponse { status, body })
                },
                registration,
            )
            .await
            .map_err(|_| TransportError::Cancelled)?
        });
        Box::pin(async move {
            let _cancellation = cancellation;
            task.await.map_err(|_| TransportError::Unavailable)?
        })
    }

    pub fn cancel(&self, id: u64) -> bool {
        if let Ok(state) = self.inner.state.lock() {
            if let Some(handle) = state.pending.get(&id) {
                handle.abort();
                return true;
            }
        }
        false
    }
    pub fn close(&self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.closed = true;
            for handle in state.pending.values() {
                handle.abort();
            }
        }
    }
    pub fn pending_requests(&self) -> usize {
        self.inner
            .state
            .lock()
            .map(|state| state.pending.len())
            .unwrap_or(MAX_PENDING)
    }
}

struct CancelOnDrop(AbortHandle);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Pending {
    inner: Arc<Inner>,
    id: u64,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.pending.remove(&self.id);
        }
    }
}

/// Operator credentials are bounded files with no group/world access. Reading
/// is bounded independently of metadata so a changing file cannot bypass it.
pub fn read_credential(path: &Path) -> Result<String, TransportError> {
    use std::os::unix::fs::OpenOptionsExt;
    // Opening a FIFO must not block before metadata/type validation. Validate
    // the opened descriptor, so replacing the pathname cannot evade the check.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| TransportError::Configuration)?;
    let metadata = file.metadata().map_err(|_| TransportError::Configuration)?;
    if !metadata.is_file() {
        return Err(TransportError::Configuration);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(TransportError::Configuration);
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_TOKEN_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| TransportError::Configuration)?;
    if bytes.len() > MAX_TOKEN_BYTES {
        return Err(TransportError::Configuration);
    }
    let text = String::from_utf8(bytes).map_err(|_| TransportError::Configuration)?;
    let token = text.trim();
    if token.is_empty() || token.bytes().any(|b| !b.is_ascii_graphic()) {
        return Err(TransportError::Configuration);
    }
    Ok(token.to_owned())
}

pub fn install_read_transport(ctx: &Ctx<'_>, transport: ImageReadTransport) -> JsResult<()> {
    let identities = transport.clone();
    ctx.globals().set(
        "__nativeReadIdentity",
        Function::new(ctx.clone(), move || identities.next_identity())?,
    )?;
    let requests = transport.clone();
    ctx.globals().set(
        "__nativeReadRequest",
        Function::new(
            ctx.clone(),
            Async(move |id: u64, body: String| {
                let pending = requests.request(id, body);
                async move {
                    match pending.await {
                        Ok(response) => serde_json::to_string(&response)
                            .unwrap_or_else(|_| "{\"failed\":true}".into()),
                        Err(_) => "{\"failed\":true}".into(),
                    }
                }
            }),
        )?,
    )?;
    let cancellation = transport.clone();
    ctx.globals().set(
        "__nativeReadCancel",
        Function::new(ctx.clone(), move |id: u64| cancellation.cancel(id))?,
    )?;
    ctx.globals().set(
        "__nativeReadClose",
        Function::new(ctx.clone(), move || transport.close())?,
    )?;
    Ok(())
}
