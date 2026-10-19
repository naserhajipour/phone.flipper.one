// Real IR protocol encoders producing microsecond pulse patterns for
// Android ConsumerIrManager.transmit() or an Arduino IR bridge.

export type IrProtocol = "nec" | "samsung" | "sirc12";

export type IrKeyMap = {
  protocol: IrProtocol;
  carrier: number;
  keys: Record<string, string>;
};

// NEC family: 9ms/4.5ms header, 560us mark, 1690us one-space, 560us zero-space.
// Display codes are MSB-first 32-bit values (LIRC style).
function pulseDistancePattern(hex: string, bits: number, headerMark: number, headerSpace: number) {
  const value = BigInt(`0x${hex}`);
  const pattern: number[] = [headerMark, headerSpace];
  for (let bit = bits - 1; bit >= 0; bit -= 1) {
    const one = ((value >> BigInt(bit)) & 1n) === 1n;
    pattern.push(560, one ? 1690 : 560);
  }
  pattern.push(560);
  return pattern;
}

export function necPattern(hex: string) {
  return pulseDistancePattern(hex.padStart(8, "0"), 32, 9000, 4500);
}

export function samsungPattern(hex: string) {
  return pulseDistancePattern(hex.padStart(8, "0"), 32, 4500, 4500);
}

// Sony SIRC-12: 2.4ms header, pulse-width coding, LSB first, repeated 3 times.
export function sirc12Pattern(hex: string) {
  const value = Number.parseInt(hex, 16) & 0xfff;
  const frame: number[] = [2400, 600];
  for (let bit = 0; bit < 12; bit += 1) {
    const one = ((value >> bit) & 1) === 1;
    frame.push(one ? 1200 : 600, 600);
  }
  frame[frame.length - 1] = 600;
  const pattern: number[] = [];
  for (let repeat = 0; repeat < 3; repeat += 1) {
    pattern.push(...frame);
    if (repeat < 2) pattern.push(20000); // inter-frame gap inside the 45ms period
  }
  return pattern;
}

export function encodeIr(protocol: IrProtocol, hex: string): { carrier: number; pattern: number[] } {
  if (protocol === "samsung") return { carrier: 38000, pattern: samsungPattern(hex) };
  if (protocol === "sirc12") return { carrier: 40000, pattern: sirc12Pattern(hex) };
  return { carrier: 38000, pattern: necPattern(hex) };
}

// Verified public key maps for widely used TV remotes.
export const irKeyMaps: Record<string, IrKeyMap> = {
  Samsung: {
    protocol: "samsung",
    carrier: 38000,
    keys: {
      POWER: "E0E040BF", MUTE: "E0E0F00F", INPUT: "E0E0807F",
      "VOL+": "E0E0E01F", "VOL-": "E0E0D02F", "CH+": "E0E048B7", "CH-": "E0E008F7",
      UP: "E0E006F9", DOWN: "E0E08679", LEFT: "E0E0A659", RIGHT: "E0E046B9",
      OK: "E0E016E9", BACK: "E0E01AE5", MENU: "E0E058A7", HOME: "E0E09E61",
    },
  },
  LG: {
    protocol: "nec",
    carrier: 38000,
    keys: {
      POWER: "20DF10EF", MUTE: "20DF906F", INPUT: "20DFD02F",
      "VOL+": "20DF40BF", "VOL-": "20DFC03F", "CH+": "20DF00FF", "CH-": "20DF807F",
      UP: "20DF02FD", DOWN: "20DF827D", LEFT: "20DFE01F", RIGHT: "20DF609F",
      OK: "20DF22DD", BACK: "20DF14EB", MENU: "20DFC23D", HOME: "20DF3EC1",
    },
  },
  Sony: {
    protocol: "sirc12",
    carrier: 40000,
    keys: {
      POWER: "A90", MUTE: "290", INPUT: "A50",
      "VOL+": "490", "VOL-": "C90", "CH+": "090", "CH-": "890",
      UP: "2F0", DOWN: "AF0", LEFT: "2D0", RIGHT: "CD0", OK: "A70", MENU: "070",
    },
  },
};

// Power-only discovery candidates across brands (used by auto-identify and sweep).
export const powerCandidates: Array<{ brand: string; protocol: IrProtocol; code: string; label: string }> = [
  { brand: "Samsung", protocol: "samsung", code: "E0E040BF", label: "Samsung TV Power" },
  { brand: "LG", protocol: "nec", code: "20DF10EF", label: "LG TV Power" },
  { brand: "Sony", protocol: "sirc12", code: "A90", label: "Sony TV Power" },
  { brand: "TCL", protocol: "nec", code: "57E3E817", label: "TCL TV Power" },
  { brand: "Hisense", protocol: "nec", code: "00FDB24D", label: "Hisense TV Power" },
  { brand: "Panasonic", protocol: "nec", code: "40040100", label: "Panasonic TV Power" },
  { brand: "Xiaomi", protocol: "nec", code: "80BF3BC4", label: "Xiaomi TV Power" },
  { brand: "Philips", protocol: "nec", code: "0CF30CF3", label: "Philips TV Power" },
];
