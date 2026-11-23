//! Standalone viewer entrypoint and process ceiling. No child process/Node bridge.
use super::window::{Locator, Viewer};
use crate::image_read_transport::{read_credential, ImageReadTransport};
use gtk4::prelude::*;
use std::{cell::RefCell, io::Read, path::PathBuf, rc::Rc, time::Duration};

pub const HELP: &str = "Usage: lagrange-host-linux view --endpoint ORIGIN --image ID --project ID --credential-file PATH [--ca-file PATH] [--member KEY]\n\nOpens a read-only Project and inspector. Select a member to read it; Refresh rereads current state. The credential file must be private (mode 600). Remote endpoints require verified HTTPS. Plain HTTP is limited to literal loopback. No cluster is provisioned by this executable.";
struct Options {
    endpoint: String,
    locator: Locator,
    credential: PathBuf,
    ca: Option<PathBuf>,
}
fn options(args: Vec<String>) -> Result<Options, &'static str> {
    let mut endpoint = None;
    let mut image = None;
    let mut project = None;
    let mut credential = None;
    let mut ca = None;
    let mut member = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let slot = match arg.as_str() {
            "--endpoint" => &mut endpoint,
            "--image" => &mut image,
            "--project" => &mut project,
            "--credential-file" => &mut credential,
            "--ca-file" => &mut ca,
            "--member" => &mut member,
            _ => return Err("Unknown viewer option. Use view --help."),
        };
        if slot.is_some() {
            return Err("Duplicate viewer option.");
        }
        let value = args.next().ok_or("Viewer option requires a value.")?;
        if value.is_empty() || value.len() > 4096 {
            return Err("Invalid viewer option value.");
        }
        *slot = Some(value);
    }
    Ok(Options {
        endpoint: endpoint.ok_or("Missing --endpoint.")?,
        locator: Locator {
            image_id: image.ok_or("Missing --image.")?,
            project_id: project.ok_or("Missing --project.")?,
            member_key: member,
        },
        credential: credential.ok_or("Missing --credential-file.")?.into(),
        ca: ca.map(PathBuf::from),
    })
}
fn read_ca(path: &std::path::Path) -> Result<Vec<u8>, &'static str> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "Cannot read CA file.")?;
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect CA file.")?
        .is_file()
    {
        return Err("CA file must be a regular file.");
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read CA file.")?;
    if bytes.len() > 1024 * 1024 {
        return Err("CA file exceeds size limit.");
    }
    Ok(bytes)
}
pub fn start_exit_ceiling() {
    // Deliberately survives completed GUI/actor cleanup: runtime destruction can
    // still wait on OS DNS. Normal process exit ends this thread; a live process
    // after the absolute ceiling is an explicit failure, never a clean shutdown.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(8));
        eprintln!("Native viewer shutdown exceeded its process deadline.");
        std::process::exit(1);
    });
}

pub fn run(args: Vec<String>, executor: tokio::runtime::Handle) -> anyhow::Result<()> {
    if args.len() == 1 && args[0] == "--help" {
        println!("{HELP}");
        return Ok(());
    }
    let options = options(args).map_err(anyhow::Error::msg)?;
    let token = read_credential(&options.credential)
        .map_err(|_| anyhow::anyhow!("Cannot load private viewer credential."))?;
    let ca = options
        .ca
        .as_deref()
        .map(read_ca)
        .transpose()
        .map_err(anyhow::Error::msg)?;
    let transport = ImageReadTransport::new(
        &options.endpoint,
        &token,
        ca.as_deref(),
        Duration::from_secs(10),
        executor.clone(),
    )
    .map_err(|_| anyhow::anyhow!("Invalid native transport configuration."))?;
    gtk4::init().map_err(|_| anyhow::anyhow!("Cannot open the native display."))?;
    let viewer = Rc::new(RefCell::new(
        Viewer::new(options.locator, &options.endpoint, transport, executor)
            .map_err(anyhow::Error::msg)?,
    ));
    let window = viewer.borrow().window();
    let refresh = viewer.borrow().refresh_button();
    let weak = Rc::downgrade(&viewer);
    refresh.connect_clicked(move |_| {
        if let Some(viewer) = weak.upgrade() {
            viewer.borrow_mut().enqueue_refresh();
        }
    });
    let weak = Rc::downgrade(&viewer);
    window.connect_close_request(move |_| {
        if let Some(viewer) = weak.upgrade() {
            viewer.borrow_mut().request_close();
        }
        gtk4::glib::Propagation::Stop
    });
    let mut signals = Vec::new();
    for signal in [libc::SIGINT, libc::SIGTERM] {
        let weak = Rc::downgrade(&viewer);
        signals.push(gtk4::glib::unix_signal_add_local(signal, move || {
            if let Some(viewer) = weak.upgrade() {
                viewer.borrow_mut().request_close();
            }
            gtk4::glib::ControlFlow::Continue
        }));
    }
    let main_loop = gtk4::glib::MainLoop::new(None, false);
    let stop_loop = main_loop.clone();
    let owner = viewer.clone();
    let mut ceiling_started = false;
    let mut ready_reported = false;
    gtk4::glib::timeout_add_local(Duration::from_millis(10), move || {
        let mut viewer = owner.borrow_mut();
        viewer.tick();
        if viewer.closing() && !ceiling_started {
            start_exit_ceiling();
            ceiling_started = true;
        }
        if viewer.ready() && viewer.window().is_mapped() && !ready_reported {
            println!("{{\"event\":\"native-viewer-ready\"}}");
            ready_reported = true;
        }
        if viewer.stopped().is_some() {
            if !ceiling_started {
                start_exit_ceiling();
            }
            stop_loop.quit();
            return gtk4::glib::ControlFlow::Break;
        }
        gtk4::glib::ControlFlow::Continue
    });
    window.present();
    main_loop.run();
    for signal in signals {
        signal.remove();
    }
    let result = viewer
        .borrow_mut()
        .join_stopped()
        .map_err(anyhow::Error::msg);
    window.destroy();
    result
}
