# CraftYap Android app

The app is the **native Rust client** (`engine/crates/client`): the shared engine core drawn with
wgpu, packaged as a NativeActivity in `engine/platform/android`. There is no WebView and no
Java/Kotlin code. The same crate opens a desktop window (`cargo run -p craftyap-client`), so most
work is tried on the PC first.

Decided on 2026-11-05:
- package `com.craftyap.app`; debug builds are `com.craftyap.app.debug`, so both install side by side;
- app name CraftYap;
- the audience includes children, so the app follows the Google Play **Families** policy and has
  **no ads**;
- release follows the native engine (roadmap stage 2 in `docs/ENGINE.md`).

## Layout

```
engine/crates/client/          the app: winit window + wgpu renderer on craftyap-core
  src/lib.rs                   entry points: android_main (the .so), desktop_main; panic → log
  src/app.rs                   lifecycle (pause/resume), input, frame loop, quality auto-tuning
  src/gpu.rs                   device (app lifetime) + surface (window lifetime), recovery
  src/chunks.rs                the world as triangles: scan + shells per chunk (opaque / see-through), mesher pool
  src/surfaces.rs              block surface textures, generated on background threads at start
  src/scene.rs                 vertex type, colours, the orbit camera
  src/quality.rs               Low / Medium / High presets, AutoTuner (unit-tested)
engine/platform/android/       Gradle project (AGP 9.5, Gradle 9.8.2 wrapper with a pinned checksum)
  app/build.gradle.kts         ids, SDK levels, ABIs, upload signing from the environment
  app/src/main/AndroidManifest.xml
  app/src/main/jniLibs/        BUILT by cargo-ndk (git-ignored)
tools/android-build.mjs        pnpm app:android [debug|release]
```

## Toolchain (Windows dev machine)

Every path must be **ASCII**. The user profile here is `C:\Users\AI배움터`, and the NDK, Gradle and
emulator break under a non-ASCII path. Everything Android therefore lives under `C:\Android`:

| What | Where | How it was installed |
|---|---|---|
| JDK 21 (Temurin 21.0.13) | `C:\Android\jdk-21` | Adoptium zip, sha256 checked |
| Android SDK | `C:\Android\Sdk` | command-line tools 16111833 (sha1 checked), then `sdkmanager` |
| SDK packages | platform-tools, `platforms;android-36`, `build-tools;36.1.0`, `ndk;29.0.14206865`, emulator, `system-images;android-36;google_apis;x86_64` | `sdkmanager` |
| Gradle home | `C:\Android\gradle-home` | set by the build script |
| Emulator AVD | `C:\Android\avd\craftyap36` (Pixel 6, API 36) | `avdmanager`, with `ANDROID_AVD_HOME` / `ANDROID_USER_HOME` under C:\Android |
| Rust targets | aarch64/armv7/x86_64-linux-android | `engine/rust-toolchain.toml` |
| cargo-ndk | `~/.cargo/bin` | `cargo install cargo-ndk --locked` |

Notes:
- The system `JAVA_HOME` on this PC points at a JRE (no `javac`). The build script uses
  `C:\Android\jdk-21` whenever `JAVA_HOME` has no `javac`.
- The new `sdkmanager` lists packages with `/` but takes them with `;` (avdmanager too).
- Do not write `local.properties` by hand with backslashes: `\A` is an escape in a properties file,
  and AGP failed with "filename syntax is incorrect". The build uses `ANDROID_HOME` instead.

## Commands

```bash
pnpm app:android            # Rust .so for arm64-v8a, armeabi-v7a, x86_64 → Gradle → app-debug.apk
pnpm app:android:release    # → app-release.aab (needs the CRAFTYAP_UPLOAD_* variables below)
cargo run -p craftyap-client            # the same client in a desktop window (from engine/)
cargo test -p craftyap-client           # unit tests (quality tuner, terrain mesh)
```

Emulator (WHPX acceleration works on this PC):

```bash
ANDROID_AVD_HOME=C:/Android/avd ANDROID_USER_HOME=C:/Android/user C:/Android/Sdk/emulator/emulator.exe -avd craftyap36 -no-snapshot -no-audio
adb install -r engine/platform/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.craftyap.app.debug/android.app.NativeActivity
adb logcat -s CraftYap          # the app logs under the tag CraftYap (panics included)
```

## Lifecycle and error handling (load-bearing)

- **The device outlives the window.** Android destroys the native window on every pause.
  - `suspended` detaches the surface only (`Renderer::detach`).
  - `resumed` attaches a new one (`Renderer::attach`).
  - Rebuilding the whole device on each resume was slower, and it risks running out of device
    memory on low-end phones.
  - Checked on the emulator: three home/return cycles reattach the surface three times, keep the
    device and keep the process.
- **Surface errors never crash.**
  - Outdated or Lost: the surface is reconfigured and the frame skipped.
  - Timeout or Occluded: the frame is skipped.
  - A lost device (driver reset) is flagged by wgpu's callback, and the app builds a new renderer.
  - A renderer that cannot be built is logged and retried on the next resume.
