//! Real GTK and actual binary against scripted HTTP. This proves native
//! mechanics/assembly, not Images authorization or a live cluster (N3).
use gtk4::prelude::*;
use lagrange_host_linux::{
    image_read_transport::ImageReadTransport,
    native_viewer::window::{Locator, Viewer},
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
const TOKEN: &str = "native-viewer-test-only";
struct Hold {
    operation: String,
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
}
struct Data {
    name: String,
    child: String,
    deny: bool,
    empty: bool,
    reads: Vec<String>,
    hold: Option<Hold>,
}
struct Fixture {
    origin: String,
    data: Arc<Mutex<Data>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Fixture {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let data = Arc::new(Mutex::new(Data {
            name: "Native Project".into(),
            child: "b".into(),
            deny: false,
            empty: false,
            reads: vec![],
            hold: None,
        }));
        let state = data.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let halt = stop.clone();
        let worker = thread::spawn(move || {
            while !halt.load(Ordering::SeqCst) {
                let mut stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let Some(body) = read(&mut stream) else {
                    continue;
                };
                let operation = body["operation"].as_str().unwrap().to_string();
                let hold = {
                    let mut state = state.lock().unwrap();
                    state.reads.push(if operation == "project" {
                        "project".into()
                    } else {
                        body["objectId"].as_str().unwrap().into()
                    });
                    if state
                        .hold
                        .as_ref()
                        .is_some_and(|h| h.operation == operation)
                    {
                        state.hold.take()
                    } else {
                        None
                    }
                };
                if let Some(hold) = hold {
                    let _ = hold.entered.send(());
                    let _ = hold.release.recv_timeout(Duration::from_secs(3));
                }
                let state = state.lock().unwrap();
                let object = body["objectId"].as_str().unwrap_or("");
                let denied = state.deny || object == "denied";
                let result = if operation == "project" {
                    json!({"descriptor":{"projectId":"p","name":state.name,"members":if state.empty {vec![]} else {vec![json!({"key":"root","role":"application-root","target":{"kind":"ref","imageId":"i","objectId":"root"}}),json!({"key":"denied","role":"object","target":{"kind":"ref","imageId":"i","objectId":"denied"}})]}},"versionToken":"opaque-project"})
                } else {
                    json!({"slots":if object=="root" {json!({"title":{"kind":"text","value":"Root record"},"child":{"kind":"ref","imageId":"i","objectId":state.child}})} else {json!({"title":{"kind":"text","value":format!("Record {object}")}})},"indexed":[],"versionToken":"opaque-object"})
                };
                let body = if denied {
                    json!({"protocol":"environment-image-read/v1","ok":false,"error":"DENIED"})
                } else {
                    json!({"protocol":"environment-image-read/v1","ok":true,"result":result})
                }
                .to_string();
                let status = if denied { 403 } else { 200 };
                let _=write!(stream,"HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            }
        });
        Self {
            origin,
            data,
            stop,
            worker: Some(worker),
        }
    }
    fn hold(&self, operation: &str) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered, rx) = mpsc::channel();
        let (tx, release) = mpsc::channel();
        self.data.lock().unwrap().hold = Some(Hold {
            operation: operation.into(),
            entered,
            release,
        });
        (rx, tx)
    }
    fn reads(&self) -> Vec<String> {
        self.data.lock().unwrap().reads.clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}
fn read(stream: &mut TcpStream) -> Option<Value> {
    let mut bytes = vec![];
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        if stream.read_exact(&mut byte).is_err() {
            return None;
        }
        bytes.push(byte[0]);
        assert!(bytes.len() < 16384);
    }
    let headers = String::from_utf8(bytes).unwrap();
    assert!(headers.starts_with("POST /v1/read HTTP/1.1"));
    assert!(headers
        .to_lowercase()
        .contains(&format!("authorization: bearer {TOKEN}")));
    let length: usize = headers
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length: ")
                .map(str::to_owned)
        })
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(length < 16384);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).ok()?;
    Some(serde_json::from_slice(&body).unwrap())
}
fn locator() -> Locator {
    Locator {
        image_id: "i".into(),
        project_id: "p".into(),
        member_key: None,
    }
}
fn viewer(rt: &tokio::runtime::Runtime, fixture: &Fixture, locator: Locator) -> Viewer {
    let transport = ImageReadTransport::new(
        &fixture.origin,
        TOKEN,
        None,
        Duration::from_secs(2),
        rt.handle().clone(),
    )
    .unwrap();
    Viewer::new(locator, &fixture.origin, transport, rt.handle().clone()).unwrap()
}
fn drive(viewer: &mut Viewer, mut until: impl FnMut(&Viewer) -> bool) {
    let limit = Instant::now() + Duration::from_secs(6);
    loop {
        viewer.tick();
        while gtk4::glib::MainContext::default().iteration(false) {}
        if until(viewer) {
            return;
        }
        assert!(
            Instant::now() < limit,
            "viewer deadline: {}",
            viewer.status_text()
        );
        thread::sleep(Duration::from_millis(2));
    }
}
fn widgets(root: &gtk4::Widget, out: &mut Vec<gtk4::Widget>) {
    out.push(root.clone());
    let mut child = root.first_child();
    while let Some(widget) = child {
        widgets(&widget, out);
        child = widget.next_sibling();
    }
}
fn buttons(root: &gtk4::Box) -> Vec<gtk4::Button> {
    let mut all = vec![];
    widgets(root.upcast_ref(), &mut all);
    all.into_iter().filter_map(|w| w.downcast().ok()).collect()
}
fn text(root: &gtk4::Box) -> String {
    let mut all = vec![];
    widgets(root.upcast_ref(), &mut all);
    all.into_iter()
        .filter_map(|w| {
            w.downcast::<gtk4::Label>()
                .ok()
                .map(|l| l.text().to_string())
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn close(viewer: &mut Viewer) {
    viewer.request_close();
    drive(viewer, |v| v.stopped().is_some());
    viewer.join_stopped().unwrap();
    viewer.window().destroy();
}

#[test]
fn real_gtk_viewer_and_existing_binary() {
    gtk4::init().unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let fixture = Fixture::new();
    let mut app = viewer(&rt, &fixture, locator());
    app.window().present();
    drive(&mut app, |v| v.ready() && v.window().is_mapped());
    assert!(text(&app.project_pane()).contains("Native Project"));
    assert_eq!(fixture.reads(), ["project"]);
    assert!(
        buttons(&app.inspector_pane()).is_empty(),
        "canonical empty inspector, no prefetch"
    );
    buttons(&app.project_pane())[0].emit_clicked();
    drive(&mut app, |v| {
        text(&v.inspector_pane()).contains("Root record") && v.ready()
    });
    assert_eq!(fixture.reads(), ["project", "root"]);
    // Two panes emit before a pump: their arrival order must be preserved.
    buttons(&app.inspector_pane())[0].emit_clicked();
    buttons(&app.project_pane())[0].emit_clicked();
    assert_eq!(app.pending_commands(), 2);
    drive(&mut app, |v| {
        v.ready() && v.pending_commands() == 0 && text(&v.inspector_pane()).contains("Root record")
    });
    assert_eq!(fixture.reads(), ["project", "root", "b", "root"]);
    let old_button = buttons(&app.inspector_pane())[0].clone();
    let before = app.surface_handles().unwrap();
    let (entered, release) = fixture.hold("project");
    app.enqueue_refresh();
    drive(&mut app, |_| entered.try_recv().is_ok());
    old_button.emit_clicked();
    app.tick(); // queue the old epoch while refresh is held
    fixture.data.lock().unwrap().child = "c".into();
    release.send(()).unwrap();
    drive(&mut app, |v| v.ready() && v.pending_commands() == 0);
    assert_eq!(app.discarded_intents(), 1, "old epoch is rejected before target routing");
    assert_eq!(
        app.surface_handles().unwrap(),
        before,
        "refresh reuses surfaces"
    );
    assert_eq!(
        fixture.reads(),
        ["project", "root", "b", "root", "project", "root"],
        "old event cannot read new target under reused key"
    );
    old_button.emit_clicked();
    assert_eq!(
        app.pending_commands(),
        0,
        "detached button cannot enqueue into live session"
    );
    app.tick();
    assert_eq!(
        fixture.reads(),
        ["project", "root", "b", "root", "project", "root"],
        "destroyed widget queue is detached"
    );
    buttons(&app.inspector_pane())[0].emit_clicked();
    drive(&mut app, |v| {
        text(&v.inspector_pane()).contains("Record c") && v.ready()
    });
    buttons(&app.project_pane())[1].emit_clicked();
    drive(&mut app, |v| {
        text(&v.inspector_pane())
            .to_lowercase()
            .contains("not authorized")
            && v.ready()
    });
    fixture.data.lock().unwrap().deny = true;
    app.enqueue_refresh();
    drive(&mut app, |v| {
        !v.busy() && v.status_text().contains("Read failed")
    });
    assert!(!app.ready());
    fixture.data.lock().unwrap().deny = false;
    fixture.data.lock().unwrap().name = "Fresh Project".into();
    app.enqueue_refresh();
    drive(&mut app, |v| {
        v.ready() && text(&v.project_pane()).contains("Fresh Project")
    });
    let (entered, release) = fixture.hold("project");
    app.enqueue_refresh();
    drive(&mut app, |_| entered.try_recv().is_ok());
    let queued_button = buttons(&app.project_pane())[0].clone();
    for _ in 0..100 {
        queued_button.emit_clicked();
    }
    assert_eq!(app.pending_commands(), 32);
    assert_eq!(app.dropped_commands(), 68);
    app.request_close();
    queued_button.emit_clicked();
    assert_eq!(
        app.pending_commands(),
        0,
        "close disables admission and clears queued work"
    );
    drive(&mut app, |v| v.stopped().is_some());
    release.send(()).unwrap();
    app.join_stopped().unwrap();
    assert!(app.project_pane().first_child().is_none());
    assert!(app.inspector_pane().first_child().is_none());
    app.window().destroy();

    fixture.data.lock().unwrap().empty = true;
    let mut empty = viewer(&rt, &fixture, locator());
    empty.window().present();
    drive(&mut empty, |v| v.ready());
    assert!(buttons(&empty.project_pane()).is_empty());
    close(&mut empty);
    fixture.data.lock().unwrap().empty = false;
    let mut requested = locator();
    requested.member_key = Some("root".into());
    let mut selected = viewer(&rt, &fixture, requested);
    selected.window().present();
    drive(&mut selected, |v| v.ready());
    assert!(text(&selected.inspector_pane()).contains("Root record"));
    close(&mut selected);
    fixture.data.lock().unwrap().deny = true;
    let mut denied = viewer(&rt, &fixture, locator());
    denied.window().present();
    drive(&mut denied, |v| !v.busy());
    assert!(denied.status_text().contains("Read failed"));
    close(&mut denied);
    fixture.data.lock().unwrap().deny = false;
    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let unreachable = format!("http://{}", probe.local_addr().unwrap());
    drop(probe);
    let transport = ImageReadTransport::new(
        &unreachable,
        TOKEN,
        None,
        Duration::from_secs(1),
        rt.handle().clone(),
    )
    .unwrap();
    let mut offline = Viewer::new(locator(), &unreachable, transport, rt.handle().clone()).unwrap();
    offline.window().present();
    drive(&mut offline, |v| !v.busy() && v.window().is_mapped());
    assert!(offline.status_text().contains("Read failed"));
    close(&mut offline);
    binary(&fixture);
}
fn binary(fixture: &Fixture) {
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    let executable = env!("CARGO_BIN_EXE_lagrange-host-linux");
    let help = Command::new(executable)
        .args(["view", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8(help.stdout)
        .unwrap()
        .contains("--credential-file"));
    let invalid = Command::new(executable)
        .args(["view", "--endpoint"])
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    let credential = std::env::temp_dir().join(format!("native-viewer-cli-{}", std::process::id()));
    std::fs::write(&credential, TOKEN).unwrap();
    std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut child = ChildGuard(
        Command::new(executable)
            .args([
                "view",
                "--endpoint",
                &fixture.origin,
                "--image",
                "i",
                "--project",
                "p",
                "--credential-file",
            ])
            .arg(&credential)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let (tx, rx) = mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    let output = thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let _ = tx.send(line.unwrap());
        }
    });
    let ready = rx.recv_timeout(Duration::from_secs(6));
    if ready.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    assert_eq!(
        ready.unwrap(),
        "{\"event\":\"native-viewer-ready\"}",
        "actual binary signals only after Project read and mapped GTK window"
    );
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
    let limit = Instant::now() + Duration::from_secs(9);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > limit {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("native binary failed to stop")
        }
        thread::sleep(Duration::from_millis(5));
    };
    output.join().unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(status.success(), "native exit {status}: {stderr}");
    assert!(!stderr.contains(TOKEN));
    std::fs::remove_file(credential).unwrap();
}

struct ChildGuard(std::process::Child);
impl std::ops::Deref for ChildGuard {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for ChildGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn retained_runtime_ceiling_child() {
    if std::env::var_os("OE_RETAIN_RUNTIME_TEST").is_none() {
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let (tx, rx) = mpsc::channel();
    runtime.spawn_blocking(move || {
        tx.send(()).unwrap();
        loop {
            thread::park();
        }
    });
    rx.recv().unwrap();
    // Model retained OS resolver work after ordinary viewer cleanup. The exact
    // production ceiling must still terminate this stuck Runtime destruction.
    lagrange_host_linux::native_viewer::cli::start_exit_ceiling();
    drop(runtime);
    panic!("retained blocking worker unexpectedly disappeared");
}

#[test]
fn process_ceiling_survives_retained_runtime_shutdown() {
    let mut child = ChildGuard(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "retained_runtime_ceiling_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("OE_RETAIN_RUNTIME_TEST", "1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let limit = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < limit, "process ceiling failed");
        thread::sleep(Duration::from_millis(10));
    };
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(
        stderr.contains("Native viewer shutdown exceeded its process deadline."),
        "{stderr}"
    );
}
