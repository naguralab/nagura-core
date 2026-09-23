import { parseCh, parseMs, parseUv, type MsOptions } from './chemstation.js';
import { isDxFile, parseDx } from './openlab.js';
import type { InputFile, Run, Signal } from '../types.js';

export type ParseOptions = MsOptions;

const DATA_EXTENSIONS = new Set(['.ch', '.uv', '.ms']);

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** True for a file the Agilent parsers can decode: ChemStation data or an OpenLab `.dx`. */
export function isAgilentDataFile(path: string): boolean {
  // Method folders (ACQ.M, DA.M) inside a run hold settings, not data.
  if (/\.m\//i.test(path)) return false;
  return DATA_EXTENSIONS.has(extension(path)) || isDxFile(path);
}

/** Decodes one data file. Returns null for a file this module does not read. */
export function parseAgilentFile(path: string, bytes: Uint8Array, options: ParseOptions = {}): Signal | null {
  const name = basename(path);
  switch (extension(path)) {
    case '.ch':
      return parseCh(name, bytes);
    case '.uv':
      return parseUv(name, bytes);
    case '.ms':
      return parseMs(name, bytes, options);
    default:
      return null;
  }
}

/**
 * The `.D` folder a path belongs to, e.g. `batch/s1.D/DAD1A.ch` -> `batch/s1.D`.
 * A file outside any `.D` folder is its own run.
 */
function runKey(path: string): string {
  const parts = path.split('/');
  for (let i = parts.length - 2; i >= 0; i--) {
    if (/\.d$/i.test(parts[i]!)) return parts.slice(0, i + 1).join('/');
  }
  return path;
}

/**
 * Groups dropped files into runs (one per `.D` folder or `.dx` file) and
 * decodes every data file. A file that fails to decode is listed in `skipped` rather than
 * failing its run.
 */
export function parseAgilentRuns(files: InputFile[], options: ParseOptions = {}): Run[] {
  const runs: Run[] = [];
  const groups = new Map<string, InputFile[]>();
  for (const file of files) {
    // An OpenLab .dx archive is a whole run in one file.
    if (isDxFile(file.path)) {
      try {
        runs.push(parseDx(file.path, file.bytes));
      } catch (err) {
        const name = basename(file.path);
        runs.push({ name, vendor: 'Agilent', signals: [], metadata: {}, skipped: [{ path: file.path, reason: `Not a readable .dx archive: ${err instanceof Error ? err.message : String(err)}` }] });
      }
      continue;
    }
    const key = runKey(file.path);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(file);
  }

  for (const [key, group] of groups) {
    const run: Run = { name: basename(key), vendor: 'Agilent', signals: [], metadata: {}, skipped: [] };
    const sorted = [...group].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const file of sorted) {
      if (!isAgilentDataFile(file.path)) continue;
      try {
        const signal = parseAgilentFile(file.path, file.bytes, options);
        if (signal) run.signals.push(signal);
        else run.skipped.push({ path: file.path, reason: 'Unrecognized file version.' });
      } catch (err) {
        run.skipped.push({ path: file.path, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    Object.assign(run.metadata, runMetadata(run.signals, sorted));
    if (run.signals.length || run.skipped.length) runs.push(run);
  }
  return runs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Most common value of a metadata key across the run's signals. */
function mostCommon(signals: Signal[], key: string): string | undefined {
  const counts = new Map<string, number>();
  for (const s of signals) {
    const v = s.metadata[key];
    if (typeof v === 'string' && v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) [best, bestCount] = [v, c];
  }
  return best;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  // UTF-16 without a byte-order mark still shows as every other byte zero.
  if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

function runMetadata(signals: Signal[], files: InputFile[]): Record<string, string> {
  const metadata: Record<string, string> = {};
  const date = mostCommon(signals, 'date');
  if (date) metadata.date = date;
  const method = mostCommon(signals, 'method');
  if (method) metadata.method = method;
  const vial = mostCommon(signals, 'vialpos');
  if (vial) metadata.vialpos = vial;

  const sampleXml = files.find((f) => basename(f.path).toLowerCase() === 'sample.xml');
  if (sampleXml) {
    const name = /<Name>([^<]*)<\/Name>/.exec(decodeText(sampleXml.bytes))?.[1]?.trim();
    if (name) metadata.sample = name;
  }
  return metadata;
}
