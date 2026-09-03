//! Manual native-host driver (L1 spike). Runs one Component instance on
//! box.glb offscreen, prints the pinned Component hash + frame stats + mesh
//! pixel count, and asserts the frame is non-blank. Usage:
//!
//!   cargo run --release --locked [-- --asset box|box-big --frames N --width W --height H --dump-ppm PATH]
//!
//! (`rust-toolchain.toml` selects the pinned compiler; do not bypass it with
//! `rustup run stable`, and keep `--locked` so Cargo.lock is never rewritten.)

use std::collections::HashMap;

use lagrange_host_linux::{box_big_glb_bytes, box_glb_bytes, component_hash, mesh_pixels, GlbHost};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    env_logger::init();

    let mut asset = "box".to_string();
    let mut frames = 5usize;
    let mut width = 320u32;
    let mut height = 200u32;
    let mut dump_ppm: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--asset" => asset = args.next().expect("--asset value"),
            "--frames" => frames = args.next().expect("--frames value").parse()?,
            "--width" => width = args.next().expect("--width value").parse()?,
            "--height" => height = args.next().expect("--height value").parse()?,
            "--dump-ppm" => dump_ppm = Some(args.next().expect("--dump-ppm value")),
            other => anyhow::bail!("unknown arg {other}"),
        }
    }

    let glb = match asset.as_str() {
        "box" => box_glb_bytes(),
        "box-big" => box_big_glb_bytes(),
        other => anyhow::bail!("unknown asset {other} (box|box-big)"),
    };

    let hash = component_hash();
    println!("component sha256: {hash}");
    assert_eq!(
        hash, "c64b061cf1fcccb5a0adb80495acf2269ab572aed7758ecaa5b97e4eefea0811",
        "the native host must run the EXACT browser-tested Component binary"
    );

    let host = GlbHost::new();
    let mut allowlist = HashMap::new();
    allowlist.insert("main-model".to_string(), glb);
    let run = host
        .run_instance(allowlist, width, height, frames)
        .await?;

    println!(
        "captured {} frame(s) at {}x{} (bytes_per_row {})",
        run.captured_frames.len(),
        run.width,
        run.height,
        run.bytes_per_row
    );
    let frame = run
        .captured_frames
        .last()
        .expect("the Component should present at least one frame");
    let mesh = mesh_pixels(frame, run.width, run.height, run.bytes_per_row);
    let total = (run.width * run.height) as usize;
    println!("mesh pixels: {mesh}/{total} ({:.3})", mesh as f64 / total as f64);

    if let Some(path) = dump_ppm {
        // PPM is RGB; the frame is BGRA — swap and drop alpha + row padding.
        let mut ppm = format!("P6\n{} {}\n255\n", run.width, run.height).into_bytes();
        for y in 0..run.height as usize {
            for x in 0..run.width as usize {
                let i = y * run.bytes_per_row as usize + x * 4;
                ppm.extend_from_slice(&[frame[i + 2], frame[i + 1], frame[i]]);
            }
        }
        std::fs::write(&path, ppm)?;
        println!("wrote {path}");
    }

    anyhow::ensure!(
        mesh > total / 50,
        "blank/clear-only frame: the GLB box did not render (mesh {mesh}/{total})"
    );
    println!("OK: non-blank shaded mesh rendered by the unchanged Component");
    Ok(())
}
