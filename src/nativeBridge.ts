import { registerPlugin } from "@capacitor/core";

export type MagneticReading = {
  x: number;
  y: number;
  z: number;
  magnitude: number;
  accuracy: number;
  timestamp: number;
};

export type UsbArduinoDevice = {
  deviceId: number;
  name: string;
  vendorId: number;
  productId: number;
  driver: string;
};

export type EnvironmentReading = {
  light: number;
  proximity: number;
  pressure: number;
};

export type NfcTagEvent = {
  uid: string;
  techList: string[];
  records?: string[];
  writeResult?: string;
};

interface PhoneSensorsPlugin {
  isMagnetometerAvailable(): Promise<{ available: boolean }>;
  getSensorInventory(): Promise<{ magnetometer: boolean; light: boolean; proximity: boolean; pressure: boolean }>;
  startMagnetometer(): Promise<void>;
  stopMagnetometer(): Promise<void>;
  addListener(eventName: "magneticReading", listener: (reading: MagneticReading) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: "environmentReading", listener: (reading: EnvironmentReading) => void): Promise<{ remove: () => Promise<void> }>;
}

interface NfcNativePlugin {
  isAvailable(): Promise<{ available: boolean; enabled: boolean }>;
  startScan(): Promise<void>;
  stopScan(): Promise<void>;
  queueWrite(options: { text?: string; uri?: string }): Promise<void>;
  addListener(eventName: "tagRead", listener: (event: NfcTagEvent) => void): Promise<{ remove: () => Promise<void> }>;
}

interface ArduinoUsbPlugin {
  listDevices(): Promise<{ devices: UsbArduinoDevice[] }>;
  connect(options: { deviceId: number; baudRate: number }): Promise<{ deviceName: string }>;
  disconnect(): Promise<void>;
  write(options: { data: string }): Promise<void>;
  addListener(eventName: "serialData", listener: (event: { data: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

interface InfraredPlugin {
  hasEmitter(): Promise<{ available: boolean }>;
  getCarrierFrequencies(): Promise<{ ranges: Array<{ min: number; max: number }> }>;
  transmit(options: { carrierFrequency: number; pattern: number[] }): Promise<void>;
}

// Native Android implementations live in android/app and safely fall back to rejected calls on web.
export const PhoneSensors = registerPlugin<PhoneSensorsPlugin>("PhoneSensors");
export const ArduinoUsb = registerPlugin<ArduinoUsbPlugin>("ArduinoUsb");
export const Infrared = registerPlugin<InfraredPlugin>("Infrared");
export const NfcNative = registerPlugin<NfcNativePlugin>("Nfc");