package com.craftyap.app;

import com.google.androidgamesdk.GameActivity;

/**
 * The whole app is the Rust client (engine/crates/client, libcraftyap_client.so). This class only
 * exists because GameActivity must be subclassed; GameActivity gives the Rust side the soft
 * keyboard with full IME composition (Hangul), which NativeActivity cannot.
 */
public class MainActivity extends GameActivity {
    static {
        System.loadLibrary("craftyap_client");
    }
}
