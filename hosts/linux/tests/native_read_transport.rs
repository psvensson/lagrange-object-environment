//! N1 mechanics only: scripted HTTP bytes do not claim Images/cluster semantics.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::Duration;

use lagrange_host_linux::image_read_transport::{
    install_read_transport, read_credential, ImageReadTransport, TransportError,
};
use lagrange_host_linux::js_env::actor::{JsEnvActor, ShutdownOutcome};
use lagrange_host_linux::native_viewer;
use serde_json::{json, Value};

const TOKEN: &str = "native-test-credential";
const CERT: &[u8] = include_bytes!("../../../test/fixtures/image-read-service/localhost-cert.pem");
const KEY: &[u8] = include_bytes!("../../../test/fixtures/image-read-service/localhost-key.pem");
trait Stream: Read + Write + Send {}
impl<T: Read + Write + Send> Stream for T {}
struct Server {
    origin: String,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(tls: bool, handler: impl FnMut(Box<dyn Stream>) + Send + 'static) -> Self {
        Self::at("127.0.0.1:0", tls, handler)
    }
    fn at(
        address: &str,
        tls: bool,
        mut handler: impl FnMut(Box<dyn Stream>) + Send + 'static,
    ) -> Self {
        let listener = TcpListener::bind(address).unwrap();
        let origin = format!(
            "{}://{}",
            if tls { "https" } else { "http" },
            listener.local_addr().unwrap()
        );
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let halt = stop.clone();
        let thread = thread::spawn(move || {
            let tls = tls.then(|| {
                native_tls::TlsAcceptor::new(native_tls::Identity::from_pkcs8(CERT, KEY).unwrap())
                    .unwrap()
            });
            while !halt.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        socket
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        socket
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        if let Some(tls) = &tls {
                            if let Ok(stream) = tls.accept(socket) {
                                handler(Box::new(stream));
                            }
                        } else {
                            handler(Box::new(socket));
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            origin,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let result = thread.join();
            if !std::thread::panicking() {
                result.expect("HTTP fixture failed");
            }
        }
    }
}
fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
fn transport(rt: &tokio::runtime::Runtime, server: &Server, trusted: bool) -> ImageReadTransport {
    ImageReadTransport::new(
        &server.origin,
        TOKEN,
        trusted.then_some(CERT),
        Duration::from_millis(600),
        rt.handle().clone(),
    )
    .unwrap()
}
fn request(stream: &mut dyn Stream) -> String {
    let mut bytes = Vec::new();
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 32 * 1024);
        stream.read_exact(&mut byte).unwrap();
        bytes.push(byte[0]);
    }
    let headers = String::from_utf8(bytes.clone()).unwrap();
    let length: usize = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .map(str::to_owned)
        })
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(length <= 16 * 1024);
    let start = bytes.len();
    bytes.resize(start + length, 0);
    stream.read_exact(&mut bytes[start..]).unwrap();
    String::from_utf8(bytes).unwrap()
}
fn respond(stream: &mut dyn Stream, status: u16, body: &str) {
    write!(
        stream,
        "HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    stream.flush().unwrap();
}

#[test]
fn fixed_origin_credentials_tls_and_redirect_refusal() {
    let rt = runtime();
    for origin in [
        "http://example.com",
        "http://localhost",
        "https://user:secret@example.com",
        "https://example.com/private",
        "https://example.com/?token=x",
        "https://example.com/#x",
        "file:///tmp/x",
    ] {
        assert!(
            ImageReadTransport::new(
                origin,
                TOKEN,
                None,
                Duration::from_secs(1),
                rt.handle().clone()
            )
            .is_err(),
            "{origin}"
        );
    }
    for token in ["", "line\nbreak", "space token"] {
        assert!(ImageReadTransport::new(
            "http://127.0.0.1:9",
            token,
            None,
            Duration::from_secs(1),
            rt.handle().clone()
        )
        .is_err());
    }
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::unbounded_channel();
    let server = Server::new(true, move |mut stream| {
        seen_tx.send(request(stream.as_mut())).unwrap();
        respond(stream.as_mut(), 403, "denied");
    });
    let trusted = transport(&rt, &server, true);
    let reply = rt.block_on(trusted.request(1, "{}".into())).unwrap();
    assert_eq!(reply.status, 403);
    assert_eq!(reply.body, "denied");
    let received = rt.block_on(seen_rx.recv()).unwrap();
    assert!(received.starts_with("POST /v1/read HTTP/1.1\r\n"));
    assert!(received
        .to_ascii_lowercase()
        .contains(&format!("authorization: bearer {TOKEN}")));
    assert_eq!(
        rt.block_on(transport(&rt, &server, false).request(1, "{}".into()))
            .unwrap_err(),
        TransportError::Unavailable,
        "no implicit trust of self-signed certificate"
    );
    trusted.close();

    // Same trusted certificate, but an IP absent from its SANs. CA trust must
    // not disable endpoint identity checks.
    let wrong_host = Server::at("127.0.0.2:0", true, |_stream| {
        panic!("hostname mismatch reached HTTP")
    });
    assert_eq!(
        rt.block_on(transport(&rt, &wrong_host, true).request(1, "{}".into()))
            .unwrap_err(),
        TransportError::Unavailable
    );

    let target_hit = Arc::new(AtomicBool::new(false));
    let hit = target_hit.clone();
    let target = Server::new(false, move |_stream| {
        hit.store(true, Ordering::SeqCst);
    });
    let location = target.origin.clone();
    let redirect = Server::new(false, move |mut stream| {
        request(stream.as_mut());
        write!(stream, "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}/v1/read\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let client = transport(&rt, &redirect, false);
    assert_eq!(
        rt.block_on(client.request(1, "{}".into())).unwrap().status,
        307
    );
    assert!(
        !target_hit.load(Ordering::SeqCst),
        "credentials must never be forwarded to a redirect target"
    );
    client.close();
}

#[test]
fn bounded_body_deadline_capacity_cancellation_and_late_delivery() {
    let rt = runtime();
    let oversized = Server::new(false, |mut stream| {
        request(stream.as_mut());
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 4194305\r\n\r\n").unwrap();
    });
    let client = transport(&rt, &oversized, false);
    assert_eq!(
        rt.block_on(client.request(1, "{}".into())).unwrap_err(),
        TransportError::TooLarge
    );
    assert_eq!(
        rt.block_on(client.request(2, "x".repeat(16 * 1024 + 1)))
            .unwrap_err(),
        TransportError::TooLarge
    );
    client.close();

    let streamed = Server::new(false, |mut stream| {
        request(stream.as_mut());
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..65 {
            if write!(stream, "10000\r\n")
                .and_then(|_| stream.write_all(&chunk))
                .and_then(|_| stream.write_all(b"\r\n"))
                .is_err()
            {
                break;
            }
        }
    });
    let client = transport(&rt, &streamed, false);
    assert_eq!(
        rt.block_on(client.request(1, "{}".into())).unwrap_err(),
        TransportError::TooLarge,
        "streaming byte cap does not depend on Content-Length"
    );
    client.close();

    for reply in [
        b"not HTTP\r\n\r\n".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\n\xff",
    ] {
        let server = Server::new(false, move |mut stream| {
            request(stream.as_mut());
            stream.write_all(reply).unwrap();
        });
        let client = transport(&rt, &server, false);
        assert_eq!(
            rt.block_on(client.request(1, "{}".into())).unwrap_err(),
            TransportError::Unavailable
        );
        client.close();
    }

    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered_tx);
    let mut closed = Some(closed_tx);
    let stalled = Server::new(false, move |mut stream| {
        request(stream.as_mut());
        if let Some(tx) = entered.take() {
            let _ = tx.send(());
        }
        let mut byte = [0];
        let eof = matches!(stream.read(&mut byte), Ok(0));
        if let Some(tx) = closed.take() {
            let _ = tx.send(eof);
        }
    });
    let client = transport(&rt, &stalled, false);
    rt.block_on(async {
        let pending = tokio::spawn(client.request(1, "{}".into()));
        entered_rx.await.unwrap();
        assert!(client.cancel(1));
        assert_eq!(
            pending.await.unwrap().unwrap_err(),
            TransportError::Cancelled
        );
        assert!(
            closed_rx.await.unwrap(),
            "cancelled HTTP request releases its socket"
        );
    });
    assert_eq!(client.pending_requests(), 0);
    assert!(!client.cancel(999));
    let pending = client.request(1, "{}".into());
    assert_eq!(
        rt.block_on(client.request(1, "{}".into())).unwrap_err(),
        TransportError::Identity
    );
    assert_eq!(
        client.pending_requests(),
        1,
        "duplicate never replaces the first request"
    );
    drop(pending);
    assert_eq!(
        client.pending_requests(),
        1,
        "drop signals cancellation; capacity stays until I/O settles"
    );
    rt.block_on(async { tokio::task::yield_now().await });
    assert_eq!(client.pending_requests(), 0);
    let held: Vec<_> = (1..=16).map(|id| client.request(id, "{}".into())).collect();
    assert_eq!(
        rt.block_on(client.request(17, "{}".into())).unwrap_err(),
        TransportError::Busy
    );
    client.close();
    assert_eq!(
        client.pending_requests(),
        16,
        "close retains obligations until actual settlement/drop"
    );
    for future in held {
        assert_eq!(rt.block_on(future).unwrap_err(), TransportError::Cancelled);
    }
    assert_eq!(client.pending_requests(), 0);
    assert_eq!(
        rt.block_on(client.request(20, "{}".into())).unwrap_err(),
        TransportError::Closed
    );

    let stalled = Server::new(false, |mut stream| {
        request(stream.as_mut());
        let mut byte = [0];
        let _ = stream.read(&mut byte);
    });
    let client = transport(&rt, &stalled, false);
    let start = std::time::Instant::now();
    assert_eq!(
        rt.block_on(client.request(1, "{}".into())).unwrap_err(),
        TransportError::Unavailable
    );
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "whole response deadline"
    );
    client.close();
}

#[test]
fn real_quickjs_connection_uses_native_transport_and_immediate_abort() {
    let rt = runtime();
    let mut first = true;
    let server = Server::new(false, move |mut stream| {
        if !first {
            // Immediate abort may race the OS connect/send. A partial request
            // is legitimate; even a late response must not reach the guest.
            let mut bytes = [0; 1024];
            let _ = stream.read(&mut bytes);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nlate");
            return;
        }
        first = false;
        let input = request(stream.as_mut());
        let body: Value = serde_json::from_str(input.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"protocol":"environment-image-read/v1", "operation":"project", "imageId":"i", "projectId":"p"})
        );
        respond(stream.as_mut(), 200, &json!({"protocol":"environment-image-read/v1", "ok":true,
            "result":{"descriptor":{"projectId":"p","name":"Remote Project","members":[]},"versionToken":"opaque"}}).to_string());
    });
    let client = transport(&rt, &server, false);
    let actor = JsEnvActor::spawn(native_viewer::loader().unwrap()).unwrap();
    let port = client.clone();
    rt.block_on(actor.with_context(move |ctx| install_read_transport(&ctx, port)))
        .unwrap();
    let result = rt
        .block_on(actor.eval_async(
            r#"
(async () => {
  const {createNativeReadRequest} = await import('native/read-transport');
  const {createImageReadConnection} = await import('image-read-connection');
  const {createRemoteImageClientAdapter} = await import('image-client-adapter');
  const request = createNativeReadRequest();
  const connection = createImageReadConnection({request});
  const adapter = createRemoteImageClientAdapter({connection});
  const read = await adapter.readProject({imageId:'i', projectId:'p'});
  const controller = new AbortController();
  const cancelled = request({ignored:'immediate cancellation'}, {signal:controller.signal});
  controller.abort(new Error('cancelled'));
  let abort;
  try { await cancelled; abort = 'delivered'; } catch (error) { abort = error.message; }
  const privateImports = [];
  for (const path of ['src/value/scalars.js', './src/value/scalars.js.js', '././src/value/scalars.js.js']) {
    try { await import(path); privateImports.push(path); } catch {}
  }
  const api = await import('portable-runtime');
  connection.close();
  __nativeReadClose();
  return {read, abort, privateImports, helper:typeof api.referencesOfValue,
    node:typeof process, credential:typeof __nativeToken, hostFunction:String(__nativeReadRequest)};
})().catch(error => ({failure:{name:error.name,message:error.message,stack:error.stack}}))
"#,
        ))
        .unwrap();
    let result: Value = serde_json::from_str(&result).unwrap();
    assert!(result.get("failure").is_none(), "guest failure: {result}");
    assert_eq!(result["read"]["descriptor"]["name"], "Remote Project");
    assert_eq!(result["abort"], "cancelled");
    assert_eq!(result["helper"], "function");
    assert_eq!(result["privateImports"], json!([]));
    assert_eq!(result["node"], "undefined");
    assert_eq!(result["credential"], "undefined");
    assert!(!result.to_string().contains(TOKEN));
    assert_eq!(client.pending_requests(), 0);
    assert_eq!(rt.block_on(actor.shutdown()), ShutdownOutcome::Clean);
}

