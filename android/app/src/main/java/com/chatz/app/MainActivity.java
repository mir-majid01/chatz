package com.chatz.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;
import com.chatz.app.plugin.UpdatePlugin;
import com.chatz.app.plugin.VibeStatsPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered BEFORE super.onCreate(): BridgeActivity.onCreate()
        // builds the Bridge from the plugin list, so registering after it means
        // the plugin never reaches the live bridge ("not implemented on android").
        registerPlugin(VibeStatsPlugin.class);
        registerPlugin(UpdatePlugin.class);
        // Set before super.onCreate() so no frame is ever drawn unprotected.
        // ChatZ has exactly one window — every screen is a route inside the
        // Capacitor WebView — so a per-screen policy is impossible; and because
        // DM text, stats and file shares all live in that one window, the flag
        // stays on for the whole app and is never cleared. Cost: no screenshots
        // or screen recording anywhere, and a blank recents thumbnail.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        super.onCreate(savedInstanceState);
    }
}
