package com.phoneflipper.one;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PhoneSensors")
public class PhoneSensorsPlugin extends Plugin implements SensorEventListener {
    private SensorManager sensorManager;
    private Sensor magnetometer;
    private Sensor lightSensor;
    private Sensor proximitySensor;
    private Sensor pressureSensor;
    private float lastLight = -1f;
    private float lastProximity = -1f;
    private float lastPressure = -1f;

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        magnetometer = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        lightSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT);
        proximitySensor = sensorManager.getDefaultSensor(Sensor.TYPE_PROXIMITY);
        pressureSensor = sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE);
    }

    @PluginMethod
    public void getSensorInventory(PluginCall call) {
        JSObject result = new JSObject();
        result.put("magnetometer", magnetometer != null);
        result.put("light", lightSensor != null);
        result.put("proximity", proximitySensor != null);
        result.put("pressure", pressureSensor != null);
        call.resolve(result);
    }

    @PluginMethod
    public void isMagnetometerAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", magnetometer != null);
        call.resolve(result);
    }

    @PluginMethod
    public void startMagnetometer(PluginCall call) {
        if (magnetometer == null) {
            call.reject("This phone does not expose a magnetometer sensor.");
            return;
        }
        sensorManager.registerListener(this, magnetometer, SensorManager.SENSOR_DELAY_UI);
        if (lightSensor != null) sensorManager.registerListener(this, lightSensor, SensorManager.SENSOR_DELAY_UI);
        if (proximitySensor != null) sensorManager.registerListener(this, proximitySensor, SensorManager.SENSOR_DELAY_UI);
        if (pressureSensor != null) sensorManager.registerListener(this, pressureSensor, SensorManager.SENSOR_DELAY_UI);
        call.resolve();
    }

    @PluginMethod
    public void stopMagnetometer(PluginCall call) {
        sensorManager.unregisterListener(this);
        call.resolve();
    }

    private void emitEnvironment() {
        JSObject reading = new JSObject();
        reading.put("light", lastLight);
        reading.put("proximity", lastProximity);
        reading.put("pressure", lastPressure);
        notifyListeners("environmentReading", reading);
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        int type = event.sensor.getType();
        if (type == Sensor.TYPE_LIGHT) { lastLight = event.values[0]; emitEnvironment(); return; }
        if (type == Sensor.TYPE_PROXIMITY) { lastProximity = event.values[0]; emitEnvironment(); return; }
        if (type == Sensor.TYPE_PRESSURE) { lastPressure = event.values[0]; emitEnvironment(); return; }
        if (type != Sensor.TYPE_MAGNETIC_FIELD) return;
        float x = event.values[0];
        float y = event.values[1];
        float z = event.values[2];
        JSObject reading = new JSObject();
        reading.put("x", x);
        reading.put("y", y);
        reading.put("z", z);
        reading.put("magnitude", Math.sqrt(x * x + y * y + z * z));
        reading.put("accuracy", event.accuracy);
        reading.put("timestamp", event.timestamp / 1000000L);
        notifyListeners("magneticReading", reading);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // Accuracy is included with every emitted reading.
    }

    @Override
    protected void handleOnDestroy() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
        super.handleOnDestroy();
    }
}