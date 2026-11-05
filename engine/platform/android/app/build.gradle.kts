plugins {
    id("com.android.application")
}

android {
    namespace = "com.craftyap.app"
    compileSdk = 36
    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = "com.craftyap.app"
        // Android 8: covers low-end school tablets; wgpu falls back to GLES 3 without Vulkan 1.1
        minSdk = 26
        targetSdk = 36
        versionCode = (System.getenv("CRAFTYAP_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("CRAFTYAP_VERSION_NAME") ?: "0.1.0"
        ndk {
            // arm64 phones, armv7 low-end phones, x86_64 emulators
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    signingConfigs {
        // The UPLOAD key (Play App Signing holds the app key). Only from the environment.
        val store = System.getenv("CRAFTYAP_UPLOAD_STORE")
        if (store != null) {
            create("upload") {
                storeFile = file(store)
                storePassword = System.getenv("CRAFTYAP_UPLOAD_STORE_PASSWORD")
                keyAlias = System.getenv("CRAFTYAP_UPLOAD_KEY_ALIAS")
                keyPassword = System.getenv("CRAFTYAP_UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("upload")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    packaging {
        // keep the Rust .so files as built (they are stripped by cargo's release profile)
        jniLibs.keepDebugSymbols += "**/*.so"
    }
}

dependencies {
    // Must match the glue android-activity 0.6 compiles in (its README: 4.4.0, back-compatible to 4.0).
    // Do NOT enable GameActivity's prefab C++ glue: android-activity brings its own.
    implementation("androidx.games:games-activity:4.4.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
}
