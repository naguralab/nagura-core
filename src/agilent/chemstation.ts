/**
 * Agilent ChemStation data files: `.ch` (single channel), `.uv` (diode-array
 * spectra) and `.ms` (single-quadrupole mass spectra).
 *
 * The byte layouts follow the reverse engineering done by the rainbow project
 * (https://github.com/evanyeyeye/rainbow, LGPL-3.0), which this module ports
 * to TypeScript. See NOTICE.md.
 */
import { BinaryReader } from '../binary.js';
import { ParseError, type Detector, type Signal } from '../types.js';

type HeaderOffsets = Record<string, number>;

/** Header strings at fixed offsets. Empty slots are left out. */
function readHeader(r: BinaryReader, offsets: HeaderOffsets, gap: 1 | 2): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, offset] of Object.entries(offsets)) {
    const value = r.pstring(offset, gap);
    if (value) out[key] = value;
  }
  return out;
}

/** Splits the `unit` header string out of the metadata. */
function takeUnit(metadata: Record<string, string | number>): string {
  const unit = typeof metadata.unit === 'string' ? metadata.unit : '';
  delete metadata.unit;
  return unit;
}

const SIG_RE = /Sig=([\d.]+),([\d.]+)/;
const REF_RE = /Ref=([\d.]+),([\d.]+)/;
const WAVELENGTH_RE = /Wavelength\s*=\s*([\d.]+)/i;

/**
 * The detector a channel's own signal string reports, and its wavelength if
 * it has one. The container version says how the data is encoded, not what
 * measured it: ChemStation writes diode-array and FID channels into the same
 * 179 container, and only the signal string ("DAD1A,Sig=210,4  Ref=off"
 * against "Front Signal") tells them apart.
 *
 * `uvOnly` marks a container that never holds FID data, where any
 * "Wavelength=" or "=" clause is an optical setting.
 */
function detectorFromSignal(
  metadata: Record<string, string | number>,
  fallback: Detector,
  uvOnly: boolean,
): { detector: Detector; wavelength: number } {
  const signal = typeof metadata.signal === 'string' ? metadata.signal : '';
  const sig = SIG_RE.exec(signal);
  if (sig) {
    metadata.wavelength = Number(sig[1]);
    metadata.bandwidth = Number(sig[2]);
    const ref = REF_RE.exec(signal);
    if (ref) {
      metadata.reference_wavelength = Number(ref[1]);
      metadata.reference_bandwidth = Number(ref[2]);
    }
    return { detector: 'UV', wavelength: Number(sig[1]) };
  }
  if (signal.includes('ADC')) {
    return { detector: signal.includes('CHANNEL') ? 'ELSD' : 'CAD', wavelength: NaN };
  }
  if (uvOnly) {
    const wl = WAVELENGTH_RE.exec(signal);
    if (wl) {
      metadata.wavelength = Number(wl[1]);
      return { detector: 'UV', wavelength: Number(wl[1]) };
    }
    if (signal.includes('=')) {
      const wavelength = Number(signal.split('=')[1]!.split(',')[0]);
      return { detector: 'UV', wavelength };
    }
  }
  return { detector: fallback, wavelength: NaN };
}

/** Evenly spaced retention times from the first and last, converted ms -> min. */
function spacedTimes(startMs: number, endMs: number, count: number): Float64Array {
  const times = new Float64Array(count);
  const step = count > 1 ? (endMs - startMs) / (count - 1) : 0;
  for (let i = 0; i < count; i++) times[i] = (startMs + i * step) / 60000;
  return times;
}

function headString(r: BinaryReader): string {
  return r.pstring(0, 1);
}

/* ------------------------------------------------------------------ .ch */

/** Parses a `.ch` single-channel file, or returns null for an unknown version. */
export function parseCh(name: string, bytes: Uint8Array): Signal | null {
  const r = new BinaryReader(bytes);
  const head = headString(r);
  if (head === '179' || head === '181') return parseCh179(name, r, head);
  if (head === '130' || head === '30') return parseCh130(name, r, head);
  return null;
}

/**
 * The 179/181 container: 8-byte samples from 0x1800. Version 179 stores
 * little-endian doubles; 181 stores a double-delta stream. FID is the usual
 * occupant, but the signal string decides.
 */
