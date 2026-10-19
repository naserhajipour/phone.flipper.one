import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Motion } from "@capacitor/motion";
import { BleClient } from "@capacitor-community/bluetooth-le";
import { BluetoothSerial, type BluetoothDevice as ClassicBluetoothDevice } from "@e-is/capacitor-bluetooth-serial";
import { ArduinoUsb, Infrared, NfcNative, PhoneSensors, type EnvironmentReading, type MagneticReading, type UsbArduinoDevice } from "./nativeBridge";
import { encodeIr, irKeyMaps, powerCandidates, type IrProtocol } from "./irProtocols";

type TabId = "ir" | "ble" | "net" | "nfc" | "sub" | "sensors" | "ai" | "hw";
type LogTone = "normal" | "success" | "warning" | "error" | "info";

type LogLine = {
  text: string;
  tone?: LogTone;
};

type BluetoothDeviceLike = {
  id: string;
  name?: string;
  native?: boolean;
  gatt?: {
    connected: boolean;
    connect: () => Promise<{
      getPrimaryServices: () => Promise<Array<{ uuid: string }> >;
    }>;
  };
};

type BridgePort = {
  open: (options: { baudRate: number }) => Promise<void>;
};

type BrowserNavigator = Navigator & {
  bluetooth?: {
    requestDevice: (options: {
      acceptAllDevices: boolean;
      optionalServices: Array<string | number>;
    }) => Promise<BluetoothDeviceLike>;
  };
  connection?: {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
    type?: string;
  };
  serial?: {
    requestPort: () => Promise<BridgePort>;
  };
};

type NdefRecordLike = {
  recordType: string;
  mediaType?: string | null;
  data?: DataView | null;
};

type NdefReaderLike = {
  scan: () => Promise<void>;
  write: (message: string) => Promise<void>;
  onreading: ((event: { serialNumber: string; message: { records: NdefRecordLike[] } }) => void) | null;
  onreadingerror: (() => void) | null;
};

type NdefWindow = Window & {
  NDEFReader?: new () => NdefReaderLike;
};

type IconName =
  | "signal"
  | "bluetooth"
  | "network"
  | "nfc"
  | "radio"
  | "spark"
  | "chip"
  | "bolt"
  | "terminal"
  | "download"
  | "shield"
  | "arrow"
  | "copy"
  | "check"
  | "usb"
  | "magnet"
  | "wave"
  | "code";

const tabs: Array<{ id: TabId; label: string; icon: IconName }> = [
  { id: "ir", label: "IR Remote", icon: "signal" },
  { id: "ble", label: "بلوتوث", icon: "bluetooth" },
  { id: "net", label: "شبکه", icon: "network" },
  { id: "nfc", label: "NFC", icon: "nfc" },
  { id: "sub", label: "Sub-GHz", icon: "radio" },
  { id: "sensors", label: "سنسورها", icon: "magnet" },
  { id: "ai", label: "دستیار", icon: "spark" },
  { id: "hw", label: "سخت افزار", icon: "chip" },
];

const brandsByCategory: Record<string, string[]> = {
  tv: ["Samsung", "LG", "Sony", "TCL", "Hisense", "Panasonic", "Xiaomi", "Philips"],
  ac: ["Gree", "Samsung", "LG", "Midea", "General", "Daikin", "Toshiba", "Hisense"],
  projector: ["Epson", "BenQ", "Optoma", "XGIMI", "ViewSonic", "Sony"],
  stb: ["X.Vision", "StarSat", "Strong", "Humax", "TechnoSat", "Dreambox"],
  fan: ["Pars Khazar", "Midea", "Xiaomi", "Panasonic", "Sencor"],
  audio: ["Sony", "Samsung", "LG", "Yamaha", "JBL", "Pioneer"],
};

const remoteKeys = [
  { label: "Power", value: "POWER", kind: "danger" },
  { label: "Input", value: "INPUT", kind: "" },
  { label: "Mute", value: "MUTE", kind: "" },
  { label: "Vol +", value: "VOL+", kind: "" },
  { label: "Up", value: "UP", kind: "nav" },
  { label: "Ch +", value: "CH+", kind: "" },
  { label: "Left", value: "LEFT", kind: "nav" },
  { label: "OK", value: "OK", kind: "ok" },
  { label: "Right", value: "RIGHT", kind: "nav" },
  { label: "Vol -", value: "VOL-", kind: "" },
  { label: "Down", value: "DOWN", kind: "nav" },
  { label: "Ch -", value: "CH-", kind: "" },
  { label: "Back", value: "BACK", kind: "" },
  { label: "Home", value: "HOME", kind: "" },
  { label: "Menu", value: "MENU", kind: "" },
];

const firmware = `// Phone Flipper One - ESP32 IR bridge
// Library: IRremote (>= 4.x) via Arduino Library Manager
// Wiring: IR LED (+ transistor driver) on GPIO 4, status LED on GPIO 2
// Understands the commands this app sends over USB-OTG / Bluetooth Serial:
//   PING                -> PONG
//   STATUS              -> OK
//   IR NEC <hex32>      -> sends NEC frame
//   IR SAMSUNG <hex32>  -> sends Samsung frame
//   IR SIRC12 <hex12>   -> sends Sony 12-bit frame (3 repeats)

#include <IRremote.hpp>

const int IR_SEND_PIN_NUM = 4;
const int STATUS_LED = 2;

void setup() {
  pinMode(STATUS_LED, OUTPUT);
  Serial.begin(115200);
  IrSender.begin(IR_SEND_PIN_NUM);
  Serial.println("PFO_BRIDGE_READY");
}

void loop() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\\n');
  line.trim();

  if (line == "PING") { Serial.println("PONG"); return; }
  if (line == "STATUS") { Serial.println("OK"); return; }

  if (line.startsWith("IR ")) {
    int space = line.indexOf(' ', 3);
    if (space < 0) { Serial.println("ERR_FORMAT"); return; }
    String proto = line.substring(3, space);
    uint32_t code = strtoul(line.substring(space + 1).c_str(), NULL, 16);

    digitalWrite(STATUS_LED, HIGH);
    if (proto == "NEC") {
      IrSender.sendNECRaw(code, 0);
      Serial.println("SENT_NEC");
    } else if (proto == "SAMSUNG") {
      IrSender.sendSamsung48(code >> 16, code & 0xFFFF, 0);
      Serial.println("SENT_SAMSUNG");
    } else if (proto == "SIRC12") {
      for (int i = 0; i < 3; i++) {
        IrSender.sendSony((code >> 7) & 0x1F, code & 0x7F, 0, 12);
        delay(25);
      }
      Serial.println("SENT_SIRC12");
    } else {
      Serial.println("ERR_PROTO");
    }
    digitalWrite(STATUS_LED, LOW);
    return;
  }
  Serial.println("UNKNOWN_COMMAND");
}`;

type IrCandidate = {
  brand: string;
  category: string;
  label: string;
  code: string;
  protocol: IrProtocol;
};

type ArduinoConnection = {
  transport: "usb" | "classic";
  target: string;
  name: string;
};

type MotionReading = {
  x: number;
  y: number;
  z: number;
  alpha: number;
  beta: number;
  gamma: number;
};

const irCandidates: IrCandidate[] = powerCandidates.map((item) => ({
  brand: item.brand,
  category: "tv",
  label: item.label,
  code: item.code,
  protocol: item.protocol,
}));

function makeArduinoSketch(board: string, task: string) {
  const header = `// Phone Flipper One local sketch\n// Board: ${board}\n`;
  if (task === "blink") {
    return `${header}\nconst int LED_PIN = LED_BUILTIN;\n\nvoid setup() {\n  pinMode(LED_PIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(LED_PIN, HIGH);\n  delay(500);\n  digitalWrite(LED_PIN, LOW);\n  delay(500);\n}\n`;
  }
  if (task === "analog") {
    return `${header}\nconst int SENSOR_PIN = A0;\n\nvoid setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n  int value = analogRead(SENSOR_PIN);\n  Serial.println(value);\n  delay(100);\n}\n`;
  }
  if (task === "bridge") {
    return `${header}\n// Minimal serial command bridge. Extend only for hardware you own.\n\nvoid setup() {\n  Serial.begin(115200);\n  Serial.println("PFO_READY");\n}\n\nvoid loop() {\n  if (!Serial.available()) return;\n  String command = Serial.readStringUntil('\\n');\n  command.trim();\n  if (command == "PING") Serial.println("PONG");\n  else if (command == "STATUS") Serial.println("OK");\n  else Serial.println("UNKNOWN_COMMAND");\n}\n`;
  }
  return `${header}\nvoid setup() {\n  Serial.begin(115200);\n  Serial.println("PFO_SERIAL_READY");\n}\n\nvoid loop() {\n  while (Serial.available()) {\n    Serial.write(Serial.read());\n  }\n}\n`;
}

const faTime = new Intl.DateTimeFormat("fa-IR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function makeLog(text: string, tone: LogTone = "normal"): LogLine {
  return { text: `[${faTime.format(new Date())}] ${text}`, tone };
}

