package com.phoneflipper.one;

import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.nfc.tech.NdefFormatable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "Nfc")
public class NfcPlugin extends Plugin {
    private NfcAdapter adapter;
    private volatile String pendingWriteText;
    private volatile String pendingWriteUri;

    @Override
    public void load() {
        adapter = NfcAdapter.getDefaultAdapter(getContext());
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", adapter != null);
        result.put("enabled", adapter != null && adapter.isEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        if (adapter == null) {
            call.reject("This phone has no NFC hardware.");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("NFC is turned off. Enable it in Android settings.");
            return;
        }
        getActivity().runOnUiThread(() -> adapter.enableReaderMode(
            getActivity(),
            this::handleTag,
            NfcAdapter.FLAG_READER_NFC_A | NfcAdapter.FLAG_READER_NFC_B
                | NfcAdapter.FLAG_READER_NFC_F | NfcAdapter.FLAG_READER_NFC_V,
            null
        ));
        call.resolve();
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        if (adapter != null && getActivity() != null) {
            getActivity().runOnUiThread(() -> adapter.disableReaderMode(getActivity()));
        }
        pendingWriteText = null;
        pendingWriteUri = null;
        call.resolve();
    }

    @PluginMethod
    public void queueWrite(PluginCall call) {
        String text = call.getString("text");
        String uri = call.getString("uri");
        if ((text == null || text.isEmpty()) && (uri == null || uri.isEmpty())) {
            call.reject("Provide text or uri to write.");
            return;
        }
        pendingWriteText = text;
        pendingWriteUri = uri;
        call.resolve();
    }

    private void handleTag(Tag tag) {
        JSObject event = new JSObject();
        event.put("uid", bytesToHex(tag.getId()));
        JSArray techs = new JSArray();
        for (String tech : tag.getTechList()) {
            techs.put(tech.replace("android.nfc.tech.", ""));
        }
        event.put("techList", techs);

        Ndef ndef = Ndef.get(tag);
        if (pendingWriteText != null || pendingWriteUri != null) {
            event.put("writeResult", writeToTag(tag, ndef));
            pendingWriteText = null;
            pendingWriteUri = null;
        } else if (ndef != null) {
            event.put("records", readNdef(ndef));
        }
        notifyListeners("tagRead", event);
    }

    private JSArray readNdef(Ndef ndef) {
        JSArray records = new JSArray();
        try {
            ndef.connect();
            NdefMessage message = ndef.getNdefMessage();
            if (message != null) {
                for (NdefRecord record : message.getRecords()) {
                    records.put(decodeRecord(record));
                }
            }
        } catch (Exception exception) {
            records.put("read error: " + exception.getMessage());
        } finally {
            try { ndef.close(); } catch (Exception ignored) { }
        }
        return records;
    }

    private String decodeRecord(NdefRecord record) {
        try {
            byte[] payload = record.getPayload();
            if (record.getTnf() == NdefRecord.TNF_WELL_KNOWN) {
                if (java.util.Arrays.equals(record.getType(), NdefRecord.RTD_TEXT) && payload.length > 0) {
                    int langLength = payload[0] & 0x3F;
                    return "text: " + new String(payload, 1 + langLength, payload.length - 1 - langLength, StandardCharsets.UTF_8);
                }
                if (java.util.Arrays.equals(record.getType(), NdefRecord.RTD_URI)) {
                    return "uri: " + record.toUri();
                }
            }
            return record.toMimeType() + ": " + new String(payload, StandardCharsets.UTF_8);
        } catch (Exception exception) {
            return "record (" + record.getPayload().length + " bytes)";
        }
    }

    private String writeToTag(Tag tag, Ndef ndef) {
        try {
            NdefRecord record = pendingWriteUri != null
                ? NdefRecord.createUri(pendingWriteUri)
                : NdefRecord.createTextRecord("en", pendingWriteText);
            NdefMessage message = new NdefMessage(new NdefRecord[] { record });
            if (ndef != null) {
                ndef.connect();
                if (!ndef.isWritable()) return "error: tag is read-only";
                ndef.writeNdefMessage(message);
                ndef.close();
                return "ok";
            }
            NdefFormatable formatable = NdefFormatable.get(tag);
            if (formatable != null) {
                formatable.connect();
                formatable.format(message);
                formatable.close();
                return "ok (formatted)";
            }
            return "error: tag does not support NDEF";
        } catch (Exception exception) {
            return "error: " + exception.getMessage();
        }
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder();
        for (byte item : bytes) builder.append(String.format("%02X", item));
        return builder.toString();
    }

    @Override
    protected void handleOnPause() {
        if (adapter != null && getActivity() != null) adapter.disableReaderMode(getActivity());
        super.handleOnPause();
    }
}
