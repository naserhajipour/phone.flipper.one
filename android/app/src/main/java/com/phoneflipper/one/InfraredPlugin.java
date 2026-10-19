package com.phoneflipper.one;

import android.content.Context;
import android.hardware.ConsumerIrManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Infrared")
public class InfraredPlugin extends Plugin {
    private ConsumerIrManager irManager;

    @Override
    public void load() {
        irManager = (ConsumerIrManager) getContext().getSystemService(Context.CONSUMER_IR_SERVICE);
    }

    @PluginMethod
    public void hasEmitter(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", irManager != null && irManager.hasIrEmitter());
        call.resolve(result);
    }

    @PluginMethod
    public void getCarrierFrequencies(PluginCall call) {
        JSArray ranges = new JSArray();
        if (irManager != null && irManager.hasIrEmitter() && irManager.getCarrierFrequencies() != null) {
            for (ConsumerIrManager.CarrierFrequencyRange range : irManager.getCarrierFrequencies()) {
                JSObject value = new JSObject();
                value.put("min", range.getMinFrequency());
                value.put("max", range.getMaxFrequency());
                ranges.put(value);
            }
        }
        JSObject result = new JSObject();
        result.put("ranges", ranges);
        call.resolve(result);
    }

    @PluginMethod
    public void transmit(PluginCall call) {
        if (irManager == null || !irManager.hasIrEmitter()) {
            call.reject("This Android phone has no consumer IR transmitter.");
            return;
        }
        Integer carrierFrequency = call.getInt("carrierFrequency");
        JSArray rawPattern = call.getArray("pattern");
        if (carrierFrequency == null || rawPattern == null || rawPattern.length() == 0) {
            call.reject("A carrier frequency and a non-empty pulse pattern are required.");
            return;
        }
        try {
            int[] pattern = new int[rawPattern.length()];
            for (int index = 0; index < rawPattern.length(); index++) {
                pattern[index] = rawPattern.getInt(index);
                if (pattern[index] <= 0) {
                    call.reject("Pulse timings must be positive microsecond values.");
                    return;
                }
            }
            irManager.transmit(carrierFrequency, pattern);
            call.resolve();
        } catch (Exception exception) {
            call.reject("IR transmit failed: " + exception.getMessage());
        }
    }
}