function parseCh179(name: string, r: BinaryReader, head: string): Signal {
  const dataStart = 0x1800;
  const count = Math.floor((r.length - dataStart) / 8);
  if (count < 1) throw new ParseError('No samples after the header.');

  const startMs = r.f32be(0x116 + 4);
  const endMs = r.f32be(0x116 + 8);
  const scale = r.f64be(0x127c);

  let raw: Float64Array;
  if (head === '181') {
    raw = decodeDoubleDelta(r, dataStart);
  } else {
    raw = new Float64Array(count);
    for (let i = 0; i < count; i++) raw[i] = r.f64le(dataStart + i * 8);
  }
  const data = raw.map((v) => v * scale);
  const times = spacedTimes(startMs, endMs, data.length);

  const offsets: HeaderOffsets = {
    notebook: 0x35a,
    date: 0x957,
    method: 0xa0e,
    instrument: 0xc11,
    unit: 0x104c,
  };
  // The 181 layout has no signal slot, so a 181 file always reads as FID.
  if (head === '179') offsets.signal = 0x1075;
  const metadata: Record<string, string | number> = readHeader(r, offsets, 2);
  const unit = takeUnit(metadata);
  const { detector, wavelength } = detectorFromSignal(metadata, 'FID', false);

  return { name, detector, times, ylabels: Float64Array.of(wavelength), data, unit, metadata };
}

/**
 * Double-delta stream of big-endian shorts: each short is added to a running
 * slope, the slope to the value. 0x7fff escapes to a 48-bit absolute value
 * and resets the slope.
 */
function decodeDoubleDelta(r: BinaryReader, offset: number): Float64Array {
  const out: number[] = [];
  let value = 0;
  let slope = 0;
  let pos = offset;
  while (pos + 2 <= r.length) {
    const d = r.i16be(pos);
    pos += 2;
    if (d === 0x7fff) {
      const hi = r.i16be(pos);
      const lo = r.u32be(pos + 2);
      pos += 6;
      value = hi * 2 ** 32 + lo;
      slope = 0;
    } else {
      slope += d;
      value += slope;
    }
    out.push(value);
  }
  return Float64Array.from(out);
}

/** The 130/30 container: a single-delta stream (CAD, ELSD, UV). */
function parseCh130(name: string, r: BinaryReader, head: string): Signal | null {
  const layout =
    head === '130'
      ? {
          scale: 0x127c,
          dataStart: 0x1800,
          gap: 2 as const,
          offsets: {
            notebook: 0x35a,
            date: 0x957,
            method: 0xa0e,
            instrument: 0xc11,
            unit: 0x104c,
            signal: 0x1075,
          },
        }
      : {
          scale: 0x284,
          dataStart: 0x400,
          gap: 1 as const,
          offsets: {
            notebook: 0x18,
            date: 0xb2,
            method: 0xe4,
            instrument: 0xda,
            unit: 0x244,
            signal: 0x254,
          },
        };

  const raw = decodeDelta(r, layout.dataStart);
  if (raw.length === 0) return null;

  const startMs = r.i32be(0x11a);
  const endMs = r.i32be(0x11e);
  const scale = r.f64be(layout.scale);
  const data = raw.map((v) => v * scale);
  const times = spacedTimes(startMs, endMs, data.length);

  const metadata: Record<string, string | number> = readHeader(r, layout.offsets, layout.gap);
  const unit = takeUnit(metadata);
  const { detector, wavelength } = detectorFromSignal(metadata, null, true);

  return { name, detector, times, ylabels: Float64Array.of(wavelength), data, unit, metadata };
}

/**
 * Segments of `0x10, count` followed by `count` big-endian 16-bit deltas; the
 * delta -0x8000 escapes to a 32-bit absolute value. Any other segment byte,
 * or the end of the file, ends the stream.
 */
function decodeDelta(r: BinaryReader, offset: number): Float64Array {
  const out: number[] = [];
  let acc = 0;
  let pos = offset;
  while (pos + 2 <= r.length && r.u8(pos) === 0x10) {
    const n = r.u8(pos + 1);
    pos += 2;
    for (let i = 0; i < n; i++) {
      if (pos + 2 > r.length) return Float64Array.from(out);
      const d = r.i16be(pos);
      pos += 2;
      if (d === -0x8000) {
        if (pos + 4 > r.length) return Float64Array.from(out);
        acc = r.i32be(pos);
        pos += 4;
      } else {
        acc += d;
      }
      out.push(acc);
    }
  }
  return Float64Array.from(out);
}

/* ------------------------------------------------------------------ .uv */

