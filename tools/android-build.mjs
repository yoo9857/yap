// pnpm app:android [debug|release] — build the Android app: the Rust client for every ABI
// (cargo-ndk → engine/platform/android/app/src/main/jniLibs), then Gradle.
//   debug   → app-debug.apk   (installable, package com.craftyap.app.debug)
//   release → app-release.aab (Play upload; needs CRAFTYAP_UPLOAD_STORE / _STORE_PASSWORD /
//             _KEY_ALIAS / _KEY_PASSWORD in the environment — never in the repo)
// Toolchain (docs/ANDROID.md): JAVA_HOME = a JDK 17+, ANDROID_HOME = the SDK with the NDK below.
// Paths must be ASCII: the NDK and Gradle break under a non-ASCII user profile, hence C:\Android.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const android = join(root, "engine/platform/android");
const kind = process.argv[2] ?? "debug";
if (!["debug", "release"].includes(kind)) fail(`unknown build "${kind}" (debug | release)`);

function fail(msg) {
  console.error(`app:android: ${msg}`);
  process.exit(1);
}
const win = process.platform === "win32";
const env = { ...process.env };
// Windows defaults: the ASCII-path toolchain under C:/Android (see docs/ANDROID.md)
if (win && !env.ANDROID_HOME && existsSync("C:/Android/Sdk")) env.ANDROID_HOME = "C:/Android/Sdk";
// JAVA_HOME often points at a JRE (no javac), which Gradle cannot build with
const hasJavac = (home) => !!home && (existsSync(join(home, "bin", "javac")) || existsSync(join(home, "bin", "javac.exe")));
if (!hasJavac(env.JAVA_HOME) && win && existsSync("C:/Android/jdk-21")) env.JAVA_HOME = "C:/Android/jdk-21";
if (win && !env.GRADLE_USER_HOME && existsSync("C:/Android")) env.GRADLE_USER_HOME = "C:/Android/gradle-home";
if (!env.ANDROID_HOME) fail("ANDROID_HOME is not set (the Android SDK)");
if (!hasJavac(env.JAVA_HOME)) fail(`JAVA_HOME (${env.JAVA_HOME ?? "unset"}) is not a JDK 17+ (no javac)`);
const ndkVersion = /ndkVersion\s*=\s*"([^"]+)"/.exec(readFileSync(join(android, "app/build.gradle.kts"), "utf8"))?.[1];
env.ANDROID_NDK_HOME = join(env.ANDROID_HOME, "ndk", ndkVersion ?? "");
if (!ndkVersion || !existsSync(env.ANDROID_NDK_HOME)) fail(`NDK ${ndkVersion} is not installed in ${env.ANDROID_HOME}/ndk`);
if (kind === "release") {
  for (const k of ["CRAFTYAP_UPLOAD_STORE", "CRAFTYAP_UPLOAD_STORE_PASSWORD", "CRAFTYAP_UPLOAD_KEY_ALIAS", "CRAFTYAP_UPLOAD_KEY_PASSWORD"]) {
    if (!env[k]) fail(`${k} is not set: a release bundle must be signed with the upload key`);
  }
}

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  // no shell: a .bat runs through cmd.exe explicitly (Node refuses .bat without a shell)
  const bat = win && cmd.endsWith(".bat");
  const r = spawnSync(bat ? "cmd.exe" : cmd, bat ? ["/d", "/c", cmd, ...args] : args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) fail(`${cmd} failed (${r.status ?? r.signal})`);
}

run("cargo", ["ndk", "-t", "arm64-v8a", "-t", "armeabi-v7a", "-t", "x86_64", "-o", join(android, "app/src/main/jniLibs"), "build", "--release", "-p", "craftyap-client", "--lib"], join(root, "engine"));
// absolute: Windows may not search the current directory for programs (NoDefaultCurrentDirectoryInExePath)
run(join(android, win ? "gradlew.bat" : "gradlew"), [kind === "release" ? "bundleRelease" : "assembleDebug", "--no-daemon"], android);
const out = kind === "release" ? "app/build/outputs/bundle/release/app-release.aab" : "app/build/outputs/apk/debug/app-debug.apk";
console.log(`app:android: ${join(android, out)}`);
