import { ParseError, type Axis, type Run, type Signal } from '../types.js';

/**
 * JCAMP-DX (IUPAC), the open exchange format for spectra: IR, Raman, UV-Vis,
 * NMR, mass spectra and more. Written from the published specifications
 * (McDonald & Wilks 1988; Lampen et al. 1994; Davies & Lampen 1993) and
 * checked against the jcampconverter reader.
 *
 * Reads `##XYDATA=(X++(Y..Y))` in every ASDF form (AFFN, PAC, SQZ, DIF, DUP),
 * `(XY..XY)` point lists and peak tables, and compound files with several
 * blocks. `##NTUPLES` blocks (NMR FIDs, complex spectra, spectral series)
 * are listed as skipped.
 */

/** A labeled data record: `##LABEL= value` plus any continuation lines. */
interface Ldr {
  label: string;
  value: string;
}

interface Block {
  records: Ldr[];
  header: Map<string, string>;
}

/** Labels compare without spaces, hyphens, slashes and underscores (JCAMP-DX 4.24, 3.2). */
function normalizeLabel(label: string): string {
  return label.replace(/[\s\-/_]/g, '').toUpperCase();
}

function stripComment(line: string): string {
  const i = line.indexOf('$$');
  return i < 0 ? line : line.slice(0, i);
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Older files are often Latin-1 (degree signs, µ in units).
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** True when the bytes look like a JCAMP-DX file: text that starts with a `##` record. */
export function isJcampBytes(bytes: Uint8Array): boolean {
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096));
  return /^\s*##\s*TITLE\s*=/i.test(head) || /^\s*##[^\r\n=]*=/.test(head) && /##\s*JCAMP[\s_-]*DX\s*=/i.test(head);
}

/** File extensions JCAMP-DX files are saved with. `.dx` is shared with OpenLab CDS, so check the bytes. */
export function isJcampPath(path: string): boolean {
  return /\.(jdx|jcamp|jcm|dx)$/i.test(path);
}

function records(text: string): Ldr[] {
  const out: Ldr[] = [];
  let current: Ldr | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = /^\s*##([^=]*)=(.*)$/.exec(line);
    if (m) {
      current = { label: normalizeLabel(m[1]!), value: m[2]! };
      out.push(current);
    } else if (current) {
      current.value += '\n' + line;
    }
  }
  return out;
}

/** Splits the records into blocks: one per `##TITLE=` ... `##END=`, nested blocks flattened. */
function blocks(all: Ldr[]): Block[] {
  const out: Block[] = [];
  const stack: Block[] = [];
  for (const r of all) {
    if (r.label === 'TITLE') {
      const block: Block = { records: [], header: new Map() };
      stack.push(block);
      out.push(block);
    }
    const top = stack[stack.length - 1];
    if (!top) continue;
    top.records.push(r);
    if (!top.header.has(r.label)) top.header.set(r.label, stripComment(r.value.split('\n')[0]!).trim());
    if (r.label === 'END') stack.pop();
  }
  return out;
}

function num(header: Map<string, string>, label: string): number | undefined {
  const v = header.get(label);
  if (v === undefined || v === '') return undefined;
  // Some writers put a space inside a number ("0. 4491087E+01").
  const x = Number(v.replace(/\s+/g, ''));
  return Number.isFinite(x) ? x : undefined;
}

/* ------------------------------------------------------------------ ASDF */

type Token = { kind: 'abs'; value: number } | { kind: 'dif'; value: number } | { kind: 'dup'; count: number };

const SQZ_POS = '@ABCDEFGHI';
const SQZ_NEG = 'abcdefghi';
const DIF_POS = '%JKLMNOPQR';
const DIF_NEG = 'jklmnopqr';
const DUP = 'STUVWXYZs';