#[test]
fn quickjs_connection_preserves_timeout_and_close_reasons() {
    let rt = runtime();
    let (entered_tx, entered_rx) = tokio::sync::mpsc::unbounded_channel();
    let (closed_tx, mut closed_rx) = tokio::sync::mpsc::unbounded_channel();
    let server = Server::new(false, move |mut stream| {
        request(stream.as_mut());
        entered_tx.send(()).unwrap();
        let mut byte = [0];
        let eof = matches!(stream.read(&mut byte), Ok(0));
        closed_tx.send(eof).unwrap();
    });
    let client = transport(&rt, &server, false);
    let actor = JsEnvActor::spawn(native_viewer::loader().unwrap()).unwrap();
    let port = client.clone();
    let entered = Arc::new(tokio::sync::Mutex::new(entered_rx));
    rt.block_on(actor.with_context(move |ctx| {
        install_read_transport(ctx, port)?;
        ctx.globals().set(
            "__waitReadEntered",
            rquickjs::Function::new(
                ctx.clone(),
                rquickjs::function::Async(move || {
                    let entered = entered.clone();
                    async move { entered.lock().await.recv().await.is_some() }
                }),
            )?,
        )
    }))
    .unwrap();
    let report = rt.block_on(actor.eval_async(r#"(async () => {
      const {createNativeReadRequest} = await import('native/read-transport');
      const {createImageReadConnection} = await import('image-read-connection');
      const codes = [];
      for (const phase of ['timeout', 'close']) {
        const connection = createImageReadConnection({request:createNativeReadRequest(), timeoutMs:100});
        const pending = connection.readProject({imageId:'i',projectId:'p'});
        pending.catch(() => {});
        if (!await __waitReadEntered()) throw new Error('read never admitted');
        if (phase === 'close') connection.close();
        try { await pending; codes.push('delivered'); } catch(error) { codes.push(error.code); }
        connection.close();
      }
      return codes;
    })()"#)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&report).unwrap(),
        json!(["IMAGE_READ_TIMEOUT", "IMAGE_READ_CLOSED"])
    );
    rt.block_on(async {
        for _ in 0..2 {
            assert!(
                tokio::time::timeout(Duration::from_millis(500), closed_rx.recv())
                    .await
                    .unwrap()
                    .unwrap()
            );
        }
    });
    assert_eq!(client.pending_requests(), 0);
    client.close();
    assert_eq!(rt.block_on(actor.shutdown()), ShutdownOutcome::Clean);
}

