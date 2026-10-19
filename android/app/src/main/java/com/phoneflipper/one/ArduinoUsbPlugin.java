package com.phoneflipper.one;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;
import com.hoho.android.usbserial.util.SerialInputOutputManager;

import java.nio.charset.StandardCharsets;
import java.util.List;

@CapacitorPlugin(name = "ArduinoUsb")
public class ArduinoUsbPlugin extends Plugin {
    private static final String ACTION_USB_PERMISSION = "com.phoneflipper.one.USB_PERMISSION";
    private UsbManager usbManager;
    private UsbSerialPort port;
    private SerialInputOutputManager ioManager;
    private UsbSerialDriver pendingDriver;
    private int pendingBaudRate;
    private PluginCall pendingConnectCall;

    private final BroadcastReceiver permissionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!ACTION_USB_PERMISSION.equals(intent.getAction())) return;
            synchronized (this) {
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                if (granted && pendingDriver != null && pendingConnectCall != null) {
                    openDriver(pendingDriver, pendingBaudRate, pendingConnectCall);
                } else if (pendingConnectCall != null) {
                    pendingConnectCall.reject("USB permission was not granted.");
                }
                pendingDriver = null;
                pendingConnectCall = null;
            }
        }
    };

    @Override
    public void load() {
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(permissionReceiver, filter);
        }
    }

    @PluginMethod
    public void listDevices(PluginCall call) {
        JSArray devices = new JSArray();
        List<UsbSerialDriver> drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager);
        for (UsbSerialDriver driver : drivers) {
            UsbDevice device = driver.getDevice();
            JSObject entry = new JSObject();
            entry.put("deviceId", device.getDeviceId());
            entry.put("name", device.getDeviceName());
            entry.put("vendorId", device.getVendorId());
            entry.put("productId", device.getProductId());
            entry.put("driver", driver.getClass().getSimpleName());
            devices.put(entry);
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        Integer deviceId = call.getInt("deviceId");
        Integer baudRate = call.getInt("baudRate", 115200);
        if (deviceId == null) {
            call.reject("A USB device ID is required.");
            return;
        }
        UsbSerialDriver selected = null;
        for (UsbSerialDriver driver : UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)) {
            if (driver.getDevice().getDeviceId() == deviceId) {
                selected = driver;
                break;
            }
        }
        if (selected == null) {
            call.reject("No supported USB serial driver was found for this device.");
            return;
        }
        if (!usbManager.hasPermission(selected.getDevice())) {
            pendingDriver = selected;
            pendingBaudRate = baudRate;
            pendingConnectCall = call;
            PendingIntent intent = PendingIntent.getBroadcast(
                getContext(), 0, new Intent(ACTION_USB_PERMISSION), PendingIntent.FLAG_IMMUTABLE
            );
            usbManager.requestPermission(selected.getDevice(), intent);
            return;
        }
        openDriver(selected, baudRate, call);
    }

    private void openDriver(UsbSerialDriver driver, int baudRate, PluginCall call) {
        closePort();
        UsbDeviceConnection connection = usbManager.openDevice(driver.getDevice());
        if (connection == null) {
            call.reject("The USB device could not be opened.");
            return;
        }
        try {
            port = driver.getPorts().get(0);
            port.open(connection);
            port.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
            ioManager = new SerialInputOutputManager(port, new SerialInputOutputManager.Listener() {
                @Override
                public void onNewData(byte[] data) {
                    JSObject event = new JSObject();
                    event.put("data", new String(data, StandardCharsets.UTF_8));
                    notifyListeners("serialData", event);
                }

                @Override
                public void onRunError(Exception exception) {
                    JSObject event = new JSObject();
                    event.put("data", "[serial error] " + exception.getMessage());
                    notifyListeners("serialData", event);
                }
            });
            ioManager.start();
            JSObject result = new JSObject();
            result.put("deviceName", driver.getDevice().getDeviceName());
            call.resolve(result);
        } catch (Exception exception) {
            closePort();
            call.reject("Could not open USB serial: " + exception.getMessage());
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        String data = call.getString("data", "");
        if (port == null) {
            call.reject("No USB serial device is connected.");
            return;
        }
        try {
            port.write(data.getBytes(StandardCharsets.UTF_8), 2000);
            call.resolve();
        } catch (Exception exception) {
            call.reject("Serial write failed: " + exception.getMessage());
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closePort();
        call.resolve();
    }

    private void closePort() {
        if (ioManager != null) {
            ioManager.stop();
            ioManager = null;
        }
        if (port != null) {
            try {
                port.close();
            } catch (Exception ignored) {
                // The port may already have been detached by the operating system.
            }
            port = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        closePort();
        try {
            getContext().unregisterReceiver(permissionReceiver);
        } catch (IllegalArgumentException ignored) {
            // The receiver may not be registered if the activity failed during startup.
        }
        super.handleOnDestroy();
    }
}