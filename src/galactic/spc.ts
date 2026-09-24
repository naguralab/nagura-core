import { BinaryReader } from '../binary.js';
import { ParseError, type Axis, type Run, type Signal } from '../types.js';

/**
 * Galactic SPC (GRAMS, Thermo Fisher), a binary format that many
 * spectrometers and converters write: IR, NIR, Raman, UV-Vis, fluorescence,
 * NMR, mass spectra and chromatograms. Written from Galactic's published
 * "Universal Data Format Specification" (1997) and its SPC.H header, and
 * checked against the spc-parser reader.
 *
 * Reads the new format (0x4B, little-endian) in every layout (evenly spaced
 * X, a common X array, an X array per subfile; one or many subfiles; 4D W
 * planes) with 32-bit float, 32-bit and 16-bit scaled integer Y values, and
 * the old Spectra Calc / Lab Calc format (0x4D). The rare big-endian 0x4C
 * variant is refused.
 */

// ftflgs bits (SPC.H).
const TSPREC = 0x01;
const TCGRAM = 0x02;
const TMULTI = 0x04;
const TORDRD = 0x10;
const TALABS = 0x20;
const TXYXYS = 0x40;
const TXVALS = 0x80;

const NEW_HEADER = 512;
const OLD_HEADER = 256;
const SUBHEADER = 32;

/** The main header, with old-format fields mapped onto the new names. */
export interface SpcHeader {
  flags: number;
  version: number;
  experiment: number;
  exponent: number;
  /** Point count; for TXYXYS files the offset of the subfile directory (0 when absent). */
  points: number;
  first: number;
  last: number;
  subfiles: number;
  xType: number;
  yType: number;
  zType: number;
  date: string;
  resolution: string;
  source: string;
  comment: string;
  /** Custom X, Y, Z axis labels (TALABS). */
  labels: [string, string, string];
  logOffset: number;
  zIncrement: number;
  wPlanes: number;
  wIncrement: number;
  wType: number;
}

export interface SpcSubfile {
  /** Byte offset of the subfile header. */
  offset: number;
  /** Bytes taken by subheader, X and Y. */
  size: number;
  index: number;
  exponent: number;
  zStart: number;
  zNext: number;
  wLevel: number;
  /** Declared point count (TXYXYS only; otherwise 0). */
  declaredPoints: number;
  x: Float64Array;
  y: Float64Array;
  z: number;
  w: number | null;
}

export interface SpcFile {
  header: SpcHeader;
  subfiles: SpcSubfile[];
  /** Byte offset just past the last subfile. */
  dataEnd: number;
  /** TXYXYS directory entries, when the file has one. */
  directory: { offset: number; size: number; z: number }[];
  /** Log text as key/value pairs, keys in upper case. */
  log: Map<string, string>;
}

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder('windows-1252').decode(end < 0 ? bytes : bytes.subarray(0, end)).trim();
}

function field(r: BinaryReader, offset: number, size: number): Uint8Array {
  return r.has(offset, size) ? r.bytes.subarray(offset, offset + size) : new Uint8Array();
}

/** X, Y, Z custom labels: null-terminated strings, one after another. */
function axisLabels(bytes: Uint8Array): [string, string, string] {
  const parts = new TextDecoder('windows-1252').decode(bytes).split('\0');
  return [parts[0]?.trim() ?? '', parts[1]?.trim() ?? '', parts[2]?.trim() ?? ''];
}

