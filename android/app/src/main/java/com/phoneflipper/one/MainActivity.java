package com.phoneflipper.one;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PhoneSensorsPlugin.class);
        registerPlugin(ArduinoUsbPlugin.class);
        registerPlugin(InfraredPlugin.class);
        registerPlugin(NfcPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
