import { binPairs, type MsOptions } from '../agilent/chemstation.js';
import { isNetcdfBytes, numbers, readNetcdf, text, type NcFile } from '../netcdf/netcdf.js';
import { ParseError, type Detector, type Run, type Signal } from '../types.js';

/**
 * AIA / ANDI netCDF (`.cdf`): the vendor-neutral export of almost every
 * chromatography data system (ASTM E1947, chromatography) and of GC-MS
 * software (ASTM E2077, mass spectrometry). The files are netCDF classic;
 * the variable and attribute names are those of the public ANDI templates.
 *
 * Chromatography files give one chromatogram (`ordinate_values`, times from
 * `actual_delay_time` and `actual_sampling_interval`, or `raw_data_retention`).
 * MS files give scans (`scan_acquisition_time`, `mass_values`,
 * `intensity_values`), binned onto a shared m/z axis like ChemStation `.ms`.
 */

/** True for a `.cdf` path; the bytes decide (netCDF is used for more than chromatography). */
export function isAiaPath(path: string): boolean {
  return /\.cdf$/i.test(path);
}

/** True for netCDF bytes: whether it is AIA data is decided when the variables are read. */
export function isAiaBytes(bytes: Uint8Array): boolean {
  return isNetcdfBytes(bytes);
}

function detectorOf(name: string, unit: string): Detector {
  const s = `${name} ${unit}`;
  if (/\bFID\b|flame ion/i.test(s)) return 'FID';
  if (/\bELSD\b|evaporative/i.test(s)) return 'ELSD';
  if (/\bCAD\b|charged aerosol|corona/i.test(s)) return 'CAD';
  if (/\bRID?\b|refractive/i.test(s)) return 'RID';
  if (/\bUV\b|\bDAD\b|\bPDA\b|\bVWD\b|absorb|\bm?AU\b/i.test(s)) return 'UV';
  return null;
}

/** Seconds per stored time unit: the ANDI default is seconds; some writers say minutes. */
function secondsPer(unit: string): number {
  if (/^min/i.test(unit)) return 60;
  if (/^(ms|millisec)/i.test(unit)) return 0.001;
  return 1;
}

/** "YYYYMMDDhhmmss±ZZZZ" (ANDI) as "YYYY-MM-DD hh:mm"; other text as written. */
function stamp(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : value;
}

const METADATA: [string, string][] = [
  ['sample_name', 'sample'],
  ['sample_id', 'sample id'],
  ['experiment_title', 'title'],
  ['operator_name', 'operator'],
  ['detector_name', 'detector'],
  ['separation_experiment_type', 'separation'],
  ['company_method_name', 'method'],
  ['dataset_origin', 'origin'],
  ['instrument_name', 'instrument'],
  ['source_file_reference', 'source file'],
];

function metadataOf(nc: NcFile): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, label] of METADATA) {
    const v = text(nc.attributes, key);
    if (v && !(label in out)) out[label] = v;
  }
  const date = text(nc.attributes, 'injection_date_time_stamp') || text(nc.attributes, 'experiment_date_time_stamp');
  if (date) out.date = stamp(date);
  return out;
}

function chromatogram(nc: NcFile, name: string): Signal {
  const y = numbers(nc, 'ordinate_values')!;
  const retention = numbers(nc, 'raw_data_retention');
  const toMin = secondsPer(text(nc.attributes, 'retention_unit')) / 60;
  let times: Float64Array;
  if (retention && retention.length === y.length) {
    times = Float64Array.from(retention, (t) => t * toMin);
  } else {
    const interval = numbers(nc, 'actual_sampling_interval')?.[0];
    const delay = numbers(nc, 'actual_delay_time')?.[0] ?? 0;
    if (!(interval && interval > 0)) throw new ParseError('The file gives no sampling interval (actual_sampling_interval).');
    times = Float64Array.from(y, (_, i) => (delay + i * interval) * toMin);
  }
  const unit = text(nc.attributes, 'detector_unit') || text(nc.variables.get('ordinate_values')!.attributes, 'units');
  const peaks = numbers(nc, 'peak_retention_time')?.length ?? 0;
  const metadata = metadataOf(nc);
  if (peaks) metadata.peaks = peaks;
  return {
    name,
    detector: detectorOf(text(nc.attributes, 'detector_name'), unit),
    times,
    ylabels: new Float64Array([Number.NaN]),
    data: y,
    unit,
    metadata,
  };
}

function massSpectra(nc: NcFile, name: string, options: MsOptions): Signal {
  const time = numbers(nc, 'scan_acquisition_time')!;
  const counts = numbers(nc, 'point_count');
  const index = numbers(nc, 'scan_index');
  const mz = numbers(nc, 'mass_values')!;
  const intensity = numbers(nc, 'intensity_values')!;
  if (mz.length !== intensity.length) throw new ParseError('mass_values and intensity_values differ in length.');
  const n = time.length;
  // Pairs per scan: point_count, or the gaps between scan_index entries.
  const per = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    per[i] = counts ? counts[i]! : index ? (i + 1 < n ? index[i + 1]! : mz.length) - index[i]! : 0;
  }
  if (!counts && !index) throw new ParseError('The file gives neither point_count nor scan_index.');
  const total = per.reduce((a, b) => a + b, 0);
  if (total > mz.length) throw new ParseError(`The scans hold ${total} points but the file stores ${mz.length}.`);
  const toMin = secondsPer(text(nc.variables.get('scan_acquisition_time')!.attributes, 'units')) / 60;
  const scans = {
    times: Float64Array.from(time, (t) => t * toMin),
    counts: per,
    mz: mz.subarray(0, total),
    intensity: intensity.subarray(0, total),
  };
  const { ylabels, data } = binPairs(scans, options.binWidth ?? 1);
  const metadata = metadataOf(nc);
  metadata.scans = n;
  return { name, detector: 'MS', times: scans.times, ylabels, data, unit: text(nc.attributes, 'intensity_axis_units') || 'counts', metadata };
}

/** Decodes an AIA / ANDI `.cdf` file into one run. */
export function parseAia(path: string, bytes: Uint8Array, options: MsOptions = {}): Run {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const nc = readNetcdf(bytes);
  let signal: Signal;
  if (nc.variables.has('ordinate_values')) signal = chromatogram(nc, fileName);
  else if (nc.variables.has('mass_values') && nc.variables.has('scan_acquisition_time')) signal = massSpectra(nc, fileName, options);
  else throw new ParseError('This netCDF file is not an AIA/ANDI chromatogram or mass spectrometry file.');
  const run: Run = { name: fileName, vendor: 'AIA/ANDI', signals: [signal], metadata: {}, skipped: [] };
  if (signal.metadata.sample) run.metadata.sample = signal.metadata.sample;
  if (signal.metadata.date) run.metadata.date = signal.metadata.date;
  return run;
}
