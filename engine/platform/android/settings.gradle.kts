// CraftYap Android app: a GameActivity (MainActivity.java, three lines) that loads the Rust client as
// libcraftyap_client.so. The .so files are built by `pnpm app:android` (cargo-ndk) into
// app/src/main/jniLibs before Gradle packages them. GameActivity, not NativeActivity: only it has an
// IME bridge (GameTextInput), and class and player names are typed in Korean.
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
