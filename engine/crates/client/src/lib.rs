//! CraftYap native client: the shared Rust core (`craftyap-core`) drawn with wgpu.
//! One codebase for the Android app (`android_main`, loaded as `libcraftyap_client.so` by the
//! NativeActivity in `engine/platform/android`) and the desktop window (`src/main.rs`).
//!
//! Layout:
//! - `app`: the winit application: window lifecycle (Android destroys the surface on every
//!   pause), input, the frame loop
//! - `gpu`: device + surface, and recovery when either is lost
//! - `chunks`: the world as triangles: scan + brick shells per chunk on a mesher thread
//! - `scene`: vertex type, colours, the camera
//! - `surfaces`: the block surface textures, made on background threads at start
//! - `quality`: low / medium / high presets and the automatic choice

mod app;
mod chunks;
mod gpu;
mod quality;
mod scene;
mod studs;
mod looks;
mod surfaces;
mod tiles_gen;

pub use app::run;

/// Log every panic before the process ends (release builds abort on panic; without this an
/// Android crash leaves no line in logcat explaining it).
fn install_panic_log() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        default(info);
    }));
}

#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(app: winit::platform::android::activity::AndroidApp) {
    use winit::platform::android::EventLoopBuilderExtAndroid;
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("CraftYap"));
    install_panic_log();
    let event_loop = match winit::event_loop::EventLoop::builder().with_android_app(app).build() {
        Ok(el) => el,
        Err(err) => {
            log::error!("cannot start the event loop: {err}");
            return;
        }
    };
    if let Err(err) = run(event_loop) {
        log::error!("the app stopped: {err:#}");
    }
}

/// Desktop entry (the `craftyap` binary).
#[cfg(not(target_os = "android"))]
pub fn desktop_main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    install_panic_log();
    let event_loop = winit::event_loop::EventLoop::new()?;
    run(event_loop)
}