/**
 * Splits one data line into values. AFFN and PAC numbers (`12.5`, `-3`,
 * `1+2-3`, `1.2E+03`) and the ASDF compressed forms: SQZ (`@A-Ia-i`, an
 * absolute value), DIF (`%J-Rj-r`, a difference from the previous value)
 * and DUP (`S-Zs`, repeat the previous value or difference). `?` is a
 * missing value.
 */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let kind: 'abs' | 'dif' | 'dup' | null = null;
  let text = '';
  const flush = () => {
    if (kind === null) return;
    if (kind === 'dup') out.push({ kind, count: Number.parseInt(text, 10) });
    else out.push({ kind, value: text === '?' ? Number.NaN : Number(text) } as Token);
    kind = null;
    text = '';
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if ((c >= '0' && c <= '9') || c === '.') {
      if (kind === null) kind = 'abs';
      text += c;
    } else if ((c === 'E' || c === 'e') && kind === 'abs' && /[0-9.]$/.test(text) && /^[+-][0-9]/.test(line.slice(i + 1, i + 3))) {
      // An exponent ("1.5E+03"). Without a sign it is an SQZ value: "4400E839" is 4400, 5839.
      text += 'e' + line[++i];
    } else if ((c === '+' || c === '-') && /[0-9.]/.test(line[i + 1] ?? '')) {
      // A sign starts a new AFFN or PAC value.
      flush();
      kind = 'abs';
      text = c === '-' ? '-' : '';
    } else if (c === '?') {
      flush();
      kind = 'abs';
      text = '?';
      flush();
    } else {
      let k: number;
      if ((k = SQZ_POS.indexOf(c)) >= 0) {
        flush();
        [kind, text] = ['abs', String(k)];
      } else if ((k = SQZ_NEG.indexOf(c)) >= 0) {
        flush();
        [kind, text] = ['abs', `-${k + 1}`];
      } else if ((k = DIF_POS.indexOf(c)) >= 0) {
        flush();
        [kind, text] = ['dif', String(k)];
      } else if ((k = DIF_NEG.indexOf(c)) >= 0) {
        flush();
        [kind, text] = ['dif', `-${k + 1}`];
      } else if ((k = DUP.indexOf(c)) >= 0) {
        flush();
        [kind, text] = ['dup', String(k + 1)];
      } else {
        // Separators: blanks, commas, semicolons. Anything else ends the value too.
        flush();
      }
    }
  }
  flush();
  return out;
}

/**
 * Decodes the lines of an `(X++(Y..Y))` table into Y values (unscaled).
 * Each line starts with an X value, which is only a check: X comes from
 * FIRSTX, LASTX and NPOINTS. When a line ends in DIF form, the next line
 * repeats the last Y as a check value, which is dropped. `lineStarts`, if
 * given, receives each line's X and the index of the point it belongs to.
 */
export function decodeXppYY(lines: string[], lineStarts?: { x: number; index: number }[]): number[] {
  const ys: number[] = [];
  let last = Number.NaN;
  let lastDiff = 0;
  let endedInDif = false;
  for (const raw of lines) {
    const tokens = tokenize(stripComment(raw));
    if (tokens.length === 0) continue;
    let checkPending = endedInDif;
    // The line's X belongs to its first ordinate: the check value (the previous point) if there is one.
    const first = tokens[0]!;
    if (lineStarts && first.kind === 'abs') lineStarts.push({ x: first.value, index: checkPending ? ys.length - 1 : ys.length });
    let prev: 'abs' | 'dif' | null = null;
    for (let t = 1; t < tokens.length; t++) {
      const tok = tokens[t]!;
      if (tok.kind === 'abs') {
        last = tok.value;
        if (!checkPending) ys.push(last);
        checkPending = false;
        prev = 'abs';
      } else if (tok.kind === 'dif') {
        checkPending = false;
        lastDiff = tok.value;
        last += lastDiff;
        ys.push(last);
        prev = 'dif';
      } else {
        for (let k = 1; k < tok.count; k++) {
          if (prev === 'dif') last += lastDiff;
          ys.push(last);
        }
      }
    }
    endedInDif = prev === 'dif';
  }
  return ys;
}

/** Values of an `(XY..XY)`-style table (also `(XYW..XYW)`), grouped per point. */
function decodeGroups(lines: string[], width: number): number[][] {
  const values: number[] = [];
  for (const raw of lines) {
    for (const tok of stripComment(raw).split(/[\s,;]+/)) {
      if (tok === '') continue;
      values.push(tok === '?' ? Number.NaN : Number(tok));
    }
  }
  const groups: number[][] = [];
  for (let i = 0; i + width <= values.length; i += width) groups.push(values.slice(i, i + width));
  return groups;
}

/* ------------------------------------------------------------------ axes and names */

function sentenceCase(s: string): string {
  const t = s.trim().toLowerCase();
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}