#[test]
fn network_shutdown_does_not_wait_for_a_blocked_guest() {
    let rt = runtime();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered_tx);
    let mut closed = Some(closed_tx);
    let server = Server::new(false, move |mut stream| {
        request(stream.as_mut());
        entered.take().unwrap().send(()).unwrap();
        let mut byte = [0];
        let eof = matches!(stream.read(&mut byte), Ok(0));
        let _ = closed.take().unwrap().send(eof);
    });
    let client = ImageReadTransport::new(
        &server.origin,
        TOKEN,
        None,
        Duration::from_secs(5),
        rt.handle().clone(),
    )
    .unwrap();
    let actor = JsEnvActor::spawn(native_viewer::loader().unwrap()).unwrap();
    let port = client.clone();
    rt.block_on(actor.with_context(move |ctx| install_read_transport(&ctx, port)))
        .unwrap();
    rt.block_on(actor.eval_async(
        r#"(async () => {
      const {createNativeReadRequest} = await import('native/read-transport');
      globalThis.pendingRead = createNativeReadRequest()({}, {signal:new AbortController().signal})
        .then(() => 'delivered', error => error.message);
      return 'started';
    })()"#,
    ))
    .unwrap();
    rt.block_on(entered_rx).unwrap();
    let (blocked_tx, blocked_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let sender = actor.clone_sender();
    rt.block_on(async {
        let blocked = tokio::spawn(async move {
            sender
                .with_context(move |_| {
                    blocked_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(Duration::from_secs(2));
                    Ok(())
                })
                .await
        });
        blocked_rx.await.unwrap();
        client.close();
        let released = tokio::time::timeout(Duration::from_millis(500), closed_rx).await;
        let pending = client.pending_requests();
        let _ = release_tx.send(());
        blocked.await.unwrap().unwrap();
        assert!(
            released.unwrap().unwrap(),
            "socket closed before guest resumes or five-second I/O deadline"
        );
        assert_eq!(
            pending, 0,
            "network obligations settle independently of guest progress"
        );
    });
    assert_eq!(
        rt.block_on(actor.eval_async("globalThis.pendingRead"))
            .unwrap(),
        "\"Native image transport failed.\""
    );
    assert_eq!(rt.block_on(actor.shutdown()), ShutdownOutcome::Clean);
}