/** Parses a `.uv` diode-array spectrum file, or returns null if unrecognized. */
export function parseUv(name: string, bytes: Uint8Array): Signal | null {
  const r = new BinaryReader(bytes);
  const head = headString(r);

  let scaleAt: number;
  let dataStart: number;
  let gap: 1 | 2;
  let offsets: HeaderOffsets;
  let doubles = false;

  if (head === '131') {
    scaleAt = 0xc0d;
    dataStart = 0x1000;
    gap = 2;
    offsets = { notebook: 0x35a, date: 0x957, method: 0xa0e, unit: 0xc15, signal: 0xc40, vialpos: 0xfd7 };
    const fileType = r.pstring(347, 2);
    if (fileType.startsWith('OL')) doubles = true;
    else if (!fileType.startsWith('LC')) return null;
  } else if (head === '31') {
    scaleAt = 0x13e;
    dataStart = 0x200;
    gap = 1;
    offsets = { notebook: 0x18, date: 0xb2, method: 0xe4, unit: 0x146 };
  } else {
    return null;
  }

  const wavelengths = uvWavelengths(r, dataStart);
  const numTimes = r.u32be(0x116);

  let times: Float64Array;
  let data: Float64Array;
  if (numTimes === 0) {
    // A partial file (acquisition cut short): read segments until they run out.
    ({ times, data } = decodeUvDelta(r, dataStart, Infinity, wavelengths.length));
  } else if (doubles) {
    ({ times, data } = decodeUvDoubles(r, dataStart, numTimes, wavelengths.length));
  } else {
    ({ times, data } = decodeUvDelta(r, dataStart, numTimes, wavelengths.length));
  }

  const scale = r.f64be(scaleAt);
  for (let i = 0; i < data.length; i++) data[i]! *= scale;

  // Partial files always carry the 131 header layout.
  const metadata: Record<string, string | number> = readHeader(r, offsets, gap);
  const unit = takeUnit(metadata);
  return { name, detector: 'UV', times, ylabels: wavelengths, data, unit, metadata };
}

/** Wavelength range from the first segment header, stored in 1/20 nm. */
function uvWavelengths(r: BinaryReader, dataStart: number): Float64Array {
  const start = Math.floor(r.u16le(dataStart + 8) / 20);
  const end = Math.floor(r.u16le(dataStart + 10) / 20);
  const step = Math.floor(r.u16le(dataStart + 12) / 20);
  if (step <= 0 || end < start) throw new ParseError('Invalid wavelength range.');
  const out: number[] = [];
  for (let wl = start; wl <= end; wl += step) out.push(wl);
  return Float64Array.from(out);
}

/**
 * Each segment: 4 bytes, little-endian u32 time (ms), 14 bytes, then one
 * little-endian 16-bit delta per wavelength against an accumulator that
 * restarts at zero each segment; -0x8000 escapes to a 32-bit absolute value.
 */
function decodeUvDelta(
  r: BinaryReader,
  dataStart: number,
  maxTimes: number,
  numWl: number,
): { times: Float64Array; data: Float64Array } {
  const times: number[] = [];
  const values: number[] = [];
  let pos = dataStart;
  const row = new Array<number>(numWl);
  outer: while (times.length < maxTimes) {
    if (!r.has(pos, 22)) break;
    const t = r.u32le(pos + 4);
    let p = pos + 22;
    let acc = 0;
    for (let j = 0; j < numWl; j++) {
      if (!r.has(p, 2)) break outer;
      const d = r.i16le(p);
      p += 2;
      if (d === -0x8000) {
        if (!r.has(p, 4)) break outer;
        acc = r.i32le(p);
        p += 4;
      } else {
        acc += d;
      }
      row[j] = acc;
    }
    times.push(t / 60000);
    for (let j = 0; j < numWl; j++) values.push(row[j]!);
    pos = p;
  }
  if (Number.isFinite(maxTimes) && times.length < maxTimes) {
    throw new ParseError(`File ends after ${times.length} of ${maxTimes} spectra.`);
  }
  return { times: Float64Array.from(times), data: Float64Array.from(values) };
}

/** The `OL` variant: fixed 22-byte segment headers, then little-endian doubles. */
function decodeUvDoubles(
  r: BinaryReader,
  dataStart: number,
  numTimes: number,
  numWl: number,
): { times: Float64Array; data: Float64Array } {
  const segment = 22 + numWl * 8;
  if (!r.has(dataStart, segment * numTimes)) {
    throw new ParseError('File is shorter than its spectrum count says.');
  }
  const times = new Float64Array(numTimes);
  const data = new Float64Array(numTimes * numWl);
  for (let i = 0; i < numTimes; i++) {
    const base = dataStart + i * segment;
    times[i] = r.u32le(base + 4) / 60000;
    for (let j = 0; j < numWl; j++) data[i * numWl + j] = r.f64le(base + 22 + j * 8);
  }
  return { times, data };
}

