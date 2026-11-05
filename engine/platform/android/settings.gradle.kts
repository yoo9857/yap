// CraftYap Android app: a NativeActivity that loads the Rust client (engine/crates/client) as
// libcraftyap_client.so. The .so files are built by `pnpm app:android` (cargo-ndk) into
// app/src/main/jniLibs before Gradle packages them. No Java/Kotlin code.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "CraftYap"
include(":app")
