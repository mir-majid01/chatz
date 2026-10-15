package com.chatz.app;

import android.os.Bundle;
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
        super.onCreate(savedInstanceState);
    }
}
