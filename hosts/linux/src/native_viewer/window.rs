//! GTK session owner. All waiting UI commands stay here; the worker receives
//! exactly one operation at a time and never touches GTK or semantic targets.
use crate::image_read_transport::{install_read_transport, ImageReadTransport};
use crate::js_env::{
    actor::{JsEnvActor, ShutdownOutcome},
    renderer_port::{install_renderer_adapter, RendererPortHost},
};
use crate::linux_adapter::{RealizedIntent, RendererAdapterOps};
use gtk4::prelude::*;
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::VecDeque, rc::Rc, sync::mpsc, thread, time::Duration};
use tokio::sync::{mpsc as async_mpsc, watch};

const QUEUE_LIMIT: usize = 32;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Locator {
    pub image_id: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_key: Option<String>,
}
#[derive(Clone, Deserialize)]
struct Handles {
    project: String,
    inspector: String,
}
enum Command {
    Refresh,
    Activate(RealizedIntent),
}
struct InputQueue {
    commands: VecDeque<Command>,
    closing: bool,
    intents_enabled: bool,
    dropped: usize,
}
impl InputQueue {
    fn push(&mut self, command: Command) -> bool {
        if self.closing || (matches!(&command, Command::Activate(_)) && !self.intents_enabled) {
            return false;
        }
        if self.commands.len() == QUEUE_LIMIT {
            self.dropped += 1;
            return false;
        }
        self.commands.push_back(command);
        true
    }
}
enum Event {
    Completed(Result<Handles, ()>),
    Stopped(bool),
}