function isoDate(year: number, month: number, day: number, hour: number, minute: number): string {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)} ${p(hour)}:${p(minute)}`;
}

function newHeader(r: BinaryReader): SpcHeader {
  const flags = r.u8(0);
  // fdate, most significant first: year 12 bits, month 4, day 5, hour 5, minute 6.
  const d = r.u32le(32);
  const talabs = (flags & TALABS) !== 0;
  return {
    flags,
    version: r.u8(1),
    experiment: r.u8(2),
    exponent: r.view.getInt8(3),
    points: r.u32le(4),
    first: r.f64le(8),
    last: r.f64le(16),
    subfiles: r.u32le(24),
    xType: r.u8(28),
    yType: r.u8(29),
    zType: r.u8(30),
    date: isoDate(d >>> 20, (d >>> 16) & 0xf, (d >>> 11) & 0x1f, (d >>> 6) & 0x1f, d & 0x3f),
    resolution: text(field(r, 36, 9)),
    source: text(field(r, 45, 9)),
    // Without TALABS the comment may run on into the label area.
    comment: text(field(r, 88, talabs ? 130 : 160)),
    labels: talabs ? axisLabels(field(r, 218, 30)) : ['', '', ''],
    logOffset: r.u32le(248),
    zIncrement: r.f32le(312),
    wPlanes: r.u32le(316),
    wIncrement: r.f32le(320),
    wType: r.u8(324),
  };
}

function oldHeader(r: BinaryReader): SpcHeader {
  const flags = r.u8(0);
  const year = r.u16le(18);
  // The top 4 bits of oyear hold the Z axis type; 15 (ZTEXTL) flags custom labels.
  const zType = year >>> 12;
  const talabs = (flags & TALABS) !== 0 || zType === 15;
  return {
    flags,
    version: r.u8(1),
    experiment: 0,
    exponent: r.i16le(2),
    points: Math.round(r.f32le(4)),
    first: r.f32le(8),
    last: r.f32le(12),
    subfiles: 0,
    xType: r.u8(16),
    yType: r.u8(17),
    zType: zType === 15 ? 0 : zType,
    date: year & 0xfff ? isoDate(year & 0xfff, r.u8(20), r.u8(21), r.u8(22), r.u8(23)) : '',
    resolution: text(field(r, 24, 8)),
    source: '',
    comment: text(field(r, 64, 130)),
    labels: talabs ? axisLabels(field(r, 194, 30)) : ['', '', ''],
    logOffset: 0,
    zIncrement: 0,
    wPlanes: 0,
    wIncrement: 0,
    wType: 0,
  };
}

/**
 * Y values as stored: 32-bit floats when the exponent is 0x80, otherwise
 * fixed-point fractions, FloatY = 2^exp * IntegerY / 2^32 (or / 2^16 for
 * 16-bit values). The old format stores the high 16-bit word first.
 */
function readY(r: BinaryReader, offset: number, n: number, exponent: number, short: boolean, old: boolean): { y: Float64Array; size: number } {
  const y = new Float64Array(n);
  if (exponent === -128 || (old && exponent === 128)) {
    if (n) r.f32le(offset + 4 * n - 4);
    for (let i = 0; i < n; i++) y[i] = r.view.getFloat32(offset + 4 * i, true);
    return { y, size: 4 * n };
  }
  if (short) {
    const scale = 2 ** (exponent - 16);
    if (n) r.i16le(offset + 2 * n - 2);
    for (let i = 0; i < n; i++) y[i] = r.view.getInt16(offset + 2 * i, true) * scale;
    return { y, size: 2 * n };
  }
  const scale = 2 ** (exponent - 32);
  if (n) r.i32le(offset + 4 * n - 4);
  for (let i = 0; i < n; i++) {
    const at = offset + 4 * i;
    const v = old ? r.view.getInt16(at, true) * 65536 + r.view.getUint16(at + 2, true) : r.view.getInt32(at, true);
    y[i] = v * scale;
  }
  return { y, size: 4 * n };
}

function readX(r: BinaryReader, offset: number, n: number): Float64Array {
  if (n) r.f32le(offset + 4 * n - 4);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = r.view.getFloat32(offset + 4 * i, true);
  return x;
}

function evenX(first: number, last: number, n: number): Float64Array {
  const x = new Float64Array(n);
  const step = n > 1 ? (last - first) / (n - 1) : 0;
  for (let i = 0; i < n; i++) x[i] = first + i * step;
  return x;
}

function logText(r: BinaryReader, offset: number): Map<string, string> {
  const log = new Map<string, string>();
  if (!offset || !r.has(offset, 64)) return log;
  const size = r.u32le(offset);
  const textAt = offset + r.u32le(offset + 8);
  const end = Math.min(r.length, offset + (size || r.length));
  if (textAt >= end) return log;
  const body = text(r.bytes.subarray(textAt, end));
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toUpperCase();
    if (key && !log.has(key)) log.set(key, line.slice(i + 1).trim());
  }
  return log;
}

/** True when the bytes start like a Galactic SPC header. */
export function isSpcBytes(bytes: Uint8Array): boolean {
  if (bytes.length < OLD_HEADER + SUBHEADER) return false;
  const flags = bytes[0]!;
  const version = bytes[1]!;
  // TXYXYS is only valid together with TXVALS.
  if ((flags & TXYXYS) && !(flags & TXVALS)) return false;
  const r = new BinaryReader(bytes);
  if (version === 0x4b) {
    if (bytes.length < NEW_HEADER + SUBHEADER) return false;
    const x = bytes[28]!;
    const y = bytes[29]!;
    return (x <= 30 || x === 255) && (y <= 26 || (y >= 128 && y <= 131)) && bytes[2]! <= 14 && r.u32le(24) < 1e7;
  }
  if (version === 0x4c) return true;
  if (version === 0x4d) {
    const n = r.f32le(4);
    return Number.isInteger(n) && n > 0 && n < 1e8 && bytes[16]! <= 30 && bytes[17]! <= 26;
  }
  return false;
}

/** File extensions SPC files are saved with (Galactic also used `.cgm` for chromatograms). */
export function isSpcPath(path: string): boolean {
  return /\.(spc|cgm)$/i.test(path);
}

/** Decodes the structure of an SPC file: header, subfiles, directory and log text. */
export function readSpc(bytes: Uint8Array): SpcFile {
  const r = new BinaryReader(bytes);
  if (bytes.length < OLD_HEADER) throw new ParseError('File is too short to be a Galactic SPC file.');
  const version = bytes[1]!;
  if (version === 0x4c) throw new ParseError('Big-endian SPC files (version 0x4C) are not supported.');
  if (version !== 0x4b && version !== 0x4d) {
    throw new ParseError(`Not a Galactic SPC file (version byte 0x${version.toString(16)}).`);
  }
  const old = version === 0x4d;
  const header = old ? oldHeader(r) : newHeader(r);
  const { flags } = header;
  const multi = (flags & TMULTI) !== 0;
  const xyxy = !old && (flags & TXYXYS) !== 0;
  const short = (flags & TSPREC) !== 0;

  let offset = old ? OLD_HEADER - SUBHEADER : NEW_HEADER;
  let commonX: Float64Array | null = null;
  if (!xyxy) {
    if (header.points < 1) throw new ParseError('The file declares no data points.');
    if (!old && flags & TXVALS) {
      commonX = readX(r, offset, header.points);
      offset += 4 * header.points;
    } else {
      commonX = evenX(header.first, header.last, header.points);
    }
  }

  // The old format has no subfile count: a multifile's subfiles run to the end of the file.
  const end = header.logOffset && header.logOffset <= r.length ? header.logOffset : r.length;
  const count = !multi ? 1 : old ? Number.POSITIVE_INFINITY : header.subfiles;
  const subfiles: SpcSubfile[] = [];
  while (subfiles.length < count) {
    if (old && subfiles.length > 0 && offset + SUBHEADER >= end) break;
    const at = offset;
    if (!r.has(at, SUBHEADER)) throw new ParseError(`Subfile ${subfiles.length + 1} of ${count} is missing: the file ends at byte ${r.length}.`);
    const exponentByte = r.view.getInt8(at + 1);
    const sub = {
      offset: at,
      index: r.u16le(at + 2),
      zStart: r.f32le(at + 4),
      zNext: r.f32le(at + 8),
      declaredPoints: r.u32le(at + 16),
      wLevel: r.f32le(at + 24),
    };
    offset += SUBHEADER;
    // Without TMULTI, subexp is ignored in favor of fexp (SPC.H). Old files leave it 0 to mean the same.
    const exponent = !multi || (old && exponentByte === 0) ? header.exponent : exponentByte;
    let x = commonX!;
    if (xyxy) {
      x = readX(r, offset, sub.declaredPoints);
      offset += 4 * sub.declaredPoints;
    }
    const { y, size } = readY(r, offset, x.length, exponent, short, old);
    offset += size;
    subfiles.push({ ...sub, exponent, size: offset - at, x, y, z: 0, w: null });
    if (offset > end) throw new ParseError(`Subfile ${subfiles.length} runs past the end of the data.`);
  }
  if (!old && (header.subfiles > 1 || multi) && subfiles.length !== Math.max(1, header.subfiles)) {
    throw new ParseError(`The file declares ${header.subfiles} subfiles but holds ${subfiles.length}.`);
  }
  const dataEnd = offset;

  // Z: read from every subheader when ordered, else evenly spaced from the first.
  const first = subfiles[0]!;
  const zStep = header.zIncrement || first.zNext - first.zStart;
  subfiles.forEach((s, i) => (s.z = flags & TORDRD || !multi ? s.zStart : first.zStart + i * zStep));
  // W: planes of subfiles in a 4D file.
  if (header.wPlanes > 0 && subfiles.length % header.wPlanes === 0) {
    const perPlane = subfiles.length / header.wPlanes;
    subfiles.forEach((s, i) => {
      const plane = Math.floor(i / perPlane);
      s.w = header.wIncrement ? first.wLevel + plane * header.wIncrement : subfiles[plane * perPlane]!.wLevel;
    });
  }

  const directory: SpcFile['directory'] = [];
  if (xyxy && header.points && r.has(header.points, 12 * subfiles.length)) {
    for (let i = 0; i < subfiles.length; i++) {
      const at = header.points + 12 * i;
      directory.push({ offset: r.u32le(at), size: r.u32le(at + 4), z: r.f32le(at + 8) });
    }
  }

  return { header, subfiles, dataEnd, directory, log: logText(r, header.logOffset) };
}

/* ------------------------------------------------------------------ axes and names */

const X_AXES: Record<number, Axis> = {
  1: { label: 'Wavenumber', unit: 'cm⁻¹' },
  2: { label: 'Wavelength', unit: 'µm' },
  3: { label: 'Wavelength', unit: 'nm' },
  4: { label: 'Time', unit: 's' },
  5: { label: 'Time', unit: 'min' },
  6: { label: 'Frequency', unit: 'Hz' },
  7: { label: 'Frequency', unit: 'kHz' },
  8: { label: 'Frequency', unit: 'MHz' },
  9: { label: 'm/z', unit: '' },
  10: { label: 'Chemical shift', unit: 'ppm', reversed: true },
  11: { label: 'Time', unit: 'days' },
  12: { label: 'Time', unit: 'years' },
  13: { label: 'Raman shift', unit: 'cm⁻¹' },
  14: { label: 'Energy', unit: 'eV' },
  16: { label: 'Diode number', unit: '' },
  17: { label: 'Channel', unit: '' },
  18: { label: 'Angle', unit: '°' },
  19: { label: 'Temperature', unit: '°F' },
  20: { label: 'Temperature', unit: '°C' },
  21: { label: 'Temperature', unit: 'K' },
  22: { label: 'Data point', unit: '' },
  23: { label: 'Time', unit: 'ms' },
  24: { label: 'Time', unit: 'µs' },
  25: { label: 'Time', unit: 'ns' },
  26: { label: 'Frequency', unit: 'GHz' },
  27: { label: 'Length', unit: 'cm' },
  28: { label: 'Length', unit: 'm' },
  29: { label: 'Length', unit: 'mm' },
  30: { label: 'Time', unit: 'h' },
};

const Y_UNITS: Record<number, string> = {
  0: 'Intensity (a.u.)',
  1: 'Interferogram',
  2: 'Absorbance',
  3: 'Kubelka-Munk',
  4: 'Counts',
  5: 'V',
  6: '°',
  7: 'mA',
  8: 'mm',
  9: 'mV',
  10: 'log(1/R)',
  11: '%',
  12: 'Intensity',
  13: 'Relative intensity',
  14: 'Energy',
  16: 'dB',
  19: '°F',
  20: '°C',
  21: 'K',
  22: 'Refractive index',
  23: 'Extinction coefficient',
  24: 'Real',
  25: 'Imaginary',
  26: 'Complex',
  128: 'Transmission',
  129: 'Reflectance',
  130: 'Single beam',
  131: 'Emission',
};

const EXPERIMENTS: Record<number, string> = {
  4: 'IR spectrum',
  5: 'NIR spectrum',
  6: 'UV-Vis spectrum',
  8: 'X-ray diffraction pattern',
  9: 'Mass spectrum',
  10: 'NMR spectrum',
  11: 'Raman spectrum',
  12: 'Fluorescence spectrum',
  13: 'Atomic spectrum',
  14: 'Diode-array spectrum',
};

function techniqueOf(h: SpcHeader): string {
  // fexper 4 covers FT-IR, FT-NIR and FT-Raman; the X axis tells them apart.
  if (h.xType === 13) return 'Raman spectrum';
  const known = EXPERIMENTS[h.experiment];
  if (known) return known;
  if (h.xType === 1) return 'IR spectrum';
  if (h.xType === 9) return 'Mass spectrum';
  if (h.xType === 10) return 'NMR spectrum';
  return 'Spectrum';
}

/** Chromatograms: flagged as one (fexper 1-3, TCGRAM), or plain data against minutes. */
function isChromatogram(h: SpcHeader): boolean {
  if (h.flags & TXYXYS) return false;
  const time = h.xType === 4 || h.xType === 5;
  return time && ([1, 2, 3].includes(h.experiment) || (h.flags & TCGRAM) !== 0 || (h.experiment === 0 && h.xType === 5));
}

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(6)));
}

const METADATA_LOG_KEYS = 40;

/** Decodes a Galactic SPC file into one run: a signal per subfile. */
export function parseSpc(path: string, bytes: Uint8Array): Run {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const spc = readSpc(bytes);
  const h = spc.header;
  const chromatogram = isChromatogram(h);
  const technique = chromatogram ? undefined : techniqueOf(h);
  let xAxis: Axis = X_AXES[h.xType] ?? { label: 'X', unit: '' };
  if (h.xType === 1 && technique === 'IR spectrum') xAxis = { ...xAxis, reversed: true };
  if (h.labels[0]) xAxis = { label: h.labels[0], unit: '', ...(xAxis.reversed ? { reversed: true } : {}) };
  const unit = h.labels[1] || (Y_UNITS[h.yType] ?? '');
  const zAxis = h.labels[2] ? { label: h.labels[2], unit: '' } : X_AXES[h.zType];

  const metadata: Record<string, string | number> = {};
  if (h.comment) metadata.comment = h.comment;
  if (h.date) metadata.date = h.date;
  if (h.resolution) metadata.resolution = h.resolution;
  if (h.source) metadata.instrument = h.source;
  metadata['SPC version'] = h.version === 0x4d ? 'old (0x4D)' : 'new (0x4B)';
  let logged = 0;
  for (const [key, value] of spc.log) {
    if (logged++ >= METADATA_LOG_KEYS) break;
    metadata[`log ${key}`] = value;
  }

  const many = spc.subfiles.length > 1;
  const run: Run = { name: fileName, vendor: 'Galactic SPC', signals: [], metadata: {}, skipped: [] };
  spc.subfiles.forEach((sub, i) => {
    let name = fileName;
    if (many) {
      const parts = [`#${i + 1}`];
      if (zAxis || h.flags & TORDRD) parts.push(`${zAxis?.label ?? 'z'} ${fmt(sub.z)}${zAxis?.unit ? ' ' + zAxis.unit : ''}`);
      if (sub.w !== null) parts.push(`w ${fmt(sub.w)}`);
      name = parts.join(' · ');
    }
    // Rows ascend, whatever order the file lists them in.
    const order = Array.from(sub.x.keys()).sort((a, b) => sub.x[a]! - sub.x[b]!);
    let times = Float64Array.from(order, (k) => sub.x[k]!);
    if (chromatogram && h.xType === 4) times = times.map((t) => t / 60);
    const signal: Signal = {
      name,
      detector: null,
      times,
      ylabels: new Float64Array([Number.NaN]),
      data: Float64Array.from(order, (k) => sub.y[k]!),
      unit,
      metadata: { ...metadata, ...(many ? { subfile: i + 1, z: sub.z } : {}), ...(sub.w !== null ? { w: sub.w } : {}) },
    };
    if (!chromatogram) {
      signal.xAxis = xAxis;
      signal.technique = technique;
      if (h.flags & TXYXYS) signal.sticks = true;
    }
    run.signals.push(signal);
  });

  if (h.comment) run.metadata.sample = h.comment;
  if (h.date) run.metadata.date = h.date;
  return run;
}