- **Every panic is logged** before the abort (`install_panic_log`). Release builds use
  `panic = "abort"`, so without the hook a crash leaves nothing in logcat.
- **`configChanges`** covers rotation, folding, keyboard and night mode. The activity, and with it
  the GPU state, survives them; the app only sees a resize.
- **Backends.**
  - Android uses Vulkan with a GLES 3 fallback, for phones whose Vulkan drivers are broken. The
    manifest requires GLES 3.0, and Vulkan is optional.
  - GLES needs the event loop's display handle (`InstanceDescriptor::new_with_display_handle`).
- **Quality.**
  - `Preset::initial` picks a preset from the GPU type and its limits.
  - `AutoTuner` steps down after about 3 s of frames over budget.
  - It never steps up on its own, and a pause or resume is not counted as a slow frame.
  - Changing the preset rebuilds the pipeline and the render targets, not the device.

## Signing and release

- **Play App Signing** holds the app signing key. We keep only the **upload key**: a `.jks` outside
  the repo (`*.jks` is git-ignored). Its passwords go in a password manager and in CI secrets.
- A release build reads these environment variables, and nothing from files in the repo:
  - `CRAFTYAP_UPLOAD_STORE` (path to the .jks)
  - `CRAFTYAP_UPLOAD_STORE_PASSWORD`
  - `CRAFTYAP_UPLOAD_KEY_ALIAS`
  - `CRAFTYAP_UPLOAD_KEY_PASSWORD`
  - `CRAFTYAP_VERSION_CODE`, which must grow with every upload
  - `CRAFTYAP_VERSION_NAME`
- The bundle (.aab) carries all three ABIs, and Play serves each phone its own. That is about 6.5 MB
  of native code instead of the debug APK's 18 MB.

### Play Console checklist (company account)

- [ ] App created: CraftYap, `com.craftyap.app`, game / education
- [ ] Target audience includes under-13s → **Families policy**: no ads, no third-party SDKs that are
      not Families-certified, a teacher-approved design
- [ ] Privacy policy URL (to add on craftyap.com: what the classroom stores — class name, names,
      seat keys, field edits — and that nothing is sold or used for ads)
- [ ] Data safety form matching it
- [ ] Content rating questionnaire (IARC)
- [ ] Store listing: icon 512², feature graphic 1024×500, phone + 7"/10" tablet screenshots
- [ ] Internal testing track → closed testing → production
- [ ] Target API level stays at Play's current requirement (36 today; check every August)

## Roadmap to the store (native client)

| Milestone | Content | Status |
|---|---|---|
| N0 | Toolchain, Gradle project, `pnpm app:android`, emulator, CI build | done (2026-11-05) |
| N1 | Native shell on Android + desktop: wgpu device/surface lifecycle, recovery, quality presets, a core-meshed chunk | done (2026-11-05) |
| N2 | The world. Done: island generation (`world.rs`, = generateIsland on 8 seeds incl. the default 20260718); the block catalog and shape codes GENERATED from blocks.ts / @robo/shared (`pnpm engine:catalog`, CI `--check`); chunks via the scan + shells on a mesher thread with near/far LOD; block surfaces (`surface.rs`, = createMaterialMaps byte for byte, 13 families) as a texture array, made on background threads at start (`surfaces.rs`); the web sky gradient + linear fog (95–245 m); glass/ice in a blended pass (opacity 0.55, far chunks first); 28-byte vertices and a 4 ms/frame upload budget (first frame on the emulator 2.2 s → 0.36–0.5 s); studs = the Blender asset shared with the web (`studs.rs` reads the compiled-in `block-studs.glb`: Stud_HQ ≤ 12 m, Stud_LOD1 ≤ 32 m, 16-byte instances per chunk from the far scan, the band picked per top in the vertex shader). Web ↔ native views are compared with `tools/shot-native-compare.mjs` + `CRAFTYAP_VIEW`. block surfaces = the web's (`pnpm engine:tiles`, needs pnpm dev: runs the web's own framelessTile / needsCatalogTexture / generated-albedo choice in headless Edge, bakes the picture tiles to `engine/assets/tiles/*.webp` and generates `tiles_gen.rs` with each block band's surface and tint; the AI albedos are read from the web's own files; one 256-texel array, `looks.rs` + `surfaces.rs`; CI `engine:tiles --check`). Open: the lighting model (normal/roughness maps, tone mapping — native is plain Lambert, so stone reads lighter than on the web), sun shadows, emissive blocks, water mesh, the AI albedo for snow/grass/gem, normal maps, the field | **in progress** |
| N3 | The player: voxel body physics (port of voxelBody), touch controls (joystick, jump, look, dig/place), hotbar, saves | |
| N4 | Classroom: the `k-`/`s-k-` protocol over WebSocket (serde types mirroring the zod schemas), shared field, chat | |
| N5 | Polish: HOME character, pets, furniture, sounds, menus/i18n (KO/EN) | |
| N6 | Release: icon/art, privacy policy, Data safety, internal test on real low-end + flagship phones, production | |