/* ------------------------------------------------------------------ .ms */

export interface MsOptions {
  /** Width of the m/z bins in Da. Pairs in one bin are summed. Default 1. */
  binWidth?: number;
}

/**
 * Parses a `.ms` file (GC-MS or LC-MS single quadrupole: scan and SIM).
 * Each scan's m/z-intensity pairs are binned into a shared m/z axis.
 */
export function parseMs(name: string, bytes: Uint8Array, options: MsOptions = {}): Signal | null {
  const binWidth = options.binWidth ?? 1;
  const r = new BinaryReader(bytes);

  let scans: RawScans;
  if (r.has(0, 4) && r.u32be(0) === 0x01320000) {
    const type = r.pstring(0x4, 1);
    const numTimes = type === 'MSD Spectral File' ? r.u32be(0x116) : r.u16le(0x142);
    const start = r.u16be(0x10a) * 2 - 2;
    scans = readScans(r, start, numTimes);
  } else {
    // A partial file stores no data offset; the slot is zero and the scans
    // start at the offset every complete file has used.
    if (!r.has(0x10a, 2) || r.u16be(0x10a) !== 0) return null;
    scans = readScans(r, 0x2f2, Infinity);
    if (scans.times.length === 0) return null;
  }

  const { ylabels, data } = binPairs(scans, binWidth);
  const metadata: Record<string, string | number> = readHeader(r, { date: 0xb2, method: 0xe4 }, 1);
  return { name, detector: 'MS', times: scans.times, ylabels, data, unit: 'counts', metadata };
}

interface RawScans {
  times: Float64Array;
  /** Pair count per scan. */
  counts: Uint32Array;
  mz: Float64Array;
  intensity: Float64Array;
}

/**
 * Scan records: 2 bytes, big-endian u32 time (ms), 6 bytes, u16 pair count,
 * 4 bytes, the pairs, 10 bytes. Each pair is a u16 m/z in 1/20 Da and a u16
 * intensity whose top two bits are a base-8 exponent.
 */
function readScans(r: BinaryReader, start: number, maxTimes: number): RawScans {
  const times: number[] = [];
  const counts: number[] = [];
  const mz: number[] = [];
  const intensity: number[] = [];
  let pos = start;
  while (times.length < maxTimes) {
    if (!r.has(pos, 18)) break;
    const t = r.u32be(pos + 2);
    const n = r.u16be(pos + 12);
    const pairsAt = pos + 18;
    if (!r.has(pairsAt, n * 4 + 10)) break;
    for (let k = 0; k < n; k++) {
      const at = pairsAt + k * 4;
      mz.push(r.u16be(at) / 20);
      const enc = r.u16be(at + 2);
      intensity.push(8 ** (enc >> 14) * (enc & 0x3fff));
    }
    times.push(t / 60000);
    counts.push(n);
    pos = pairsAt + n * 4 + 10;
  }
  if (Number.isFinite(maxTimes) && times.length < maxTimes) {
    throw new ParseError(`File ends after ${times.length} of ${maxTimes} scans.`);
  }
  return {
    times: Float64Array.from(times),
    counts: Uint32Array.from(counts),
    mz: Float64Array.from(mz),
    intensity: Float64Array.from(intensity),
  };
}

/** Round half to even, matching numpy's `rint`. */
function rint(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Bins every scan's pairs onto the m/z bins occupied anywhere in the file. */
function binPairs(scans: RawScans, binWidth: number): { ylabels: Float64Array; data: Float64Array } {
  if (!(binWidth > 0)) throw new ParseError(`binWidth must be positive, got ${binWidth}.`);
  const bins = new Float64Array(scans.mz.length);
  const occupied = new Set<number>();
  for (let k = 0; k < bins.length; k++) {
    const b = rint(scans.mz[k]! / binWidth);
    bins[k] = b;
    occupied.add(b);
  }
  const sorted = [...occupied].sort((a, b) => a - b);
  const column = new Map<number, number>();
  sorted.forEach((b, i) => column.set(b, i));

  const nCols = sorted.length;
  const data = new Float64Array(scans.times.length * nCols);
  let k = 0;
  for (let i = 0; i < scans.times.length; i++) {
    const n = scans.counts[i]!;
    for (let e = k + n; k < e; k++) {
      data[i * nCols + column.get(bins[k]!)!]! += scans.intensity[k]!;
    }
  }
  return { ylabels: Float64Array.from(sorted, (b) => b * binWidth), data };
}
