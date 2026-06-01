//! Native, Chromium-free evidence screenshots for the macOS desktop app.
//!
//! Orca's Node server performs evidence capture, but a browser engine normally
//! lives outside the app. On macOS we can avoid bundling one: the Tauri shell
//! already embeds a WKWebView, and WKWebView can rasterize any URL it loads via
//! `takeSnapshot`. This module exposes a tiny loopback HTTP bridge that the Node
//! server calls (`POST /capture {url, outPath}`); the bridge drives a hidden
//! WKWebView on the main thread and writes a PNG to `outPath`.
//!
//! The Node side (src/evidence-runner.js) uses this only for screenshot-only
//! captures and falls back to Playwright for video/traces or on any failure, so
//! a bridge error or timeout is never fatal — it just degrades to Playwright.

#[cfg(target_os = "macos")]
mod imp {
    #[allow(unused_imports)]
    use std::io::Read; // brings read_to_string into scope for the request reader
    use std::sync::mpsc;
    use std::thread;

    use tauri::AppHandle;

    /// Endpoint + token to hand to the Node server via env.
    pub struct NativeCaptureBridge {
        pub endpoint: String,
        pub token: String,
    }

    #[derive(serde::Deserialize)]
    struct CaptureRequest {
        url: String,
        #[serde(rename = "outPath")]
        out_path: String,
        #[serde(rename = "timeoutMs", default)]
        timeout_ms: Option<u64>,
    }

    /// Start the loopback bridge. Returns the endpoint + token the Node server
    /// must present. The HTTP server runs on its own thread; each capture is
    /// dispatched to the main thread (WKWebView is main-thread-only).
    pub fn start(app: AppHandle, token: String) -> Option<NativeCaptureBridge> {
        let server = match tiny_http::Server::http("127.0.0.1:0") {
            Ok(server) => server,
            Err(error) => {
                log::error!("native capture bridge failed to bind: {error}");
                return None;
            }
        };
        let port = match server.server_addr().to_ip() {
            Some(addr) => addr.port(),
            None => {
                log::error!("native capture bridge has no IP address");
                return None;
            }
        };
        let endpoint = format!("http://127.0.0.1:{port}");
        let expected_token = token.clone();

        thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let authorized = request
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("x-orca-native-token") && h.value.as_str() == expected_token);
                if !authorized || request.url() != "/capture" {
                    let _ = request.respond(tiny_http::Response::empty(403));
                    continue;
                }
                let mut body = String::new();
                if request.as_reader().read_to_string(&mut body).is_err() {
                    let _ = request.respond(tiny_http::Response::empty(400));
                    continue;
                }
                let parsed: Result<CaptureRequest, _> = serde_json::from_str(&body);
                let Ok(req) = parsed else {
                    let _ = request.respond(tiny_http::Response::empty(400));
                    continue;
                };
                let timeout = req.timeout_ms.unwrap_or(15000);
                let (tx, rx) = mpsc::channel::<Result<(), String>>();
                let url = req.url.clone();
                let out_path = req.out_path.clone();
                let dispatch = app.run_on_main_thread(move || {
                    let result = super::snapshot::capture_to_png(&url, &out_path, timeout);
                    let _ = tx.send(result);
                });
                if dispatch.is_err() {
                    let _ = request.respond(tiny_http::Response::empty(500));
                    continue;
                }
                // Wait a little longer than the page timeout for the main-thread work.
                let outcome = rx
                    .recv_timeout(std::time::Duration::from_millis(timeout + 8000))
                    .unwrap_or_else(|_| Err("native capture timed out".to_string()));
                match outcome {
                    Ok(()) => {
                        let _ = request.respond(tiny_http::Response::empty(200));
                    }
                    Err(error) => {
                        log::warn!("native capture failed: {error}");
                        let _ = request.respond(tiny_http::Response::empty(502));
                    }
                }
            }
        });

        Some(NativeCaptureBridge { endpoint, token })
    }
}