pub struct Viewer {
    window: gtk4::Window,
    status: gtk4::Label,
    refresh: gtk4::Button,
    project: gtk4::Box,
    inspector: gtk4::Box,
    renderer: RendererPortHost,
    transport: ImageReadTransport,
    commands: async_mpsc::Sender<Command>,
    close: watch::Sender<bool>,
    events: mpsc::Receiver<Event>,
    worker: Option<thread::JoinHandle<()>>,
    queue: Rc<RefCell<InputQueue>>,
    handles: Option<Handles>,
    busy: bool,
    ready: bool,
    closing: bool,
    stopped: Option<bool>,
    discarded: usize,
}
impl Viewer {
    /// Must run on the GTK owner after gtk4::init. Network execution is supplied
    /// by the process root and is independent of the embedded guest's executor.
    pub fn new(
        locator: Locator,
        endpoint_label: &str,
        transport: ImageReadTransport,
        executor: tokio::runtime::Handle,
    ) -> Result<Self, String> {
        let window = gtk4::Window::builder()
            .title("Lagrange Environment")
            .default_width(1000)
            .default_height(700)
            .build();
        let body = gtk4::Box::new(gtk4::Orientation::Vertical, 12);
        body.set_margin_top(16);
        body.set_margin_bottom(16);
        body.set_margin_start(16);
        body.set_margin_end(16);
        let endpoint = gtk4::Label::new(Some(endpoint_label));
        endpoint.set_xalign(0.0);
        let status = gtk4::Label::new(Some("Connecting…"));
        status.set_xalign(0.0);
        let refresh = gtk4::Button::with_label("Refresh");
        let toolbar = gtk4::Box::new(gtk4::Orientation::Horizontal, 12);
        status.set_hexpand(true);
        toolbar.append(&status);
        toolbar.append(&refresh);
        let panes = gtk4::Paned::new(gtk4::Orientation::Horizontal);
        panes.set_position(340);
        panes.set_vexpand(true);
        let project = gtk4::Box::new(gtk4::Orientation::Vertical, 8);
        let inspector = gtk4::Box::new(gtk4::Orientation::Vertical, 8);
        let left = gtk4::ScrolledWindow::builder()
            .child(&project)
            .hexpand(true)
            .vexpand(true)
            .build();
        let right = gtk4::ScrolledWindow::builder()
            .child(&inspector)
            .hexpand(true)
            .vexpand(true)
            .build();
        panes.set_start_child(Some(&left));
        panes.set_end_child(Some(&right));
        body.append(&endpoint);
        body.append(&toolbar);
        body.append(&panes);
        window.set_child(Some(&body));
        let (mut renderer, renderer_tx) = RendererPortHost::new(Box::new(|_| {
            Err("GLB is unavailable in this viewer composition".into())
        }));
        let queue = Rc::new(RefCell::new(InputQueue {
            commands: VecDeque::new(),
            closing: false,
            intents_enabled: false,
            dropped: 0,
        }));
        let input = queue.clone();
        renderer.adapter().set_intent_sink(Rc::new(move |event| {
            input.borrow_mut().push(Command::Activate(event));
        }));
        let (commands, mut requests) = async_mpsc::channel(1);
        let (close, mut closing) = watch::channel(false);
        let (notify, events) = mpsc::channel();
        let network = transport.clone();
        let config = serde_json::to_string(&locator).map_err(|_| "Invalid viewer locator")?;
        let worker = thread::Builder::new().name("native-viewer-session".into()).spawn(move || {
            executor.block_on(async move {
                let actor = match super::loader().and_then(JsEnvActor::spawn) {
                    Ok(actor) => actor,
                    Err(_) => { let _ = notify.send(Event::Stopped(false)); return; }
                };
                let installed = actor.with_context(move |ctx| {
                    install_renderer_adapter(ctx, renderer_tx, "__viewerRenderer")?;
                    install_read_transport(ctx, network)
                }).await;
                if installed.is_err() {
                    let _ = actor.shutdown().await;
                    let _ = notify.send(Event::Stopped(false)); return;
                }
                let sender = actor.clone_sender();
                let open = format!(r#"(async () => {{
                  if (!globalThis.__nativeSession) {{
                    const {{openNativeViewer}} = await import('native/viewer-session');
                    globalThis.__nativeSession = await openNativeViewer({{...{config},rendererAdapter:__viewerRenderer}});
                  }} else {{ await __nativeSession.refresh(); }}
                  return __nativeSession.handles();
                }})()"#);
                let mut next = Some(open.clone());
                loop {
                    if *closing.borrow() { break; }
                    if let Some(source) = next.take() {
                        let operation = sender.eval_async(&source);
                        let result = tokio::select! {
                            biased;
                            _ = closing.changed() => break,
                            result = operation => result.ok().and_then(|text| serde_json::from_str(&text).ok()).ok_or(()),
                        };
                        if notify.send(Event::Completed(result)).is_err() { break; }
                    }
                    let command = tokio::select! {
                        biased;
                        _ = closing.changed() => break,
                        request = requests.recv() => match request { Some(command) => command, None => break },
                    };
                    next = Some(match command {
                        Command::Refresh => open.clone(),
                        Command::Activate(event) => format!("__nativeSession.activate({}, {})",
                            serde_json::to_string(&event.surface_handle).expect("string serialization"),
                            serde_json::to_string(&event.intent).expect("intent serialization")),
                    });
                }
                // Queue teardown before shutdown. GTK keeps pumping operations;
                // the actor's whole-drain deadline is recorded immediately.
                let teardown = sender.eval_async("(async () => { await globalThis.__nativeSession?.close(); return null; })()");
                let (teardown, outcome) = tokio::join!(teardown, actor.shutdown_within(Duration::from_secs(5)));
                let _ = notify.send(Event::Stopped(teardown.is_ok() && outcome == ShutdownOutcome::Clean));
            });
        }).map_err(|_| "Cannot start native viewer session")?;
        Ok(Self {
            window,
            status,
            refresh,
            project,
            inspector,
            renderer,
            transport,
            commands,
            close,
            events,
            worker: Some(worker),
            queue,
            handles: None,
            busy: true,
            ready: false,
            closing: false,
            stopped: None,
            discarded: 0,
        })
    }
    pub fn window(&self) -> gtk4::Window {
        self.window.clone()
    }
    pub fn refresh_button(&self) -> gtk4::Button {
        self.refresh.clone()
    }
    pub fn status_text(&self) -> String {
        self.status.text().to_string()
    }
    pub fn ready(&self) -> bool {
        self.ready && !self.busy && !self.closing
    }
    pub fn busy(&self) -> bool {
        self.busy
    }
    pub fn closing(&self) -> bool {
        self.closing
    }
    pub fn stopped(&self) -> Option<bool> {
        self.stopped
    }
    pub fn discarded_intents(&self) -> usize {
        self.discarded
    }
    pub fn project_pane(&self) -> gtk4::Box {
        self.project.clone()
    }
    pub fn inspector_pane(&self) -> gtk4::Box {
        self.inspector.clone()
    }
    pub fn surface_handles(&self) -> Option<(String, String)> {
        self.handles
            .as_ref()
            .map(|h| (h.project.clone(), h.inspector.clone()))
    }
    pub fn enqueue_refresh(&mut self) {
        if self.closing {
            return;
        }
        if !self.queue.borrow_mut().push(Command::Refresh) {
            self.status.set_text("Input queue full. Please wait.");
        }
    }
    pub fn pending_commands(&self) -> usize {
        self.queue.borrow().commands.len()
    }
    pub fn dropped_commands(&self) -> usize {
        self.queue.borrow().dropped
    }

    pub fn request_close(&mut self) {
        if self.closing {
            return;
        }
        self.closing = true;
        self.ready = false;
        {
            let mut input = self.queue.borrow_mut();
            input.closing = true;
            input.commands.clear();
        }
        self.transport.close(); // independent of JavaScript progress
        let _ = self.close.send(true);
        self.window.set_visible(false);
    }
    /// Called from one GLib callback. No recursive MainContext iteration and no
    /// blocking actor call occurs while the GTK owner holds this mutable borrow.
    pub fn tick(&mut self) {
        self.renderer.pump_ops(64);
        while let Ok(event) = self.events.try_recv() {
            match event {
                Event::Completed(result) => {
                    self.busy = false;
                    if self.closing {
                        continue;
                    }
                    match result {
                        Ok(handles) => {
                            let mounted = self
                                .renderer
                                .adapter()
                                .mount_gtk_surface(&handles.project, &self.project)
                                .and_then(|_| {
                                    self.renderer
                                        .adapter()
                                        .mount_gtk_surface(&handles.inspector, &self.inspector)
                                });
                            if mounted.is_err() {
                                self.request_close();
                                continue;
                            }
                            self.handles = Some(handles);
                            self.ready = true;
                            self.queue.borrow_mut().intents_enabled = true;
                            self.project.set_sensitive(true);
                            self.inspector.set_sensitive(true);
                            self.status.set_text("Connected · Read only");
                        }
                        Err(()) => {
                            self.ready = false;
                            {
                                let mut input = self.queue.borrow_mut();
                                input.commands.clear();
                                input.intents_enabled = false;
                            }
                            self.project.set_sensitive(false);
                            self.inspector.set_sensitive(false);
                            self.status.set_text(
                                "Read failed or access denied. Use Refresh to reconnect.",
                            );
                        }
                    }
                }
                Event::Stopped(clean) => {
                    self.stopped = Some(clean);
                    self.ready = false;
                    self.busy = false;
                    let _ = self.renderer.adapter().destroy_all();
                }
            }
        }
        if self.closing || self.busy || self.stopped.is_some() {
            return;
        }
        loop {
            let command = { self.queue.borrow_mut().commands.pop_front() };
            let Some(command) = command else {
                break;
            };
            if let Command::Activate(event) = &command {
                if !self.renderer.adapter().realization_is_current(event) {
                    self.discarded += 1;
                    continue;
                }
            }
            if self.commands.try_send(command).is_err() {
                self.request_close();
                return;
            }
            self.busy = true;
            self.status.set_text("Reading…");
            break;
        }
    }
    /// Only call after Stopped; no wait on GTK-dependent guest work remains.
    pub fn join_stopped(&mut self) -> Result<(), String> {
        if self.stopped.is_none() {
            return Err("Viewer has not stopped".into());
        }
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| "Viewer worker failed")?;
        }
        if self.stopped != Some(true) {
            return Err("Native viewer shutdown was incomplete".into());
        }
        Ok(())
    }
}
impl Drop for Viewer {
    fn drop(&mut self) {
        {
            let mut input = self.queue.borrow_mut();
            input.closing = true;
            input.commands.clear();
        }
        self.transport.close();
        let _ = self.close.send(true);
        let _ = self.renderer.adapter().destroy_all();
    }
}