function techniqueOf(dataType: string): string {
  const t = dataType.toUpperCase();
  if (/INFRARED|\bIR\b|FTIR/.test(t)) return 'IR spectrum';
  if (/RAMAN/.test(t)) return 'Raman spectrum';
  if (/UV|VIS/.test(t)) return 'UV-Vis spectrum';
  if (/NMR\s*FID/.test(t)) return 'NMR FID';
  if (/NMR/.test(t)) return 'NMR spectrum';
  if (/MASS/.test(t)) return 'Mass spectrum';
  if (/ION\s*MOBILITY/.test(t)) return 'Ion mobility spectrum';
  if (/CHROMATOGRAM/.test(t)) return 'Chromatogram';
  return sentenceCase(dataType) || 'Spectrum';
}

function xAxisOf(units: string, technique: string): Axis {
  let u = units.replace(/\s+/g, '').toUpperCase();
  // Free-text units, e.g. "Wavelength (nm)".
  if (/\(NM\)|NANOMETER/.test(u)) u = 'NM';
  else if (/CM-1|CM\^-1|\(1\/CM\)|WAVENUMBER/.test(u)) u = '1/CM';
  if (u === '1/CM') {
    return technique === 'Raman spectrum' ? { label: 'Raman shift', unit: 'cm⁻¹' } : { label: 'Wavenumber', unit: 'cm⁻¹', reversed: technique === 'IR spectrum' };
  }
  if (u === 'NANOMETERS' || u === 'NM') return { label: 'Wavelength', unit: 'nm' };
  if (u === 'MICROMETERS' || u === 'UM') return { label: 'Wavelength', unit: 'µm' };
  if (u === 'PPM') return { label: 'Chemical shift', unit: 'ppm', reversed: true };
  if (u === 'HZ') return { label: 'Frequency', unit: 'Hz' };
  if (u === 'M/Z') return { label: 'm/z', unit: '' };
  if (u === 'SECONDS' || u === 'S') return { label: 'Time', unit: 's' };
  if (u === 'MINUTES' || u === 'MIN') return { label: 'Time', unit: 'min' };
  if (u === 'DEGREES' || u === 'DEGREESC' || u === 'C') return { label: 'Temperature', unit: '°C' };
  return { label: sentenceCase(units) || 'X', unit: '' };
}

const METADATA: [string, string][] = [
  ['TITLE', 'title'],
  ['DATATYPE', 'data type'],
  ['ORIGIN', 'origin'],
  ['OWNER', 'owner'],
  ['LONGDATE', 'date'],
  ['DATE', 'date'],
  ['SPECTROMETERDATASYSTEM', 'spectrometer'],
  ['INSTRUMENTPARAMETERS', 'instrument parameters'],
  ['SAMPLEDESCRIPTION', 'sample description'],
  ['CASNAME', 'CAS name'],
  ['NAMES', 'names'],
  ['MOLFORM', 'formula'],
  ['CASREGISTRYNO', 'CAS number'],
  ['STATE', 'state'],
  ['PATHLENGTH', 'path length'],
  ['RESOLUTION', 'resolution'],
  ['.OBSERVEFREQUENCY', 'observe frequency (MHz)'],
  ['.OBSERVENUCLEUS', 'nucleus'],
  ['.SOLVENTNAME', 'solvent'],
];

