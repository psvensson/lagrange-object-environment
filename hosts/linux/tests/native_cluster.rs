//! Dedicated real-cluster lane. No service/bootstrap process is launched here;
//! the Node parent supplies a separately owned real deployment and oracle.
use gtk4::prelude::*;
use lagrange_host_linux::{
    image_read_transport::{read_credential, ImageReadTransport},
    native_viewer::window::{Locator, Viewer},
};
use serde_json::Value;
use std::{
    io::Write,
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn widgets(root: &gtk4::Widget, out: &mut Vec<gtk4::Widget>) {
    out.push(root.clone());
    let mut child = root.first_child();
    while let Some(widget) = child {
        widgets(&widget, out);
        child = widget.next_sibling();
    }
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
fn buttons(root: &gtk4::Box) -> Vec<gtk4::Button> {
    let mut all = vec![];
    widgets(root.upcast_ref(), &mut all);
    all.into_iter().filter_map(|w| w.downcast().ok()).collect()
}
fn drive(app: &mut Viewer, mut until: impl FnMut(&Viewer) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        app.tick();
        while gtk4::glib::MainContext::default().iteration(false) {}
        if until(app) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "native cluster UI deadline: {}",
            app.status_text()
        );
        thread::sleep(Duration::from_millis(2));
    }
}
fn close(app: &mut Viewer) {
    app.request_close();
    drive(app, |v| v.stopped().is_some());
    app.join_stopped().unwrap();
    app.window().destroy();
}

#[test]
#[ignore = "requires the dedicated native-cluster process harness, never a mock fallback"]
fn real_cluster_native_navigation() {
    gtk4::init().unwrap();
    let oracle: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("OE_CLUSTER_ORACLE").unwrap()).unwrap(),
    )
    .unwrap();
    let endpoint = std::env::var("OE_CLUSTER_ENDPOINT").unwrap();
    let token =
        read_credential(Path::new(&std::env::var("OE_CLUSTER_CREDENTIAL").unwrap())).unwrap();
    let control = std::env::var("OE_CLUSTER_REVOKED").unwrap();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let transport = ImageReadTransport::new(
        &endpoint,
        &token,
        None,
        Duration::from_secs(10),
        rt.handle().clone(),
    )
    .unwrap();
    let locator = Locator {
        image_id: "native-cluster-demo".into(),
        project_id: "integration".into(),
        member_key: None,
    };
    let mut app = Viewer::new(locator.clone(), &endpoint, transport, rt.handle().clone()).unwrap();
    app.window().present();
    drive(&mut app, |v| v.ready() && v.window().is_mapped());
    assert!(text(&app.project_pane()).contains(oracle["descriptor"]["name"].as_str().unwrap()));
    assert!(
        buttons(&app.inspector_pane()).is_empty(),
        "startup does not prefetch members"
    );
    let members = oracle["descriptor"]["members"].as_array().unwrap();
    let root = members.iter().position(|m| m["key"] == "root").unwrap();
    let denied = members.iter().position(|m| m["key"] == "denied").unwrap();
    buttons(&app.project_pane())[root].emit_clicked();
    let root_title = oracle["root"]["slots"]["title"]["value"].as_str().unwrap();
    drive(&mut app, |v| {
        v.ready() && text(&v.inspector_pane()).contains(root_title)
    });
    buttons(&app.inspector_pane())[0].emit_clicked();
    let target_title = oracle["target"]["slots"]["title"]["value"]
        .as_str()
        .unwrap();
    drive(&mut app, |v| {
        v.ready() && text(&v.inspector_pane()).contains(target_title)
    });
    buttons(&app.project_pane())[denied].emit_clicked();
    drive(&mut app, |v| {
        v.ready() && text(&v.inspector_pane()).contains("Not authorized")
    });
    assert!(!text(&app.inspector_pane()).contains("Restricted"));
    // An independently supplied invalid token cannot open the actual Project.
    let invalid = ImageReadTransport::new(
        &endpoint,
        "invalid",
        None,
        Duration::from_secs(10),
        rt.handle().clone(),
    )
    .unwrap();
    let mut refused = Viewer::new(locator, &endpoint, invalid, rt.handle().clone()).unwrap();
    refused.window().present();
    drive(&mut refused, |v| !v.busy());
    assert!(!refused.ready());
    assert!(buttons(&refused.project_pane()).is_empty());
    close(&mut refused);
    // Revocation must replace a previously successful read. Starting from the
    // denied-member presentation would let a dropped activation pass vacuously.
    buttons(&app.project_pane())[root].emit_clicked();
    drive(&mut app, |v| {
        v.ready() && text(&v.inspector_pane()).contains(root_title)
    });
    println!("NATIVE_CLUSTER_REVOKE");
    std::io::stdout().flush().unwrap();
    drive(&mut app, |_| Path::new(&control).exists());
    buttons(&app.project_pane())[root].emit_clicked();
    drive(&mut app, |v| {
        v.ready()
            && v.pending_commands() == 0
            && text(&v.inspector_pane()).contains("Not authorized")
    });
    assert!(!text(&app.inspector_pane()).contains(root_title));
    app.enqueue_refresh();
    drive(&mut app, |v| !v.busy() && v.pending_commands() == 0);
    assert!(!app.ready());
    assert!(!app.project_pane().is_sensitive());
    close(&mut app);
    println!("NATIVE_CLUSTER_ACTIONS_PASSED");
}
