// a release build is a windowed app: no console window behind it
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! `cargo run -p craftyap-client`: the native client in a desktop window.

#[cfg(not(target_os = "android"))]
fn main() -> anyhow::Result<()> {
    craftyap_client::desktop_main()
}

#[cfg(target_os = "android")]
fn main() {}