function metadataOf(header: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, key] of METADATA) {
    const v = header.get(label);
    if (v && !(key in out)) out[key] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ blocks to signals */

function signalOf(block: Block, name: string): Signal | { skip: string } | null {
  const h = block.header;
  const data = block.records.find((r) => ['XYDATA', 'XYPOINTS', 'PEAKTABLE', 'NTUPLES', 'DATATABLE'].includes(r.label));
  if (!data) return null;
  if (data.label === 'NTUPLES' || data.label === 'DATATABLE') {
    return { skip: 'Multi-page JCAMP-DX (NTUPLES: NMR FIDs, complex spectra, spectral series) is not supported yet.' };
  }

  const [form, ...lines] = data.value.split('\n');
  const dataType = h.get('DATATYPE') ?? '';
  const technique = techniqueOf(dataType);
  const xFactor = num(h, 'XFACTOR') ?? 1;
  const yFactor = num(h, 'YFACTOR') ?? 1;
  let xAxis = xAxisOf(h.get('XUNITS') ?? '', technique);
  let x: Float64Array;
  let y: Float64Array;
  let sticks = data.label === 'PEAKTABLE' || /PEAK\s*TABLE/i.test(h.get('DATACLASS') ?? '');

  if (/\+\+/.test(form!)) {
    const ys = decodeXppYY(lines);
    const n = ys.length;
    const npoints = num(h, 'NPOINTS');
    const firstX = num(h, 'FIRSTX');
    const lastX = num(h, 'LASTX');
    if (firstX === undefined || lastX === undefined) throw new ParseError(`${name}: FIRSTX or LASTX is missing.`);
    const count = npoints ?? n;
    const delta = count > 1 ? (lastX - firstX) / (count - 1) : 0;
    x = new Float64Array(n);
    y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = firstX + i * delta;
      y[i] = ys[i]! * yFactor;
    }
    if (npoints !== undefined && npoints !== n) {
      throw new ParseError(`${name}: the file declares ${npoints} points but contains ${n}.`);
    }
  } else {
    const width = Math.max(2, (/\(([A-Z]+)\.\./i.exec(form!)?.[1] ?? 'XY').length);
    const groups = decodeGroups(lines, width);
    x = Float64Array.from(groups, (g) => g[0]! * xFactor);
    y = Float64Array.from(groups, (g) => g[1]! * yFactor);
    if (data.label === 'XYPOINTS' || /XYPOINTS/i.test(h.get('DATACLASS') ?? '')) sticks = false;
  }

  // NMR recorded in Hz: chemical shift in ppm is Hz / observe frequency (MHz).
  // Bruker's $OFFSET gives the shift of the first point.
  const observe = num(h, '.OBSERVEFREQUENCY') ?? num(h, '$SFO1');
  if (xAxis.unit === 'Hz' && observe && /NMR/i.test(dataType)) {
    for (let i = 0; i < x.length; i++) x[i]! /= observe;
    xAxis = { label: 'Chemical shift', unit: 'ppm', reversed: true };
    const offset = num(h, '$OFFSET');
    const firstX = num(h, 'FIRSTX');
    if (offset !== undefined && firstX !== undefined && x.length) {
      const shift = firstX / observe - offset;
      for (let i = 0; i < x.length; i++) x[i]! -= shift;
    }
  }

  // Rows ascend, whatever order the file lists them in.
  const order = Array.from(x.keys()).sort((a, b) => x[a]! - x[b]!);
  const times = Float64Array.from(order, (i) => x[i]!);
  const values = Float64Array.from(order, (i) => y[i]!);

  return {
    name,
    detector: null,
    times,
    xAxis,
    technique,
    sticks: sticks || undefined,
    ylabels: new Float64Array([Number.NaN]),
    data: values,
    unit: sentenceCase(h.get('YUNITS') ?? ''),
    metadata: metadataOf(h),
  };
}

/** Decodes a JCAMP-DX file into one run: a signal per spectrum block. */
export function parseJcamp(path: string, bytes: Uint8Array): Run {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const all = blocks(records(decodeText(bytes)));
  if (all.length === 0) throw new ParseError('No ##TITLE= record: not a JCAMP-DX file.');
  const withData = all.filter((b) => b.records.some((r) => ['XYDATA', 'XYPOINTS', 'PEAKTABLE', 'NTUPLES', 'DATATABLE'].includes(r.label)));
  const run: Run = { name: fileName, vendor: 'JCAMP-DX', signals: [], metadata: {}, skipped: [] };
  withData.forEach((block, i) => {
    const title = block.header.get('TITLE') || `block ${i + 1}`;
    const name = withData.length > 1 ? title : fileName;
    const where = withData.length > 1 ? `${path} (${title})` : path;
    try {
      const signal = signalOf(block, name);
      if (signal && 'skip' in signal) run.skipped.push({ path: where, reason: signal.skip });
      else if (signal) run.signals.push(signal);
    } catch (err) {
      run.skipped.push({ path: where, reason: err instanceof Error ? err.message : String(err) });
    }
  });
  if (withData.length === 0) run.skipped.push({ path, reason: 'The file holds no spectrum data.' });

  const first = all[0]!.header;
  const title = first.get('TITLE');
  if (title) run.metadata.sample = title;
  const date = first.get('LONGDATE') || first.get('DATE');
  if (date) run.metadata.date = date;
  return run;
}
