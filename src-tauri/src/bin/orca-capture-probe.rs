//! Standalone probe to verify the native WKWebView screenshot path end-to-end.
//! Sets up a minimal NSApplication (required for WebKit) on the main thread,
//! captures a URL to a PNG via the same code the Tauri bridge uses, and exits.
//!
//! Usage: cargo run --bin orca-capture-probe -- "<url>" "<out.png>"

#[cfg(target_os = "macos")]
fn main() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    let url = std::env::args().nth(1).unwrap_or_else(||
        "data:text/html,<html><body style='margin:0;background:%23c0392b'><h1 style='color:white;font-family:sans-serif;padding:40px'>Orca native capture</h1></body></html>".to_string());
    let out = std::env::args().nth(2).unwrap_or_else(|| "/tmp/orca-native-probe.png".to_string());

    let mtm = MainThreadMarker::new().expect("probe must run on the main thread");
    // WebKit requires an initialized application object + a non-prohibited
    // activation policy to render off-screen webviews.
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    match orca_desktop_lib::native_capture::capture_to_png(&url, &out, 8000) {
        Ok(()) => {
            let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
            println!("ok: captured {out} ({bytes} bytes)");
        }
        Err(error) => {
            eprintln!("fail: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("orca-capture-probe is macOS-only");
    std::process::exit(2);
}