#[test]
fn completed_request_drop_cannot_cancel_a_reused_identity() {
    let rt = runtime();
    let server = Server::new(false, |mut stream| {
        request(stream.as_mut());
        respond(stream.as_mut(), 200, "response");
    });
    let client = transport(&rt, &server, false);
    let first = client.request(1, "{}".into());
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(1), async {
            while client.pending_requests() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    });
    let second = client.request(1, "{}".into());
    drop(first);
    assert_eq!(rt.block_on(second).unwrap().body, "response");
    client.close();
}

#[test]
fn credential_file_is_bounded_and_private() {
    use std::os::unix::fs::PermissionsExt;
    let path =
        std::env::temp_dir().join(format!("native-viewer-credential-{}", std::process::id()));
    std::fs::write(&path, TOKEN).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(read_credential(&path).unwrap(), TOKEN);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        read_credential(&path).unwrap_err(),
        TransportError::Configuration
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&path, vec![b'x'; 4097]).unwrap();
    assert_eq!(
        read_credential(&path).unwrap_err(),
        TransportError::Configuration
    );
    std::fs::remove_file(&path).unwrap();
    let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    // Owned temporary FIFO; nonblocking open must refuse before any writer exists.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let (tx, rx) = std::sync::mpsc::channel();
    let input = path.clone();
    let reader = thread::spawn(move || {
        let _ = tx.send(read_credential(&input));
    });
    let result = rx.recv_timeout(Duration::from_millis(500));
    if result.is_err() {
        use std::os::unix::fs::OpenOptionsExt;
        // Release a competing blocking-open implementation before failing.
        let writer = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path)
            .unwrap();
        let _ = rx.recv_timeout(Duration::from_secs(1));
        drop(writer);
    }
    reader.join().unwrap();
    assert_eq!(result.unwrap().unwrap_err(), TransportError::Configuration);
    std::fs::remove_file(path).unwrap();
}