#[cfg(target_os = "macos")]
mod snapshot {
    //! WKWebView-backed page snapshot. Runs entirely on the main thread; a
    //! nested run loop is spun so navigation + snapshot completion handlers fire
    //! while we wait synchronously.
    use std::cell::Cell;
    use std::path::Path;
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{
        NSData, NSDate, NSDefaultRunLoopMode, NSDictionary, NSError, NSPoint, NSRect, NSRunLoop,
        NSSize, NSString, NSURLRequest, NSURL,
    };
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView, WKWebViewConfiguration};

    const VIEWPORT_W: f64 = 1366.0;
    const VIEWPORT_H: f64 = 900.0;

    pub fn capture_to_png(url_str: &str, out_path: &str, timeout_ms: u64) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("native capture must run on the main thread")?;

        let url = NSURL::URLWithString(&NSString::from_str(url_str))
            .ok_or("invalid capture URL")?;
        let request = NSURLRequest::requestWithURL(&url);

        let frame = NSRect {
            origin: NSPoint { x: 0.0, y: 0.0 },
            size: NSSize { width: VIEWPORT_W, height: VIEWPORT_H },
        };
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        let webview = unsafe {
            WKWebView::initWithFrame_configuration(mtm.alloc(), frame, &config)
        };

        unsafe { webview.loadRequest(&request) };

        // Spin the run loop until the page stops loading (or we hit the deadline).
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(2000));
        loop {
            if !unsafe { webview.isLoading() } {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            run_loop_tick(0.05);
        }
        // Brief settle for first paint after load completes.
        let settle = Instant::now() + Duration::from_millis(400);
        while Instant::now() < settle {
            run_loop_tick(0.05);
        }

        // takeSnapshot is async; wait on its completion handler via a nested loop.
        let done = Rc::new(Cell::new(false));
        let image_slot: Rc<Cell<Option<Retained<NSImage>>>> = Rc::new(Cell::new(None));
        let err_slot: Rc<Cell<Option<String>>> = Rc::new(Cell::new(None));

        let done_cb = done.clone();
        let image_cb = image_slot.clone();
        let err_cb = err_slot.clone();
        let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            if !image.is_null() {
                let retained = unsafe { Retained::retain(image) };
                image_cb.set(retained);
            } else if !error.is_null() {
                err_cb.set(Some("WKWebView snapshot returned an error".to_string()));
            } else {
                err_cb.set(Some("WKWebView snapshot produced no image".to_string()));
            }
            done_cb.set(true);
        });

        let snap_config = unsafe { WKSnapshotConfiguration::new(mtm) };
        unsafe {
            webview.takeSnapshotWithConfiguration_completionHandler(Some(&snap_config), &*handler);
        }

        let snap_deadline = Instant::now() + Duration::from_millis(timeout_ms.max(2000));
        while !done.get() {
            if Instant::now() >= snap_deadline {
                return Err("WKWebView snapshot timed out".to_string());
            }
            run_loop_tick(0.05);
        }

        if let Some(error) = err_slot.take() {
            return Err(error);
        }
        let image = image_slot.take().ok_or("WKWebView snapshot produced no image")?;
        let png = image_to_png(&image)?;
        write_file(out_path, &png)?;
        Ok(())
    }

    fn run_loop_tick(seconds: f64) {
        unsafe {
            let until = NSDate::dateWithTimeIntervalSinceNow(seconds);
            let run_loop = NSRunLoop::currentRunLoop();
            run_loop.runMode_beforeDate(NSDefaultRunLoopMode, &until);
        }
    }

    fn image_to_png(image: &NSImage) -> Result<Retained<NSData>, String> {
        unsafe {
            let tiff = image
                .TIFFRepresentation()
                .ok_or("snapshot image has no TIFF representation")?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff)
                .ok_or("could not build bitmap representation")?;
            let props = NSDictionary::new();
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
                .ok_or_else(|| "could not encode PNG".to_string())
        }
    }

    fn write_file(out_path: &str, data: &NSData) -> Result<(), String> {
        let bytes = data.to_vec();
        std::fs::write(Path::new(out_path), bytes)
            .map_err(|error| format!("could not write screenshot to {out_path}: {error}"))
    }
}

#[cfg(target_os = "macos")]
#[allow(unused_imports)] // NativeCaptureBridge re-export makes start()'s return type public
pub use imp::{start, NativeCaptureBridge};

// Non-macOS builds get a no-op bridge so the shared call sites stay simple.
#[cfg(not(target_os = "macos"))]
pub struct NativeCaptureBridge {
    pub endpoint: String,
    pub token: String,
}

#[cfg(not(target_os = "macos"))]
pub fn start(_app: tauri::AppHandle, _token: String) -> Option<NativeCaptureBridge> {
    None
}
