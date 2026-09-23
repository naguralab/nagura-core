/**
 * Agilent OpenLab CDS 2.x result files (`.dx`).
 *
 * A `.dx` is a zip archive (Open Packaging Conventions). Its binary payloads
 * have GUID names and reuse the ChemStation containers: `.UV` spectra
 * (version 131), `.CH` signals and `.IT` instrument traces (version 179).
 * The `injection.acmd` XML manifest maps each GUID to its device, signal
 * description and unit. Ported from rainbow's `openlab.py` (LGPL-3.0); see
 * NOTICE.md.
 */
import { unzipSync } from 'fflate';
import { parseCh, parseUv } from './chemstation.js';
import type { Detector, Run, Signal } from '../types.js';

/**
 * `.dx` spectra carry an extra 17-bit fixed-point shift that the in-file
 * scale factor does not include. rainbow verified the correction against the
 * single-wavelength `.CH` channels of the same run.
 */
const UV_FIXED_POINT_SHIFT = 2 ** -17;

interface ManifestSignal {
  encoding: string;
  device: string;
  description: string;
  unit: string;
}

export interface DxOptions {
  /** Include instrument telemetry (pressure, temperature). Default false. */
  telemetry?: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? m;
  });
}

/** Text of the first `<tag>` directly inside `xml`, or ''. The manifest is flat and machine-written. */
function tagText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unescapeXml(m[1]!).trim() : '';
}

function parseManifest(xml: string): { metadata: Record<string, string | number>; signals: Map<string, ManifestSignal> } {
  const signals = new Map<string, ManifestSignal>();
  for (const m of xml.matchAll(/<Signal>([\s\S]*?)<\/Signal>/g)) {
    const block = m[1]!;
    const guid = tagText(block, 'TraceId').toLowerCase();
    if (!guid) continue;
    signals.set(guid, {
      encoding: tagText(block, 'Encoding'),
      device: tagText(block, 'DeviceName'),
      description: tagText(block, 'Description'),
      unit: tagText(block, 'Units'),
    });
  }

  const metadata: Record<string, string | number> = {};
  const info = /<InjectionInfo>([\s\S]*?)<Signals>/.exec(xml)?.[1] ?? '';
  const date = tagText(info, 'RunDateTime');
  if (date) metadata.date = date;
  const method = tagText(info, 'AcquisitionMethod');
  if (method) metadata.method = method.replace(/\\/g, '/').split('/').pop()!;
  const sample = tagText(info, 'SampleName');
  if (sample) metadata.sample = sample;
  const vial = tagText(info, 'Location');
  if (vial) metadata.vialpos = vial;
  const operator = tagText(info, 'RunOperator');
  if (operator) metadata.operator = operator;
  const volume = Number(tagText(info, 'InjectionVolume'));
  if (volume) {
    const unit = tagText(info, 'InjectionVolumeUnits');
    metadata.injection_volume = unit ? `${volume} ${unit}` : volume;
  }
  return { metadata, signals };
}

/** The detector a manifest entry describes; null for instrument telemetry. */
function classify(signal: ManifestSignal | undefined): Detector {
  if (!signal) return null;
  if (signal.encoding.startsWith('Agilent.OpenLab.Rawdata/InstrumentTrace')) return null;
  const device = signal.device.toUpperCase();
  if (['DAD', 'MWD', 'VWD'].includes(device.slice(0, 3)) || signal.unit === 'mAU') return 'UV';
  if (device.startsWith('FID')) return 'FID';
  if (device.startsWith('RID')) return 'RID';
  return null;
}

const SIG_RE = /Sig=([\d.]+),([\d.]+)/;
const REF_RE = /Ref=([\d.]+),([\d.]+)/;

function signalMetadata(signal: ManifestSignal | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!signal) return out;
  if (signal.device) out.device = signal.device;
  if (signal.description) out.description = signal.description;
  const sig = SIG_RE.exec(signal.description);
  if (sig) {
    out.wavelength = Number(sig[1]);
    out.bandwidth = Number(sig[2]);
  }
  const ref = REF_RE.exec(signal.description);
  if (ref) {
    out.reference_wavelength = Number(ref[1]);
    out.reference_bandwidth = Number(ref[2]);
  }
  return out;
}

/** Readable, unique name from the description's signal code (e.g. `DAD1A.CH`). */
function nameFor(signal: ManifestSignal | undefined, guid: string, ext: string, used: Set<string>): string {
  const code = (signal?.description ?? '').split(',', 1)[0]!.trim();
  const base = code || signal?.device || guid;
  let name = base + ext;
  if (used.has(name.toUpperCase())) name = `${base}_${guid.slice(0, 8)}${ext}`;
  used.add(name.toUpperCase());
  return name;
}

/** True for an OpenLab CDS 2 result file. */
export function isDxFile(path: string): boolean {
  return /\.dx$/i.test(path);
}

/**
 * Decodes an OpenLab CDS `.dx` archive into one run. Payloads that fail to
 * decode are listed in `skipped`.
 */
export function parseDx(path: string, bytes: Uint8Array, options: DxOptions = {}): Run {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const files = unzipSync(bytes);
  const manifestBytes = files['injection.acmd'];
  const { metadata, signals } = manifestBytes
    ? parseManifest(new TextDecoder('utf-8').decode(manifestBytes))
    : { metadata: {}, signals: new Map<string, ManifestSignal>() };

  const run: Run = { name, vendor: 'Agilent', signals: [], metadata, skipped: [] };
  const used = new Set<string>();
  for (const member of Object.keys(files).sort()) {
    const base = member.slice(member.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = base.slice(dot);
    const kind = ext.toLowerCase();
    if (kind !== '.uv' && kind !== '.ch' && kind !== '.it') continue;
    if (kind === '.it' && !options.telemetry) continue;

    const guid = base.slice(0, dot);
    const entry = signals.get(guid.toLowerCase());
    const signalName = nameFor(entry, guid, ext, used);
    try {
      const decoded: Signal | null = kind === '.uv' ? parseUv(signalName, files[member]!) : parseCh(signalName, files[member]!);
      if (!decoded) {
        run.skipped.push({ path: `${path}/${signalName}`, reason: 'Unrecognized payload version.' });
        continue;
      }
      if (kind === '.uv') for (let i = 0; i < decoded.data.length; i++) decoded.data[i]! *= UV_FIXED_POINT_SHIFT;
      run.signals.push({
        ...decoded,
        detector: kind === '.uv' ? 'UV' : classify(entry),
        unit: entry?.unit ?? decoded.unit,
        metadata: signalMetadata(entry),
      });
    } catch (err) {
      run.skipped.push({ path: `${path}/${signalName}`, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return run;
}