function downloadFile(name: string, body: string, type = "text/plain;charset=utf-8") {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function decodeRecord(record: NdefRecordLike) {
  if (!record.data) return `${record.recordType} (بدون داده)`;
  try {
    return new TextDecoder().decode(record.data.buffer);
  } catch {
    return `${record.recordType} (${record.data.byteLength} بایت)`;
  }
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<IconName, React.ReactNode> = {
    signal: <><path {...common} d="M5 12a7 7 0 0 1 14 0" /><path {...common} d="M8 12a4 4 0 0 1 8 0" /><path {...common} d="M12 16h.01" /></>,
    bluetooth: <><path {...common} d="m7 7 10 10-5 4V3l5 4L7 17" /><path {...common} d="m7 7 10 10" /></>,
    network: <><path {...common} d="M5 12.5a10 10 0 0 1 14 0" /><path {...common} d="M8 15.5a6 6 0 0 1 8 0" /><path {...common} d="M11 19a2 2 0 0 1 2 0" /></>,
    nfc: <><path {...common} d="M7 5v14" /><path {...common} d="M11 7v10" /><path {...common} d="M15 9v6" /><path {...common} d="M18 6a8 8 0 0 1 0 12" /><path {...common} d="M21 3a12 12 0 0 1 0 18" /></>,
    radio: <><path {...common} d="M4 14a8 8 0 0 1 0-4" /><path {...common} d="M20 10a8 8 0 0 1 0 4" /><path {...common} d="M7 17a4 4 0 0 1 0-10" /><path {...common} d="M17 7a4 4 0 0 1 0 10" /><circle {...common} cx="12" cy="12" r="1.5" /></>,
    spark: <><path {...common} d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z" /><path {...common} d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6L19 16Z" /></>,
    chip: <><rect {...common} x="7" y="7" width="10" height="10" rx="1" /><path {...common} d="M9 2v5m3-5v5m3-5v5M9 17v5m3-5v5m3-5v5M2 9h5m-5 3h5m-5 3h5m10-6h5m-5 3h5m-5 3h5" /></>,
    bolt: <path {...common} d="m13 2-8 12h6l-1 8 8-12h-6l1-8Z" />,
    terminal: <><path {...common} d="m6 8 4 4-4 4" /><path {...common} d="M13 16h5" /></>,
    download: <><path {...common} d="M12 3v12" /><path {...common} d="m8 11 4 4 4-4" /><path {...common} d="M5 21h14" /></>,
    shield: <path {...common} d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />,
    arrow: <><path {...common} d="M5 12h14" /><path {...common} d="m13 6 6 6-6 6" /></>,
    copy: <><rect {...common} x="9" y="9" width="11" height="11" rx="2" /><path {...common} d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
    check: <path {...common} d="m5 12 4 4L19 6" />,
    usb: <><path {...common} d="M12 3v14" /><path {...common} d="m8 7 4-4 4 4" /><path {...common} d="M8 13H5v4" /><path {...common} d="M16 13h3v4" /><circle {...common} cx="5" cy="19" r="1" /><rect {...common} x="18" y="18" width="2" height="2" /></>,
    magnet: <><path {...common} d="M7 3a4 4 0 0 0-4 4v8a5 5 0 0 0 10 0v-2" /><path {...common} d="M17 3a4 4 0 0 1 4 4v8a5 5 0 0 1-10 0v-2" /><path {...common} d="M3 8h4m10 0h4" /></>,
    wave: <><path {...common} d="M3 12h2l2.5-7 4 14L14 9l2 3h5" /></>,
    code: <><path {...common} d="m8 9-3 3 3 3" /><path {...common} d="m16 9 3 3-3 3" /><path {...common} d="m14 5-4 14" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Button({
  children,
  onClick,
  tone = "primary",
  small = false,
  disabled = false,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: "primary" | "ghost" | "danger" | "cyan";
  small?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return <button className={`button button-${tone} ${small ? "button-small" : ""}`} onClick={onClick} disabled={disabled} type={type}>{children}</button>;
}

function Panel({ title, icon, children, className = "" }: { title: string; icon: IconName; children: React.ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <h2 className="panel-title"><span className="panel-icon"><Icon name={icon} size={16} /></span>{title}</h2>
      {children}
    </section>
  );
}

function Terminal({ lines, empty = "هنوز رویدادی ثبت نشده است." }: { lines: LogLine[]; empty?: string }) {
  return (
    <div className="terminal" dir="ltr">
      {lines.length === 0 ? <span className="terminal-dim">{empty}</span> : lines.slice(-9).map((line, index) => <div className={`terminal-line terminal-${line.tone ?? "normal"}`} key={`${line.text}-${index}`}>{line.text}</div>)}
    </div>
  );
}

function Notice({ children, kind = "warning" }: { children: React.ReactNode; kind?: "warning" | "danger" | "info" }) {
  return <div className={`notice notice-${kind}`}><span className="notice-symbol">{kind === "danger" ? "!" : kind === "info" ? "i" : "!"}</span><p>{children}</p></div>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("ir");
  const [category, setCategory] = useState("tv");
  const [brand, setBrand] = useState("Samsung");
  const [irLog, setIrLog] = useState<LogLine[]>([makeLog("کنسول IR آماده است.", "success")]);
  const [manualProtocol, setManualProtocol] = useState("NEC (32-bit)");
  const [manualCode, setManualCode] = useState("");
  const [sweep, setSweep] = useState<{ running: boolean; target: string; index: number }>({ running: false, target: "Power", index: 0 });
  const [irEmitter, setIrEmitter] = useState(false);
  const [irDiscovery, setIrDiscovery] = useState({ running: false, index: 0, confirmed: "" });
  const [bleLog, setBleLog] = useState<LogLine[]>([makeLog("آماده درخواست مجوز Bluetooth Low Energy.", "info")]);
  const [bleDevice, setBleDevice] = useState<BluetoothDeviceLike | null>(null);
  const [gattLog, setGattLog] = useState<LogLine[]>([]);
  const [bleScanDevices, setBleScanDevices] = useState<Array<{ id: string; name: string; rssi?: number }>>([]);
  const [bleScanning, setBleScanning] = useState(false);
  const [pingTarget, setPingTarget] = useState("google.com");
  const [pingLog, setPingLog] = useState<LogLine[]>([makeLog("برای اندازه گیری، یک درخواست HTTP سبک اجرا کنید.", "info")]);
  const [speedResult, setSpeedResult] = useState("");
  const [ipInfo, setIpInfo] = useState<{ ip?: string; loading?: boolean; error?: string }>({});
  const [nfcLog, setNfcLog] = useState<LogLine[]>([makeLog("NFC آماده است. نیازمند Chrome Android و HTTPS.", "info")]);
  const [nfcType, setNfcType] = useState("url");
  const [nfcValue, setNfcValue] = useState("https://example.com");
  const [subLog, setSubLog] = useState<LogLine[]>([makeLog("Bridge هنوز متصل نیست.", "warning")]);
  const [bridgeStatus, setBridgeStatus] = useState("متصل نیست");
  const [usbDevices, setUsbDevices] = useState<UsbArduinoDevice[]>([]);
  const [classicDevices, setClassicDevices] = useState<ClassicBluetoothDevice[]>([]);
  const [arduinoConnection, setArduinoConnection] = useState<ArduinoConnection | null>(null);
  const [arduinoCommand, setArduinoCommand] = useState("PING");
  const [magnetic, setMagnetic] = useState<MagneticReading | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentReading | null>(null);
  const [gps, setGps] = useState<{ lat: number; lon: number; accuracy: number } | null>(null);
  const [motion, setMotion] = useState<MotionReading | null>(null);
  const [sensorsActive, setSensorsActive] = useState(false);
  const [audioFrequency, setAudioFrequency] = useState<{ hz: number; level: number } | null>(null);
  const [audioActive, setAudioActive] = useState(false);
  const [aiInput, setAiInput] = useState("");
  const [chat, setChat] = useState<Array<{ role: "user" | "bot"; text: string }>>([
    { role: "bot", text: "سلام. درباره IR، BLE، NFC، محدودیت های مرورگر یا اتصال ESP32 از من بپرسید." },
  ]);
  const [copied, setCopied] = useState(false);
  const [arduinoBoard, setArduinoBoard] = useState("ESP32 DevKit");
  const [arduinoTask, setArduinoTask] = useState("serial");
  const [generatedSketch, setGeneratedSketch] = useState("");
  const [sketchCopied, setSketchCopied] = useState(false);
  const [networkNow, setNetworkNow] = useState(navigator.onLine);

  const sensorListeners = useRef<Array<{ remove: () => Promise<void> }>>([]);
  const audioMonitor = useRef<{ context: AudioContext; stream: MediaStream; frame: number } | null>(null);
  const serialListeners = useRef<Array<{ remove: () => Promise<void> }>>([]);

  const browser = navigator as BrowserNavigator;
  const connection = browser.connection;
  const brands = brandsByCategory[category];
  const flatSweepBrands = useMemo(() => Object.values(brandsByCategory).flat(), []);
  const discoveryCandidates = useMemo(() => irCandidates.filter((item) => item.category === category), [category]);

  useEffect(() => {
    const updateNetwork = () => setNetworkNow(navigator.onLine);
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    return () => {
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
    };
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void Infrared.hasEmitter()
      .then(({ available }) => setIrEmitter(available))
      .catch(() => setIrEmitter(false));
  }, []);

  useEffect(() => {
    return () => {
      for (const listener of sensorListeners.current) void listener.remove();
      for (const listener of serialListeners.current) void listener.remove();
      if (audioMonitor.current) {
        window.cancelAnimationFrame(audioMonitor.current.frame);
        audioMonitor.current.stream.getTracks().forEach((track) => track.stop());
        void audioMonitor.current.context.close();
      }
    };
  }, []);

  useEffect(() => {
    if (!sweep.running) return undefined;
    if (sweep.index >= flatSweepBrands.length) {
      setIrLog((lines) => [...lines, makeLog(`اسکن ${sweep.target} تمام شد.`, "success")]);
      setSweep((current) => ({ ...current, running: false }));
      return undefined;
    }
    const currentBrand = flatSweepBrands[sweep.index];
    const keyMap = irKeyMaps[currentBrand];
    const sweepKey = sweep.target === "Power" ? "POWER" : "MUTE";
    if ((irEmitter || arduinoConnection) && keyMap?.keys[sweepKey]) {
      void dispatchIrCandidate({ brand: currentBrand, category: "tv", label: `${currentBrand} ${sweepKey}`, code: keyMap.keys[sweepKey], protocol: keyMap.protocol }, true);
    } else {
      const candidate = powerCandidates.find((item) => item.brand === currentBrand);
      if ((irEmitter || arduinoConnection) && candidate && sweepKey === "POWER") {
        void dispatchIrCandidate({ brand: currentBrand, category: "tv", label: candidate.label, code: candidate.code, protocol: candidate.protocol }, true);
      } else {
        setIrLog((lines) => [...lines, makeLog(`${sweep.target} -> ${currentBrand} (کد تاییدشده یا سخت افزار موجود نیست)`, "info")]);
      }
    }
    const timeout = window.setTimeout(() => setSweep((current) => ({ ...current, index: current.index + 1 })), 900);
    return () => window.clearTimeout(timeout);
  }, [flatSweepBrands, sweep.index, sweep.running, sweep.target]);

  useEffect(() => {
    if (!irDiscovery.running) return undefined;
    if (irDiscovery.index >= discoveryCandidates.length) {
      setIrDiscovery((current) => ({ ...current, running: false }));
      setIrLog((lines) => [...lines, makeLog("چرخه شناسایی تمام شد. نتیجه را در صورت مشاهده ثبت کنید.", "warning")]);
      return undefined;
    }
    const candidate = discoveryCandidates[irDiscovery.index];
    void dispatchIrCandidate(candidate, true);
    const timeout = window.setTimeout(() => {
      setIrDiscovery((current) => ({ ...current, index: current.index + 1 }));
    }, 1800);
    return () => window.clearTimeout(timeout);
  }, [discoveryCandidates, irDiscovery.index, irDiscovery.running]);

  function chooseCategory(next: string) {
    setCategory(next);
    setBrand(brandsByCategory[next][0]);
  }

  function sendRemoteKey(key: string) {
    const keyMap = irKeyMaps[brand];
    if (keyMap?.keys[key]) {
      void dispatchIrCandidate({ brand, category, label: `${brand} ${key}`, code: keyMap.keys[key], protocol: keyMap.protocol }, false);
      return;
    }
    const profile = irCandidates.find((candidate) => candidate.brand === brand && candidate.category === category);
    if (key === "POWER" && profile) {
      void dispatchIrCandidate(profile, false);
      return;
    }
    setIrLog((lines) => [...lines, makeLog(`${brand} / ${key}: کد عمومی تاییدشده ای برای این کلید ثبت نشده است.`, "warning")]);
  }

  function startSweep(target: string) {
    if (sweep.running) return;
    setIrLog((lines) => [...lines, makeLog(`اسکن ترتیبی ${target} آغاز شد.`, "warning")]);
    setSweep({ running: true, target, index: 0 });
  }

  function sendManualCode() {
    const safeCode = manualCode.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{4,16}$/.test(safeCode)) {
      setIrLog((lines) => [...lines, makeLog("کد Hex باید بین 4 تا 16 کاراکتر معتبر باشد.", "error")]);
      return;
    }
    const protocol: IrProtocol = manualProtocol.startsWith("Samsung") ? "samsung" : manualProtocol.startsWith("Sony") ? "sirc12" : "nec";
    void dispatchIrCandidate({ brand: "Manual", category, label: `Manual ${protocol.toUpperCase()}`, code: safeCode.toUpperCase(), protocol }, false);
  }

  async function sendArduinoLine(line: string) {
    if (!arduinoConnection) throw new Error("هیچ Arduino Bridge متصل نیست.");
    const data = `${line.trim()}\n`;
    if (arduinoConnection.transport === "usb") {
      await ArduinoUsb.write({ data });
      return;
    }
    await BluetoothSerial.write({ address: arduinoConnection.target, value: data });
  }

  async function dispatchIrCandidate(candidate: IrCandidate, discoveryMode: boolean) {
    const prefix = discoveryMode ? "شناسایی" : "ارسال";
    try {
      if (irEmitter) {
        const { carrier, pattern } = encodeIr(candidate.protocol, candidate.code);
        await Infrared.transmit({ carrierFrequency: carrier, pattern });
        if (navigator.vibrate) navigator.vibrate(30);
        setIrLog((lines) => [...lines, makeLog(`${prefix}: ${candidate.label} (${candidate.protocol.toUpperCase()}) با IR داخلی ارسال شد.`, "success")]);
        return;
      }
      if (arduinoConnection) {
        await sendArduinoLine(`IR ${candidate.protocol.toUpperCase()} ${candidate.code}`);
        setIrLog((lines) => [...lines, makeLog(`${prefix}: ${candidate.label} به Bridge ارسال شد.`, "success")]);
        return;
      }
      setIrLog((lines) => [...lines, makeLog(`${prefix}: سخت افزار IR داخلی یا Arduino Bridge در دسترس نیست.`, "error")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ارسال IR ناموفق بود";
      setIrLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  function startIrDiscovery() {
    if (discoveryCandidates.length === 0) {
      setIrLog((lines) => [...lines, makeLog("برای این نوع دستگاه، پروفایل شناسایی محلی وجود ندارد.", "warning")]);
      return;
    }
    if (!irEmitter && !arduinoConnection) {
      setIrLog((lines) => [...lines, makeLog("برای شناسایی خودکار به فرستنده IR داخلی یا Arduino IR Bridge نیاز دارید.", "error")]);
      return;
    }
    setIrLog((lines) => [...lines, makeLog("شناسایی خودکار برای دستگاهی که مالک آن هستید آغاز شد. با مشاهده پاسخ، گزینه تایید را بزنید.", "warning")]);
    setIrDiscovery({ running: true, index: 0, confirmed: "" });
  }

  function confirmIrCandidate() {
    const candidate = discoveryCandidates[Math.min(irDiscovery.index, discoveryCandidates.length - 1)];
    if (!candidate) return;
    setBrand(candidate.brand);
    setIrDiscovery({ running: false, index: irDiscovery.index, confirmed: candidate.label });
    setIrLog((lines) => [...lines, makeLog(`پروفایل تایید شد: ${candidate.label}`, "success")]);
  }

  function exportIr() {
    const body = [
      "Filetype: IR signals file",
      "Version: 1",
      "# Phone Flipper One export",
      `name: ${brand}_${category}_profile`,
      "type: parsed",
      "protocol: NEC",
      "address: 00 00 00 00",
      "command: 00 00 00 00",
      "# Add verified codes for equipment you own before use.",
    ].join("\n");
    downloadFile(`${brand.toLowerCase()}-${category}.ir`, body);
    setIrLog((lines) => [...lines, makeLog("قالب Flipper IR دانلود شد.", "success")]);
  }

  async function requestBleDevice() {
    if (Capacitor.isNativePlatform()) {
      try {
        await BleClient.initialize({ androidNeverForLocation: true });
        const enabled = await BleClient.isEnabled();
        if (!enabled) await BleClient.requestEnable();
        const device = await BleClient.requestDevice({});
        setBleDevice({ id: device.deviceId, name: device.name || "دستگاه BLE", native: true });
        setBleLog((lines) => [...lines, makeLog(`دستگاه BLE انتخاب شد: ${device.name || device.deviceId}`, "success")]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "درخواست BLE لغو شد";
        setBleLog((lines) => [...lines, makeLog(`BLE: ${message}`, "warning")]);
      }
      return;
    }
    if (!browser.bluetooth) {
      setBleLog((lines) => [...lines, makeLog("Web Bluetooth در این مرورگر در دسترس نیست.", "error")]);
      return;
    }
    try {
      setBleLog((lines) => [...lines, makeLog("پنجره انتخاب دستگاه باز شد.", "info")]);
      const device = await browser.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ["battery_service", "device_information", 0x1800, 0x1801],
      });
      setBleDevice(device);
      setBleLog((lines) => [...lines, makeLog(`دستگاه انتخاب شد: ${device.name || "بدون نام"}`, "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "درخواست لغو شد";
      setBleLog((lines) => [...lines, makeLog(`BLE: ${message}`, "warning")]);
    }
  }

  async function exploreGatt() {
    if (bleDevice?.native) {
      try {
        setGattLog([makeLog("در حال اتصال و خواندن سرویس های BLE...", "info")]);
        await BleClient.connect(bleDevice.id);
        const services = await BleClient.getServices(bleDevice.id);
        setGattLog([
          makeLog(`${services.length} سرویس BLE پیدا شد.`, "success"),
          ...services.map((service) => makeLog(`service: ${service.uuid}`, "info")),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "کاوش BLE ناموفق بود";
        setGattLog((lines) => [...lines, makeLog(message, "error")]);
      }
      return;
    }
    if (!bleDevice?.gatt) {
      setGattLog([makeLog("این دستگاه سرویس GATT در دسترس ندارد.", "error")]);
      return;
    }
    try {
      setGattLog([makeLog("در حال اتصال به GATT...", "info")]);
      const server = bleDevice.gatt.connected ? bleDevice.gatt : await bleDevice.gatt.connect();
      if ("getPrimaryServices" in server) {
        const services = await server.getPrimaryServices();
        setGattLog([
          makeLog(`${services.length} سرویس اصلی پیدا شد.`, "success"),
          ...services.map((service) => makeLog(`service: ${service.uuid}`, "info")),
        ]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "اتصال GATT ناموفق بود";
      setGattLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function startBleScan() {
    if (!Capacitor.isNativePlatform()) {
      setBleLog((lines) => [...lines, makeLog("در وب استاندارد، انتخابگر امن دستگاه جایگزین اسکن آزاد BLE است.", "warning")]);
      return;
    }
    try {
      await BleClient.initialize({ androidNeverForLocation: true });
      const enabled = await BleClient.isEnabled();
      if (!enabled) await BleClient.requestEnable();
      setBleScanDevices([]);
      setBleScanning(true);
      await BleClient.requestLEScan({}, (result) => {
        setBleScanDevices((devices) => {
          const next = { id: result.device.deviceId, name: result.localName || result.device.name || "بدون نام", rssi: result.rssi };
          const previous = devices.findIndex((device) => device.id === next.id);
          if (previous === -1) return [...devices, next];
          return devices.map((device, index) => index === previous ? next : device);
        });
      });
      setBleLog((lines) => [...lines, makeLog("اسکن BLE بومی فعال شد.", "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "اسکن BLE فعال نشد";
      setBleScanning(false);
      setBleLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function stopBleScan() {
    if (!bleScanning || !Capacitor.isNativePlatform()) return;
    try {
      await BleClient.stopLEScan();
      setBleLog((lines) => [...lines, makeLog("اسکن BLE متوقف شد.", "info")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "توقف اسکن ناموفق بود";
      setBleLog((lines) => [...lines, makeLog(message, "warning")]);
    } finally {
      setBleScanning(false);
    }
  }

  async function runPing() {
    const host = pingTarget.trim().replace(/^https?:\/\//, "").replace(/\/.+$/, "");
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
      setPingLog((lines) => [...lines, makeLog("یک نام دامنه معتبر وارد کنید.", "error")]);
      return;
    }
    const started = performance.now();
    setPingLog((lines) => [...lines, makeLog(`HTTP probe -> ${host}`, "info")]);
    try {
      await fetch(`https://${host}/favicon.ico?probe=${Date.now()}`, { mode: "no-cors", cache: "no-store" });
      const elapsed = Math.round(performance.now() - started);
      setPingLog((lines) => [...lines, makeLog(`پاسخ شبکه: ${elapsed} ms (HTTP، نه ICMP)`, "success")]);
    } catch {
      setPingLog((lines) => [...lines, makeLog("درخواست HTTP به مقصد نرسید یا توسط شبکه مسدود شد.", "error")]);
    }
  }

  async function testSpeed() {
    const started = performance.now();
    setSpeedResult("در حال دریافت نمونه 1MB...");
    try {
      const response = await fetch(`https://speed.cloudflare.com/__down?bytes=1000000&cache=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Speed endpoint unavailable");
      const data = await response.arrayBuffer();
      const seconds = (performance.now() - started) / 1000;
      const mbps = ((data.byteLength * 8) / 1_000_000 / seconds).toFixed(1);
      setSpeedResult(`${mbps} Mbps - سنجش تقریبی با نمونه ${Math.round(data.byteLength / 1000)}KB`);
    } catch {
      const fallback = connection?.downlink ? `${connection.downlink} Mbps طبق تخمین مرورگر` : "سنجش در این شبکه در دسترس نبود.";
      setSpeedResult(fallback);
    }
  }

  async function checkIp() {
    setIpInfo({ loading: true });
    try {
      const response = await fetch("https://api64.ipify.org?format=json", { cache: "no-store" });
      const data = (await response.json()) as { ip?: string };
      setIpInfo({ ip: data.ip || "نامشخص" });
    } catch {
      setIpInfo({ error: "IP عمومی قابل دریافت نبود." });
    }
  }

  function buildNfcPayload() {
    if (nfcType === "wifi") return `WIFI:T:WPA;S:${nfcValue};P:;H:false;;`;
    if (nfcType === "vcard") return `BEGIN:VCARD\nVERSION:3.0\nFN:${nfcValue}\nEND:VCARD`;
    return nfcValue;
  }

  async function startNativeNfcScan() {
    try {
      const status = await NfcNative.isAvailable();
      if (!status.available) throw new Error("این گوشی سخت افزار NFC ندارد.");
      if (!status.enabled) throw new Error("NFC خاموش است. آن را در تنظیمات اندروید فعال کنید.");
      const listener = await NfcNative.addListener("tagRead", (event) => {
        if (navigator.vibrate) navigator.vibrate(60);
        const writeResult = event.writeResult;
        if (writeResult) {
          setNfcLog((lines) => [...lines, makeLog(`Tag ${event.uid}: write ${writeResult}`, writeResult.startsWith("ok") ? "success" : "error")]);
          return;
        }
        const detail = event.records?.length ? event.records.join(" | ") : `tech: ${event.techList.join(", ")}`;
        setNfcLog((lines) => [...lines, makeLog(`Tag ${event.uid}: ${detail}`, "success")]);
      });
      serialListeners.current.push(listener);
      await NfcNative.startScan();
      setNfcLog((lines) => [...lines, makeLog("خوانش NFC بومی فعال شد. تگ را نزدیک کنید (UID + NDEF خوانده می شود).", "info")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "خوانش NFC آغاز نشد";
      setNfcLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function readNfc() {
    if (Capacitor.isNativePlatform()) {
      await startNativeNfcScan();
      return;
    }
    const Reader = (window as NdefWindow).NDEFReader;
    if (!Reader) {
      setNfcLog((lines) => [...lines, makeLog("Web NFC در این مرورگر موجود نیست.", "error")]);
      return;
    }
    try {
      const reader = new Reader();
      reader.onreading = (event) => {
        const records = event.message.records.map((record) => `${record.recordType}: ${decodeRecord(record)}`).join(" | ");
        setNfcLog((lines) => [...lines, makeLog(`Tag ${event.serialNumber || "بدون سریال"}: ${records}`, "success")]);
      };
      reader.onreadingerror = () => setNfcLog((lines) => [...lines, makeLog("تگ قابل خواندن نبود.", "error")]);
      await reader.scan();
      setNfcLog((lines) => [...lines, makeLog("خوانش فعال است. تگ NDEF را نزدیک کنید.", "info")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "خوانش NFC آغاز نشد";
      setNfcLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function writeNfc() {
    const payload = buildNfcPayload().trim();
    if (!payload) {
      setNfcLog((lines) => [...lines, makeLog("برای نوشتن، یک مقدار وارد کنید.", "warning")]);
      return;
    }
    if (Capacitor.isNativePlatform()) {
      try {
        await NfcNative.queueWrite(nfcType === "url" ? { uri: payload } : { text: payload });
        await startNativeNfcScan();
        setNfcLog((lines) => [...lines, makeLog("آماده نوشتن: تگ NDEF را نزدیک گوشی نگه دارید.", "warning")]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "نوشتن NFC آماده نشد";
        setNfcLog((lines) => [...lines, makeLog(message, "error")]);
      }
      return;
    }
    const Reader = (window as NdefWindow).NDEFReader;
    if (!Reader) {
      setNfcLog((lines) => [...lines, makeLog("Web NFC در این مرورگر موجود نیست.", "error")]);
      return;
    }
    try {
      await new Reader().write(payload);
      setNfcLog((lines) => [...lines, makeLog("داده روی تگ NDEF نوشته شد.", "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "نوشتن NFC ناموفق بود";
      setNfcLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  function exportNfc() {
    const body = ["Filetype: Flipper NFC device", "Version: 4", "# NDEF payload exported by Phone Flipper One", `Payload: ${buildNfcPayload()}`].join("\n");
    downloadFile("phone-flipper-ndef.nfc", body);
    setNfcLog((lines) => [...lines, makeLog("قالب NFC دانلود شد.", "success")]);
  }

  async function connectBridgeBle() {
    try {
      await requestBleDevice();
      setBridgeStatus("BLE: دستگاه از انتخابگر امن انتخاب شد");
      setSubLog((lines) => [...lines, makeLog("برای Bridge BLE، سرویس و characteristic اختصاصی برد را در تب بلوتوث بررسی کنید.", "info")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "اتصال لغو شد";
      setSubLog((lines) => [...lines, makeLog(message, "warning")]);
    }
  }

  async function listUsbArduinoDevices() {
    if (!Capacitor.isNativePlatform()) {
      setSubLog((lines) => [...lines, makeLog("فهرست USB-OTG در APK اندروید در دسترس است. در وب از Chrome Desktop استفاده کنید.", "warning")]);
      return;
    }
    try {
      const { devices } = await ArduinoUsb.listDevices();
      setUsbDevices(devices);
      setSubLog((lines) => [...lines, makeLog(`${devices.length} دستگاه USB serial شناسایی شد.`, devices.length ? "success" : "warning")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "فهرست USB قابل دریافت نبود";
      setSubLog((lines) => [...lines, makeLog(message, "warning")]);
    }
  }

  async function connectUsbArduino(device: UsbArduinoDevice) {
    try {
      const result = await ArduinoUsb.connect({ deviceId: device.deviceId, baudRate: 115200 });
      const listener = await ArduinoUsb.addListener("serialData", ({ data }) => {
        setSubLog((lines) => [...lines, makeLog(`USB << ${data.trim()}`, "info")]);
      });
      serialListeners.current.push(listener);
      setArduinoConnection({ transport: "usb", target: String(device.deviceId), name: result.deviceName });
      setBridgeStatus(`USB-OTG: ${result.deviceName}`);
      setSubLog((lines) => [...lines, makeLog("Arduino USB در 115200 baud متصل شد.", "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "اتصال USB ناموفق بود";
      setSubLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function scanClassicArduino() {
    if (!Capacitor.isNativePlatform()) {
      setSubLog((lines) => [...lines, makeLog("Bluetooth Serial برای APK اندروید طراحی شده است.", "warning")]);
      return;
    }
    try {
      const status = await BluetoothSerial.isEnabled();
      if (!status.enabled) await BluetoothSerial.enable();
      const { devices } = await BluetoothSerial.scan();
      setClassicDevices(devices);
      setSubLog((lines) => [...lines, makeLog(`${devices.length} دستگاه Bluetooth Classic پیدا شد.`, "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "اسکن Bluetooth Classic ناموفق بود";
      setSubLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function connectClassicArduino(device: ClassicBluetoothDevice) {
    try {
      await BluetoothSerial.connect({ address: device.address });
      const listener = await BluetoothSerial.addListener("onRead", ({ value }) => {
        setSubLog((lines) => [...lines, makeLog(`BT << ${value.trim()}`, "info")]);
      });
      serialListeners.current.push(listener);
      setArduinoConnection({ transport: "classic", target: device.address, name: device.name || device.address });
      setBridgeStatus(`Bluetooth Classic: ${device.name || device.address}`);
      setSubLog((lines) => [...lines, makeLog("Arduino Bluetooth Serial متصل شد.", "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "اتصال Bluetooth Classic ناموفق بود";
      setSubLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function sendArduinoCommand() {
    try {
      await sendArduinoLine(arduinoCommand);
      setSubLog((lines) => [...lines, makeLog(`>> ${arduinoCommand.trim()}`, "success")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ارسال فرمان ناموفق بود";
      setSubLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function disconnectArduino() {
    try {
      if (arduinoConnection?.transport === "usb") await ArduinoUsb.disconnect();
      if (arduinoConnection?.transport === "classic") await BluetoothSerial.disconnect({ address: arduinoConnection.target });
      for (const listener of serialListeners.current.splice(0)) await listener.remove();
      setArduinoConnection(null);
      setBridgeStatus("متصل نیست");
      setSubLog((lines) => [...lines, makeLog("Bridge قطع شد.", "warning")]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "قطع اتصال ناموفق بود";
      setSubLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function startSensorMonitor() {
    if (sensorsActive) return;
    try {
      const motionPermission = DeviceMotionEvent as typeof DeviceMotionEvent & { requestPermission?: () => Promise<"granted" | "denied"> };
      if (typeof motionPermission.requestPermission === "function") {
        const permission = await motionPermission.requestPermission();
        if (permission !== "granted") throw new Error("مجوز حسگرهای حرکت داده نشد.");
      }
      const accelListener = await Motion.addListener("accel", (event) => {
        setMotion((current) => ({
          x: event.accelerationIncludingGravity.x,
          y: event.accelerationIncludingGravity.y,
          z: event.accelerationIncludingGravity.z,
          alpha: current?.alpha ?? 0,
          beta: current?.beta ?? 0,
          gamma: current?.gamma ?? 0,
        }));
      });
      const orientationListener = await Motion.addListener("orientation", (event) => {
        setMotion((current) => ({
          x: current?.x ?? 0,
          y: current?.y ?? 0,
          z: current?.z ?? 0,
          alpha: event.alpha,
          beta: event.beta,
          gamma: event.gamma,
        }));
      });
      sensorListeners.current.push(accelListener, orientationListener);
      if (Capacitor.isNativePlatform()) {
        const availability = await PhoneSensors.isMagnetometerAvailable();
        if (availability.available) {
          const magneticListener = await PhoneSensors.addListener("magneticReading", setMagnetic);
          const environmentListener = await PhoneSensors.addListener("environmentReading", setEnvironment);
          sensorListeners.current.push(magneticListener, environmentListener);
          await PhoneSensors.startMagnetometer();
        }
      }
      setSensorsActive(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "حسگرها فعال نشدند";
      setSubLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  async function stopSensorMonitor() {
    for (const listener of sensorListeners.current.splice(0)) await listener.remove();
    if (Capacitor.isNativePlatform()) {
      try { await PhoneSensors.stopMagnetometer(); } catch { /* Sensor may not exist on this model. */ }
    }
    setSensorsActive(false);
  }

  async function startAudioMonitor() {
    if (audioActive) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const sample = () => {
        analyser.getByteFrequencyData(bins);
        let peakIndex = 1;
        let peakValue = 0;
        for (let index = 1; index < bins.length; index += 1) {
          if (bins[index] > peakValue) {
            peakValue = bins[index];
            peakIndex = index;
          }
        }
        setAudioFrequency({ hz: Math.round((peakIndex * context.sampleRate) / analyser.fftSize), level: Math.round((peakValue / 255) * 100) });
        if (audioMonitor.current) audioMonitor.current.frame = window.requestAnimationFrame(sample);
      };
      audioMonitor.current = { context, stream, frame: window.requestAnimationFrame(sample) };
      setAudioActive(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "مجوز میکروفون برای تحلیل صوتی داده نشد";
      setSubLog((lines) => [...lines, makeLog(message, "error")]);
    }
  }

  function locateGps() {
    if (!navigator.geolocation) {
      setSubLog((lines) => [...lines, makeLog("Geolocation در این محیط موجود نیست.", "error")]);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => setGps({ lat: position.coords.latitude, lon: position.coords.longitude, accuracy: Math.round(position.coords.accuracy) }),
      (error) => setSubLog((lines) => [...lines, makeLog(`GPS: ${error.message}`, "error")]),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  async function stopAudioMonitor() {
    if (!audioMonitor.current) return;
    window.cancelAnimationFrame(audioMonitor.current.frame);
    audioMonitor.current.stream.getTracks().forEach((track) => track.stop());
    await audioMonitor.current.context.close();
    audioMonitor.current = null;
    setAudioActive(false);
    setAudioFrequency(null);
  }

  async function copyFirmware() {
    try {
      await navigator.clipboard.writeText(firmware);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setSubLog((lines) => [...lines, makeLog("مرورگر اجازه کپی خودکار نداد.", "warning")]);
    }
  }

  function generateArduinoSketch() {
    const sketch = makeArduinoSketch(arduinoBoard, arduinoTask);
    setGeneratedSketch(sketch);
    setChat((messages) => [...messages, { role: "bot", text: `${arduinoBoard}: یک نمونه ${arduinoTask} محلی تولید شد. قبل از آپلود، پایه ها و کتابخانه های برد خودتان را بررسی کنید.` }]);
  }

  async function copyGeneratedSketch() {
    if (!generatedSketch) return;
    try {
      await navigator.clipboard.writeText(generatedSketch);
      setSketchCopied(true);
      window.setTimeout(() => setSketchCopied(false), 1600);
    } catch {
      setChat((messages) => [...messages, { role: "bot", text: "مرورگر اجازه کپی خودکار نداد. کد را دستی از کادر انتخاب کنید." }]);
    }
  }

  function answerQuestion(question: string) {
    const normalized = question.toLowerCase();
    if (normalized.includes("ble") || normalized.includes("بلوتوث")) return "Web Bluetooth فقط دستگاه هایی را پس از انتخاب کاربر نشان می دهد. برای دیدن سرویس ها باید UUID آن ها در optionalServices مجاز شده باشد.";
    if (normalized.includes("nfc")) return "Web NFC فقط روی زمینه امن HTTPS و عمدتا در Chrome Android کار می کند. تگ های NDEF برای خواندن و نوشتن مناسب هستند.";
    if (normalized.includes("ir") || normalized.includes("مادون")) return "مرورگر دسترسی مستقیم به فرستنده IR گوشی ندارد. این بخش پروفایل، لاگ و فایل قالب را مدیریت می کند؛ برای ارسال واقعی به سخت افزار سازگار نیاز دارید.";
    if (normalized.includes("wifi") || normalized.includes("وای فای") || normalized.includes("شبکه")) return "مرورگر نمی تواند فهرست شبکه های Wi-Fi اطراف را بخواند. Network Information API فقط یک تخمین از اتصال فعلی می دهد.";
    if (normalized.includes("esp") || normalized.includes("cc1101") || normalized.includes("sub")) return "Bridge باید ابتدا از طریق Web Bluetooth یا Web Serial انتخاب شود. سیم کشی را با 3.3V انجام دهید و فقط روی تجهیزات و فرکانس های مجاز خودتان آزمایش کنید.";
    return "سوال را با نام فناوری بپرسید: IR، BLE، NFC، شبکه یا ESP32. پاسخ ها بر پایه قابلیت های واقعی مرورگر هستند.";
  }

  function sendQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = aiInput.trim();
    if (!question) return;
    setChat((messages) => [...messages, { role: "user", text: question }, { role: "bot", text: answerQuestion(question) }]);
    setAiInput("");
  }

  const nfcPlaceholder = nfcType === "url" ? "https://example.com" : nfcType === "wifi" ? "نام شبکه Wi-Fi" : nfcType === "vcard" ? "نام کامل" : "متن پیام";

  return (
    <main className="app-shell" dir="rtl">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Icon name="signal" size={22} /></div>
          <div>
            <p className="eyebrow">LOCAL DEVICE CONSOLE</p>
            <h1>Phone Flipper <span>One</span></h1>
          </div>
        </div>
        <div className="topbar-meta">
          <span className="secure-label"><Icon name="shield" size={14} /> Local only</span>
          <span className="version">v3.0 / PRO</span>
        </div>
      </header>

      <div className="system-strip" aria-label="وضعیت قابلیت ها">
        <span className="system-label">SYSTEM</span>
        <StatusItem label="IR" state="ready" />
        <StatusItem label="BLE" state={browser.bluetooth ? "ready" : "limited"} />
        <StatusItem label="NFC" state={(window as NdefWindow).NDEFReader ? "ready" : "limited"} />
        <StatusItem label="NET" state={networkNow ? "ready" : "offline"} />
        <StatusItem label="AUDIO" state="limited" />
      </div>

      <nav className="tabbar" aria-label="بخش های کنسول">
        {tabs.map((tab) => <button className={`tab-button ${activeTab === tab.id ? "tab-active" : ""}`} key={tab.id} onClick={() => setActiveTab(tab.id)}><Icon name={tab.icon} size={15} />{tab.label}</button>)}
      </nav>

      <div className="workspace">
        {activeTab === "ir" && (
          <div className="page-grid ir-layout">
            <div className="content-stack">
              <Panel title="مرکز کنترل مادون قرمز" icon="signal">
                <Notice kind={irEmitter ? "info" : "warning"}>
                  {irEmitter
                    ? "فرستنده IR داخلی گوشی شناسایی شد. کلیدهای ریموت با پروتکل های NEC / Samsung / Sony SIRC به صورت واقعی ارسال می شوند."
                    : "این گوشی فرستنده Consumer IR ندارد (یا نسخه وب اجرا شده است). با اتصال Arduino IR Bridge از تب Sub-GHz، ارسال واقعی فعال می شود."}
                </Notice>
                <div className="field-row field-row-label">
                  <label>نوع دستگاه
                    <select value={category} onChange={(event) => chooseCategory(event.target.value)}>
                      <option value="tv">تلویزیون</option>
                      <option value="ac">کولر گازی</option>
                      <option value="projector">پروژکتور</option>
                      <option value="stb">گیرنده دیجیتال</option>
                      <option value="fan">پنکه</option>
                      <option value="audio">سینما خانگی</option>
                    </select>
                  </label>
                </div>
                <p className="field-hint">برند دستگاه را انتخاب کنید</p>
                <div className="brand-grid">
                  {brands.map((item) => <button key={item} className={`brand-button ${brand === item ? "brand-active" : ""}`} onClick={() => setBrand(item)}>{item}</button>)}
                </div>
              </Panel>

              <Panel title={`ریموت ${brand}`} icon="terminal" className="remote-panel">
                <div className="remote-summary"><span>پروفایل فعال</span><b>{category.toUpperCase()} / {brand}</b></div>
                <div className="remote-pad">
                  {remoteKeys.map((key) => <button key={key.value} className={`remote-key remote-${key.kind}`} onClick={() => sendRemoteKey(key.value)}>{key.label}</button>)}
                </div>
                <p className="status-line"><i className="status-dot" />{irEmitter ? "ارسال واقعی با IR داخلی فعال است" : arduinoConnection ? `ارسال از طریق ${arduinoConnection.name}` : "برای ارسال واقعی: IR داخلی یا Arduino Bridge"}</p>
              </Panel>
            </div>

            <aside className="side-stack">
              <Panel title="شناسایی خودکار کد IR" icon="spark">
                <p className="muted-copy">برای دستگاه متعلق به خودتان، کدهای Power پروفایل انتخابی را با فاصله امن آزمایش می کند. دستگاه باید IR داخلی داشته باشد یا یک Arduino IR Bridge متصل باشد.</p>
                <div className="action-line"><Button onClick={startIrDiscovery} disabled={irDiscovery.running}><Icon name="spark" size={15} /> شروع شناسایی</Button><span className="support-note">{irEmitter ? "IR داخلی آماده" : arduinoConnection ? "Arduino IR Bridge متصل" : "فرستنده IR موجود نیست"}</span></div>
                <div className="scan-state"><span>{irDiscovery.running ? `${Math.min(irDiscovery.index + 1, discoveryCandidates.length)} از ${discoveryCandidates.length}` : irDiscovery.confirmed || "آماده"}</span><span>{irDiscovery.running ? "IDENTIFYING" : "IDLE"}</span></div>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${irDiscovery.running && discoveryCandidates.length ? ((irDiscovery.index + 1) / discoveryCandidates.length) * 100 : 0}%` }} /></div>
                {irDiscovery.running && <Button tone="ghost" small onClick={confirmIrCandidate}>این کد کار کرد</Button>}
              </Panel>
              <Panel title="اسکنر ترتیبی" icon="bolt">
                <p className="muted-copy">دکمه Power یا Mute را برای برندهای پشتیبانی شده، فقط روی تجهیزات خودتان، به ترتیب بررسی کنید.</p>
                <div className="button-grid">
                  <Button tone="danger" onClick={() => startSweep("Power")} disabled={sweep.running}><Icon name="bolt" size={15} /> اسکن Power</Button>
                  <Button tone="cyan" onClick={() => startSweep("Mute")} disabled={sweep.running}><Icon name="signal" size={15} /> اسکن Mute</Button>
                </div>
                <div className="scan-state"><span>{sweep.running ? `${sweep.target}: ${Math.min(sweep.index + 1, flatSweepBrands.length)} از ${flatSweepBrands.length}` : "اسکن متوقف است"}</span><span>{sweep.running ? "RUNNING" : "IDLE"}</span></div>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${sweep.running ? ((sweep.index + 1) / flatSweepBrands.length) * 100 : 0}%` }} /></div>
              </Panel>

              <Panel title="کد دستی" icon="terminal">
                <div className="manual-grid">
                  <label>پروتکل
                    <select value={manualProtocol} onChange={(event) => setManualProtocol(event.target.value)}>
                      <option>NEC (32-bit)</option><option>Samsung (32-bit)</option><option>Sony SIRC (12-bit)</option><option>RC5 (14-bit)</option><option>RC6 (20-bit)</option>
                    </select>
                  </label>
                  <label>کد Hex
                    <input className="ltr-field" value={manualCode} onChange={(event) => setManualCode(event.target.value)} placeholder="E0E040BF" />
                  </label>
                </div>
                <Button onClick={sendManualCode}><Icon name="arrow" size={15} /> ثبت کد</Button>
              </Panel>

              <Panel title="خروجی سازگار" icon="download">
                <p className="muted-copy">یک قالب .ir بر پایه پروفایل انتخابی دانلود کنید و کدهای تاییدشده تجهیزات خود را به آن اضافه کنید.</p>
                <Button tone="ghost" small onClick={exportIr}><Icon name="download" size={14} /> دانلود .ir</Button>
              </Panel>

              <Panel title="لاگ IR" icon="terminal"><Terminal lines={irLog} /></Panel>
            </aside>
          </div>
        )}

        {activeTab === "ble" && (
          <div className="page-grid two-column">
            <div className="content-stack">
              <Panel title="انتخابگر Bluetooth Low Energy" icon="bluetooth">
                <Notice kind="info">در APK اندروید، اسکن BLE بومی با اجازه کاربر فعال می شود. در نسخه وب، فقط انتخابگر امن مرورگر برای دستگاه انتخابی قابل استفاده است.</Notice>
                <div className="button-grid"><Button onClick={requestBleDevice}><Icon name="bluetooth" size={16} /> انتخاب دستگاه BLE</Button><Button tone={bleScanning ? "danger" : "cyan"} onClick={bleScanning ? stopBleScan : startBleScan}>{bleScanning ? "توقف اسکن" : "اسکن نزدیک"}</Button></div>
                <span className="support-note">{Capacitor.isNativePlatform() ? "BLE Native برای Android APK" : browser.bluetooth ? "Web Bluetooth شناسایی شد" : "Web Bluetooth پشتیبانی نمی شود"}</span>
              </Panel>
              {bleScanDevices.length > 0 && <Panel title="دستگاه های BLE نزدیک" icon="radio"><div className="device-scan-list">{bleScanDevices.map((device) => <button className="scan-device" key={device.id} onClick={() => setBleDevice({ id: device.id, name: device.name, native: true })}><span><b>{device.name}</b><small dir="ltr">{device.id}</small></span><em>{device.rssi ?? "--"} dBm</em></button>)}</div></Panel>}
              <Panel title="دستگاه انتخاب شده" icon="radio">
                {bleDevice ? <div className="device-row"><div><b>{bleDevice.name || "دستگاه بدون نام"}</b><span className="mono">{bleDevice.id}</span></div><span className="live-badge"><i />PERMITTED</span></div> : <div className="empty-state">هنوز دستگاهی انتخاب نشده است.</div>}
              </Panel>
              {bleDevice && <Panel title="کاوش GATT" icon="terminal"><p className="muted-copy">سرویس های قابل دسترس دستگاه انتخاب شده را بخوانید. فقط سرویس هایی که مرورگر اجازه داده است نمایش داده می شوند.</p><Button tone="cyan" small onClick={exploreGatt}>خواندن سرویس ها</Button><div className="panel-gap"><Terminal lines={gattLog} empty="برای کاوش GATT اقدام کنید." /></div></Panel>}
            </div>
            <aside className="side-stack"><Panel title="لاگ بلوتوث" icon="terminal"><Terminal lines={bleLog} /></Panel><Panel title="مرزهای دسترسی" icon="shield"><ul className="plain-list"><li>Classic Bluetooth قابل اسکن در وب نیست.</li><li>iOS از Web Bluetooth پشتیبانی عمومی ندارد.</li><li>دسترسی نیازمند HTTPS و اقدام مستقیم کاربر است.</li></ul></Panel></aside>
          </div>
        )}

        {activeTab === "net" && (
          <div className="page-grid two-column">
            <div className="content-stack">
              <Panel title="اتصال فعلی" icon="network">
                <Notice kind="danger">مرورگر برای حفظ حریم خصوصی اجازه مشاهده فهرست شبکه های Wi-Fi اطراف را نمی دهد. اطلاعات زیر فقط از اتصال فعلی دستگاه برداشت شده است.</Notice>
                <dl className="info-grid"><div><dt>وضعیت</dt><dd className={networkNow ? "value-good" : "value-bad"}>{networkNow ? "متصل" : "آفلاین"}</dd></div><div><dt>نوع موثر</dt><dd>{connection?.effectiveType || "نامشخص"}</dd></div><div><dt>سرعت تخمینی</dt><dd>{connection?.downlink ? `${connection.downlink} Mbps` : "دردسترس نیست"}</dd></div><div><dt>RTT تخمینی</dt><dd>{connection?.rtt ? `${connection.rtt} ms` : "دردسترس نیست"}</dd></div></dl>
              </Panel>
              <Panel title="تاخیر HTTP" icon="bolt"><p className="muted-copy">این تست یک درخواست سبک HTTP است؛ ICMP ping از داخل مرورگر قابل اجرا نیست.</p><div className="input-action"><input className="ltr-field" value={pingTarget} onChange={(event) => setPingTarget(event.target.value)} placeholder="example.com" /><Button onClick={runPing}>اندازه گیری</Button></div><div className="panel-gap"><Terminal lines={pingLog} /></div></Panel>
            </div>
            <aside className="side-stack"><Panel title="سرعت دانلود" icon="download"><p className="muted-copy">نمونه 1MB از یک endpoint عمومی دریافت می شود. نتیجه تخمینی است و آزمون حرفه ای محسوب نمی شود.</p><Button tone="cyan" onClick={testSpeed}>تست سرعت</Button><p className="result-copy">{speedResult || "آماده اجرا"}</p></Panel><Panel title="IP عمومی" icon="network"><p className="muted-copy">برای دریافت IP عمومی، یک درخواست مستقیم به سرویس ipify ارسال می شود.</p><Button tone="ghost" small onClick={checkIp} disabled={ipInfo.loading}>{ipInfo.loading ? "در حال بررسی" : "بررسی IP"}</Button><p className="ip-result" dir="ltr">{ipInfo.ip || ipInfo.error || "---.---.---.---"}</p></Panel></aside>
          </div>
        )}

        {activeTab === "nfc" && (
          <div className="page-grid two-column">
            <div className="content-stack">
              <Panel title="خواننده و نویسنده NFC" icon="nfc"><Notice>Web NFC فقط در زمینه امن HTTPS و عمدتا روی Chrome Android کار می کند. فقط تگ های NDEF را بخوانید یا بنویسید.</Notice><div className="button-grid"><Button onClick={readNfc}><Icon name="nfc" size={16} /> خواندن تگ</Button><Button tone="cyan" onClick={writeNfc}><Icon name="arrow" size={16} /> نوشتن NDEF</Button></div></Panel>
              <Panel title="محتوای نوشتن" icon="terminal"><div className="manual-grid"><label>نوع محتوا<select value={nfcType} onChange={(event) => { setNfcType(event.target.value); setNfcValue(event.target.value === "url" ? "https://example.com" : ""); }}><option value="url">لینک وب</option><option value="text">متن ساده</option><option value="wifi">نام Wi-Fi</option><option value="vcard">نام کارت ویزیت</option></select></label><label>داده<input className={nfcType === "url" ? "ltr-field" : ""} value={nfcValue} onChange={(event) => setNfcValue(event.target.value)} placeholder={nfcPlaceholder} /></label></div><p className="muted-copy">Wi-Fi به صورت یک payload الگو نوشته می شود و رمز عبور در این نسخه ذخیره نمی شود.</p></Panel>
            </div>
            <aside className="side-stack"><Panel title="لاگ NFC" icon="terminal"><Terminal lines={nfcLog} /></Panel><Panel title="خروجی قالب" icon="download"><p className="muted-copy">فایل .nfc خروجی یک قالب NDEF متنی برای آرشیو محلی است.</p><Button tone="ghost" small onClick={exportNfc}><Icon name="download" size={14} /> دانلود .nfc</Button></Panel></aside>
          </div>
        )}

        {activeTab === "sub" && (
          <div className="page-grid two-column">
            <div className="content-stack">
              <Panel title="Arduino و ESP Bridge" icon="radio">
                <Notice kind="danger">گوشی به تنهایی رادیوی عمومی 315/433/868 MHz ندارد. برای کار با تجهیزات آزمایشگاهی خودتان، یک Bridge خارجی لازم است. این برنامه فقط ارتباط USB/Bluetooth و عیب یابی را فراهم می کند.</Notice>
                <div className="button-grid"><Button onClick={connectBridgeBle}><Icon name="bluetooth" size={16} /> انتخاب BLE</Button><Button tone="cyan" onClick={listUsbArduinoDevices}><Icon name="usb" size={16} /> جستجوی USB-OTG</Button></div>
                <p className="bridge-status"><i className="status-dot" />{bridgeStatus}</p>
                {arduinoConnection && <Button tone="ghost" small onClick={disconnectArduino}>قطع اتصال {arduinoConnection.name}</Button>}
              </Panel>

              <Panel title="USB-OTG Arduino" icon="usb">
                <p className="muted-copy">در APK اندروید، پورت های CDC/ACM، FTDI، CP210x و CH34x به کمک USB-OTG شناسایی می شوند. برد را وصل کنید، اجازه سیستم عامل را بدهید، سپس اتصال را انتخاب کنید.</p>
                {usbDevices.length === 0 ? <div className="empty-state">هنوز USB serial شناسایی نشده است.</div> : <div className="device-scan-list">{usbDevices.map((device) => <button className="scan-device" key={device.deviceId} onClick={() => connectUsbArduino(device)}><span><b>{device.driver}</b><small dir="ltr">VID {device.vendorId} / PID {device.productId}</small></span><em>CONNECT</em></button>)}</div>}
              </Panel>

              <Panel title="Arduino Bluetooth Classic" icon="bluetooth">
                <p className="muted-copy">برای ماژول های HC-05 و HC-06 ابتدا برد را در تنظیمات Android pair کنید، سپس اینجا اسکن و اتصال را انجام دهید.</p>
                <Button tone="cyan" small onClick={scanClassicArduino}>اسکن Bluetooth Serial</Button>
                {classicDevices.length > 0 && <div className="device-scan-list panel-gap">{classicDevices.map((device) => <button className="scan-device" key={device.address} onClick={() => connectClassicArduino(device)}><span><b>{device.name || "Bluetooth device"}</b><small dir="ltr">{device.address}</small></span><em>SPP</em></button>)}</div>}
              </Panel>

              <Panel title="ترمینال Arduino" icon="terminal">
                <div className="input-action"><input className="ltr-field" value={arduinoCommand} onChange={(event) => setArduinoCommand(event.target.value)} placeholder="PING" /><Button onClick={sendArduinoCommand} disabled={!arduinoConnection}>ارسال</Button></div>
                <p className="muted-copy">فرمان های Bridge به firmware نصب شده روی برد بستگی دارند. فرمان های پایه نمونه: PING و STATUS.</p>
              </Panel>

              <Panel title="فریم ور تشخیصی ESP32" icon="terminal"><p className="muted-copy">این نمونه Bridge را راه اندازی و با فرمان PING بررسی می کند. شامل ارسال یا دریافت RF نیست.</p><pre className="firmware" dir="ltr">{firmware}</pre><Button tone="ghost" small onClick={copyFirmware}>{copied ? <><Icon name="check" size={14} /> کپی شد</> : <><Icon name="copy" size={14} /> کپی کد</>}</Button></Panel>
            </div>
            <aside className="side-stack"><Panel title="سیم کشی CC1101 به ESP32" icon="chip"><table className="wire-table"><thead><tr><th>CC1101</th><th>ESP32</th><th>کاربرد</th></tr></thead><tbody><tr><td>VCC</td><td>3.3V</td><td>توان</td></tr><tr><td>GND</td><td>GND</td><td>زمین</td></tr><tr><td>CSN</td><td>GPIO 5</td><td>Chip Select</td></tr><tr><td>SCK</td><td>GPIO 18</td><td>SPI Clock</td></tr><tr><td>MOSI</td><td>GPIO 23</td><td>SPI Out</td></tr><tr><td>MISO</td><td>GPIO 19</td><td>SPI In</td></tr><tr><td>GDO0</td><td>GPIO 2</td><td>Data pin</td></tr></tbody></table></Panel><Panel title="لاگ Bridge" icon="terminal"><Terminal lines={subLog} /></Panel></aside>
          </div>
        )}

        {activeTab === "sensors" && (
          <div className="page-grid two-column">
            <div className="content-stack">
              <Panel title="مغناطیس سنج و حرکت" icon="magnet">
                <Notice kind="info">در APK اندروید، میدان مغناطیسی از سنسور داخلی گوشی با واحد microtesla خوانده می شود. داده حرکت و جهت گیری نیز با اجازه شما فعال می شود.</Notice>
                <div className="action-line"><Button onClick={sensorsActive ? stopSensorMonitor : startSensorMonitor}>{sensorsActive ? "توقف حسگرها" : "فعال سازی حسگرها"}</Button><span className="support-note">{Capacitor.isNativePlatform() ? "Android native bridge" : "Browser sensor APIs"}</span></div>
                <div className="sensor-grid">
                  <div className="sensor-stat"><span>Magnetic field</span><b>{magnetic ? `${magnetic.magnitude.toFixed(1)} uT` : "--- uT"}</b><small>{magnetic ? `X ${magnetic.x.toFixed(1)} / Y ${magnetic.y.toFixed(1)} / Z ${magnetic.z.toFixed(1)}` : "منتظر داده سنسور"}</small></div>
                  <div className="sensor-stat"><span>Motion vector</span><b>{motion ? `${motion.x.toFixed(1)}, ${motion.y.toFixed(1)}, ${motion.z.toFixed(1)}` : "---"}</b><small>m/s2 with gravity</small></div>
                  <div className="sensor-stat"><span>Orientation</span><b>{motion ? `${Math.round(motion.alpha)} deg` : "--- deg"}</b><small>{motion ? `beta ${Math.round(motion.beta)} / gamma ${Math.round(motion.gamma)}` : "منتظر داده جهت"}</small></div>
                  <div className="sensor-stat"><span>Ambient light</span><b>{environment && environment.light >= 0 ? `${Math.round(environment.light)} lux` : "--- lux"}</b><small>Android light sensor</small></div>
                  <div className="sensor-stat"><span>Proximity</span><b>{environment && environment.proximity >= 0 ? `${environment.proximity.toFixed(1)} cm` : "--- cm"}</b><small>Android proximity sensor</small></div>
                  <div className="sensor-stat"><span>Pressure</span><b>{environment && environment.pressure >= 0 ? `${environment.pressure.toFixed(1)} hPa` : "--- hPa"}</b><small>Barometer (if present)</small></div>
                </div>
              </Panel>

              <Panel title="موقعیت GPS" icon="network">
                <div className="action-line"><Button tone="cyan" onClick={locateGps}>دریافت موقعیت</Button><span className="frequency-readout" dir="ltr">{gps ? `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)} (±${gps.accuracy}m)` : "NO FIX"}</span></div>
              </Panel>

              <Panel title="تحلیل فرکانس صوتی" icon="wave">
                <Notice>این تحلیلگر، فقط طیف صوتی میکروفون را بررسی می کند و اسکن یا رهگیری فرکانس رادیویی نیست. گوشی معمولی امکان اسکن RF مانند تجهیزات تخصصی را ندارد.</Notice>
                <div className="action-line"><Button tone="cyan" onClick={audioActive ? stopAudioMonitor : startAudioMonitor}>{audioActive ? "توقف میکروفون" : "شروع تحلیل صوت"}</Button><span className="frequency-readout" dir="ltr">{audioFrequency ? `${audioFrequency.hz.toLocaleString()} Hz / ${audioFrequency.level}%` : "NO SIGNAL"}</span></div>
              </Panel>
            </div>
            <aside className="side-stack"><Panel title="مرزهای رادیویی گوشی" icon="radio"><ul className="plain-list"><li>BLE فقط تبلیغات بلوتوث کم مصرف را با مجوز کاربر مشاهده می کند.</li><li>NFC برای تگ های نزدیک و NDEF است، نه کارت های خام یا اسکن فاصله دور.</li><li>ردیابی یا دریافت RF در 315/433/868 MHz به گیرنده خارجی مانند Bridge نیاز دارد.</li><li>سنسور مغناطیسی، میدان محیط نزدیک گوشی را می خواند و جایگزین آشکارساز فرکانس RF نیست.</li></ul></Panel><Panel title="وضعیت سخت افزار" icon="chip"><div className="status-stack"><span><i className={magnetic ? "indicator-good" : "indicator-dim"} />Magnetometer</span><span><i className={sensorsActive ? "indicator-good" : "indicator-dim"} />Motion / orientation</span><span><i className={audioActive ? "indicator-good" : "indicator-dim"} />Microphone spectrum</span><span><i className={irEmitter ? "indicator-good" : "indicator-dim"} />Consumer IR emitter</span></div></Panel></aside>
          </div>
        )}

        {activeTab === "ai" && (
          <div className="assistant-layout">
            <section className="assistant-hero"><div className="assistant-mark"><Icon name="spark" size={28} /></div><p className="eyebrow">LOCAL PROTOCOL GUIDE</p><h2>دستیار Phone Flipper</h2><p>پاسخ های محلی و قابل بررسی درباره قابلیت های واقعی مرورگر و اتصال های مجاز.</p></section>
            <section className="chat-panel"><div className="chat-scroll">{chat.map((message, index) => <div className={`chat-bubble chat-${message.role}`} key={`${message.role}-${index}`}>{message.text}</div>)}</div><form className="chat-form" onSubmit={sendQuestion}><input value={aiInput} onChange={(event) => setAiInput(event.target.value)} placeholder="مثلا: چرا NFC کار نمی کند؟" /><Button type="submit"><Icon name="arrow" size={16} /></Button></form></section>
            <div className="prompt-row"><button onClick={() => setAiInput("Web Bluetooth چه محدودیتی دارد؟")}>محدودیت BLE</button><button onClick={() => setAiInput("Web NFC کجا کار می کند؟")}>راهنمای NFC</button><button onClick={() => setAiInput("چرا Wi-Fiهای اطراف دیده نمی شوند؟")}>شبکه های Wi-Fi</button></div>
            <section className="code-assistant">
              <div><p className="eyebrow">LOCAL SKETCH GENERATOR</p><h3>تولید کد Arduino</h3><p>این مولد محلی نمونه های پایه و قابل بررسی تولید می کند. کامپایل یا آپلود مستقیم جای Arduino IDE را نمی گیرد.</p></div>
              <div className="manual-grid"><label>برد<select value={arduinoBoard} onChange={(event) => setArduinoBoard(event.target.value)}><option>ESP32 DevKit</option><option>Arduino Uno</option><option>Arduino Nano</option><option>RP2040</option></select></label><label>کار<select value={arduinoTask} onChange={(event) => setArduinoTask(event.target.value)}><option value="serial">Serial echo</option><option value="blink">LED blink</option><option value="analog">Analog sensor</option><option value="bridge">Diagnostic bridge</option></select></label></div>
              <Button onClick={generateArduinoSketch}><Icon name="code" size={15} /> تولید Sketch</Button>
              {generatedSketch && <><pre className="firmware generated-sketch" dir="ltr">{generatedSketch}</pre><Button tone="ghost" small onClick={copyGeneratedSketch}>{sketchCopied ? <><Icon name="check" size={14} /> کپی شد</> : <><Icon name="copy" size={14} /> کپی Sketch</>}</Button></>}
            </section>
          </div>
        )}

        {activeTab === "hw" && (
          <div className="hardware-layout">
            <section className="hardware-heading"><p className="eyebrow">CAPABILITY MAP</p><h2>واقعیت سخت افزار و مرورگر</h2><p>هر قابلیت در این کنسول شفاف بیان می شود تا مرز میان رابط وب و سخت افزار فیزیکی مشخص بماند.</p></section>
            <div className="capability-list">
              <Capability icon="signal" title="مادون قرمز" state={irEmitter ? "IR داخلی شناسایی شد" : "IR داخلی ندارد"} detail="در APK، اگر گوشی فرستنده Consumer IR داشته باشد، کدهای NEC محلی برای تجهیزات خودتان قابل ارسال هستند. در سایر گوشی ها Arduino IR Bridge لازم است." />
              <Capability icon="bluetooth" title="Bluetooth Low Energy" state={browser.bluetooth ? "آماده در این مرورگر" : "محدود در این مرورگر"} detail="انتخاب امن دستگاه و کاوش GATT بعد از اجازه صریح کاربر امکان پذیر است." />
              <Capability icon="nfc" title="NFC / NDEF" state={(window as NdefWindow).NDEFReader ? "آماده در این مرورگر" : "نیازمند Chrome Android"} detail="برای خواندن و نوشتن تگ NDEF به HTTPS و سخت افزار سازگار نیاز است." />
              <Capability icon="magnet" title="مغناطیس و حرکت" state={Capacitor.isNativePlatform() ? "Android sensor bridge" : "محدود به مرورگر"} detail="میدان مغناطیسی محیط، شتاب و جهت گیری در تب سنسورها با رضایت کاربر نمایش داده می شوند." />
              <Capability icon="radio" title="Sub-GHz" state="Bridge لازم است" detail="اتصال USB-OTG یا Bluetooth Serial به Arduino و ESP32 ممکن است، اما رادیوی عمومی در گوشی وجود ندارد." />
              <Capability icon="network" title="شبکه" state="فقط اتصال فعلی" detail="نام شبکه های نزدیک قابل خواندن نیست؛ فقط تخمین های مرورگر و آزمون های HTTP وجود دارد." />
            </div>
          </div>
        )}
      </div>

      <footer className="footer"><span>Phone Flipper One</span><span>حریم خصوصی: داده ها تا جای ممکن در همین مرورگر می مانند.</span></footer>
    </main>
  );
}

function StatusItem({ label, state }: { label: string; state: "ready" | "limited" | "offline" }) {
  const copy = state === "ready" ? "آماده" : state === "limited" ? "محدود" : "آفلاین";
  return <span className={`system-item state-${state}`}><i />{label}: {copy}</span>;
}

function Capability({ icon, title, state, detail }: { icon: IconName; title: string; state: string; detail: string }) {
  return <article className="capability"><div className="capability-icon"><Icon name={icon} size={20} /></div><div><div className="capability-title"><h3>{title}</h3><span>{state}</span></div><p>{detail}</p></div></article>;
}