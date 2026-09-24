import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { overviewTrace, parseAia, parseFiles, readNetcdf } from '../src/index.js';
import type { Signal } from '../src/index.js';

/**
 * AIA / ANDI netCDF is checked two independent ways:
 * - against Unidata's netCDF C library through netCDF4-python
 *   (tools/make_aia_reference.py), and
 * - against what each file states about itself: detector minimum and
 *   maximum, run length, per-scan total intensity, point counts, scan
 *   indexes and m/z ranges.
 * Set NAGURA_EXTRA_AIA_REFERENCE to a reference folder (with manifest.json)
 * to also check files that are not committed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = [resolve(here, '../fixtures/aia'), resolve(here, '../../../fixtures/aia')].find(existsSync)!;

interface Summary {
  points: number;
  first_x: number;
  last_x: number;
  sum_y: number;
  moment_y: number;
  samples: Record<string, [number, number]>;
}

const close = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

function expectMatches(times: Float64Array, values: Float64Array, ref: Summary, what: string) {
  expect(times.length, `${what} points`).toBe(ref.points);
  expect(close(times[0]!, ref.first_x), `${what} first x`).toBe(true);
  expect(close(times[ref.points - 1]!, ref.last_x), `${what} last x`).toBe(true);
  const ys = Array.from(values);
  const scale = Math.max(...ys.map(Math.abs), 1e-300);
  const sum = ys.reduce((a, b) => a + b, 0);
  const moment = ys.reduce((a, b, i) => a + b * (i + 1), 0);
  expect(Math.abs(sum - ref.sum_y) <= 1e-9 * scale * ys.length, `${what} sum ${sum} vs ${ref.sum_y}`).toBe(true);
  expect(Math.abs(moment - ref.moment_y) <= 1e-9 * scale * ys.length * ys.length, `${what} moment`).toBe(true);
  for (const [i, [x, y]] of Object.entries(ref.samples)) {
    expect(close(times[Number(i)]!, x), `${what} x[${i}]`).toBe(true);
    expect(Math.abs(values[Number(i)]! - y) <= 1e-9 * scale, `${what} y[${i}]: ${values[Number(i)]} vs ${y}`).toBe(true);
  }
}

function referenceSets() {
  const sets = [{ root: join(here, 'reference-aia'), base: fixtures }];
  if (process.env.NAGURA_EXTRA_AIA_REFERENCE) sets.push({ root: resolve(process.env.NAGURA_EXTRA_AIA_REFERENCE), base: '' });
  return sets
    .filter((s) => existsSync(join(s.root, 'manifest.json')))
    .map((s) => ({ ...s, entries: JSON.parse(readFileSync(join(s.root, 'manifest.json'), 'utf8')) as { data: string; reference: string }[] }));
}

const pathOf = (base: string, data: string) => (base ? join(base, data) : data);

describe('AIA/ANDI against the Unidata netCDF library', () => {
  for (const set of referenceSets()) {
    for (const entry of set.entries) {
      it(entry.data.split('/').pop()!, { timeout: 60000 }, () => {
        const path = pathOf(set.base, entry.data);
        const signal = parseAia(path, readFileSync(path)).signals[0]!;
        const ref = JSON.parse(readFileSync(join(set.root, entry.reference), 'utf8'));
        // For MS, the reference is the TIC per scan: the overview trace sums every m/z bin.
        const values = ref.kind === 'ms' ? overviewTrace(signal).values : signal.data;
        expectMatches(signal.times, values, ref.spectra[0], entry.data);
      });
    }
  }
});

function allFiles(): string[] {
  const files = readdirSync(fixtures).filter((f) => /\.cdf$/i.test(f)).map((f) => join(fixtures, f));
  for (const set of referenceSets()) if (!set.base) files.push(...set.entries.map((e) => e.data));
  return [...new Set(files)];
}

/**
 * gc01_0812_066.cdf (PyMassSpec's example, extended set only) writes a
 * mass_range_max below the largest m/z of many scans (281 for a scan reaching
 * 341), so its ranges are not checked; its values match the reference.
 */
const WRONG_MASS_RANGE = new Set(['gc01_0812_066.cdf']);

const scalar = (nc: ReturnType<typeof readNetcdf>, key: string) => {
  if (!nc.variables.has(key)) return undefined;
  const v = nc.read(key);
  return typeof v === 'string' ? undefined : v;
};

describe("AIA/ANDI against each file's own checks", () => {
  for (const path of allFiles()) {
    it(path.split('/').pop()!, { timeout: 60000 }, () => {
      const bytes = readFileSync(path);
      const nc = readNetcdf(bytes);
      const signal: Signal = parseAia(path, bytes).signals[0]!;
      if (signal.detector !== 'MS') {
        // The data stays within the stated detector range.
        const max = scalar(nc, 'detector_maximum_value')?.[0];
        const min = scalar(nc, 'detector_minimum_value')?.[0];
        const data = Array.from(signal.data);
        // (Some writers give the data's range, others the detector's full scale.)
        const top = data.reduce((a, b) => Math.max(a, b), -Infinity);
        const bottom = data.reduce((a, b) => Math.min(a, b), Infinity);
        if (max !== undefined && max !== 0) expect(top <= max * (1 + 1e-6) + 1e-9, `max ${top} vs ${max}`).toBe(true);
        if (min !== undefined && min !== 0) expect(bottom >= min - Math.abs(min) * 1e-6 - 1e-9, `min ${bottom} vs ${min}`).toBe(true);
        // The run length matches the sampled points, to within a few sampling intervals
        // (writers differ on whether the delay and the last interval count).
        const length = scalar(nc, 'actual_run_time_length')?.[0];
        const interval = scalar(nc, 'actual_sampling_interval')?.[0];
        if (length && interval) expect(Math.abs(signal.times.length * interval - length), 'run length').toBeLessThanOrEqual(3 * interval);
      } else {
        const counts = scalar(nc, 'point_count')!;
        const index = scalar(nc, 'scan_index');
        // Scan indexes follow from the point counts.
        if (index) counts.forEach((_, i) => i > 0 && expect(index[i]! - index[i - 1]!, `scan_index ${i}`).toBe(counts[i - 1]));
        // total_intensity is each scan's sum; m/z stays within each scan's stated range.
        const total = scalar(nc, 'total_intensity');
        const tic = overviewTrace(signal).values;
        // Writers sum before rounding intensities to 32-bit floats, so allow float precision.
        if (total) {
          const worst = total.reduce((w, t, i) => Math.max(w, Math.abs(tic[i]! - t) / Math.max(1, Math.abs(t))), 0);
          expect(worst, 'total_intensity vs summed scans').toBeLessThan(1e-5);
        }
        const lo = scalar(nc, 'mass_range_min');
        const hi = scalar(nc, 'mass_range_max');
        const mz = scalar(nc, 'mass_values')!;
        if (lo && hi && !WRONG_MASS_RANGE.has(path.split('/').pop()!)) {
          let k = 0;
          let outside = 0;
          counts.forEach((c, i) => {
            // Ranges are often written as whole masses, and 0 to 0 means "not given".
            const given = lo[i]! < hi[i]!;
            for (let j = 0; j < c; j++, k++) if (given && (mz[k]! < lo[i]! - 1 || mz[k]! > hi[i]! + 1)) outside++;
          });
          expect(outside, 'm/z values outside their scan range').toBe(0);
        }
      }
    });
  }
});

const fixture = (name: string) => readFileSync(join(fixtures, name));

describe('AIA/ANDI chromatograms and scans', () => {
  it('reads an HPLC chromatogram: times from delay and interval, detector, metadata', () => {
    const run = parseAia('drop/hplc-uv.cdf', fixture('hplc-uv.cdf'));
    expect(run.vendor).toBe('AIA/ANDI');
    expect(run.metadata).toEqual({ sample: 'Synthetic mix A', date: '2026-09-24 08:30' });
    const s = run.signals[0]!;
    expect(s.xAxis).toBeUndefined();
    expect(s.detector).toBe('UV');
    expect(s.unit).toBe('mAU');
    expect(s.times[0]).toBeCloseTo(0.1, 12); // 6 s delay
    // The interval is stored as a 32-bit float.
    expect(s.times[1]! - s.times[0]!).toBeCloseTo(0.4 / 60, 8);
    expect(s.metadata.peaks).toBe(3);
    // The largest peak: 410 mAU at 845 s (sigma 6 s) on a 1.5 + 0.0004 t baseline; the nearest points are 844.8 and 845.2 s.
    const top = s.data.indexOf(Math.max(...s.data));
    expect(s.times[top]! * 60).toBeCloseTo(845.2, 4);
    expect(s.data[top]).toBeCloseTo(1.5 + 0.0004 * 845.2 + 410 * Math.exp(-0.5 * (0.2 / 6) ** 2), 3);
  });

  it('uses explicit retention times, in minutes when the file says so', () => {
    const s = parseAia('gc.cdf', fixture('gc-fid-retention.cdf')).signals[0]!;
    expect(s.detector).toBe('FID');
    expect(s.times.length).toBe(4501);
    expect(s.times[1500]).toBe(5);
    expect(s.times[1501]).toBeCloseTo(5.002, 12);
  });

  it('reads MS scans onto an m/z axis, with the scans stored as record variables too', () => {
    const a = parseAia('a.cdf', fixture('gcms-scans.cdf')).signals[0]!;
    const b = parseAia('b.cdf', fixture('gcms-record-vars.cdf')).signals[0]!;
    expect(a.detector).toBe('MS');
    [60, 60.5, 61, 61.5, 62, 62.5].forEach((t, i) => expect(a.times[i]).toBeCloseTo(t / 60, 12));
    expect(Array.from(a.ylabels)).toEqual([39, 41, 43, 51, 57, 65, 71, 77, 78, 91, 92]);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
    // Scan 5 is empty; scan 3 holds 12000 at m/z 78.
    expect(overviewTrace(a).values[4]).toBe(0);
    expect(a.data[2 * a.ylabels.length + 8]).toBe(12000);
  });

  it('reads CDF-5 (64-bit data) files', () => {
    const nc = readNetcdf(fixture('elsd-cdf5.cdf'));
    expect(nc.version).toBe(5);
    expect(parseAia('e.cdf', fixture('elsd-cdf5.cdf')).signals[0]!.detector).toBe('ELSD');
  });
});

describe('recognizing AIA files by content', () => {
  it('reads .cdf files among other dropped files and explains the ones it cannot read', () => {
    const hdf5 = new Uint8Array(64);
    hdf5.set([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
    const runs = parseFiles([
      { path: 'x/hplc-uv.CDF', bytes: fixture('hplc-uv.cdf') },
      { path: 'x/new.cdf', bytes: hdf5 },
      { path: 'x/notes.cdf', bytes: new TextEncoder().encode('not netcdf at all, just text in a file') },
    ]);
    expect(runs.map((r) => [r.name, r.signals.length])).toEqual([
      ['hplc-uv.CDF', 1],
      ['new.cdf', 0],
      ['notes.cdf', 0],
    ]);
    expect(runs[1]!.skipped[0]!.reason).toMatch(/netCDF-4/);
    expect(runs[2]!.skipped[0]!.reason).toMatch(/Not a netCDF file/);
  });

  it('refuses a netCDF file that is not AIA data', () => {
    // The header of a CDF-1 file with no dimensions, attributes or variables.
    const empty = new Uint8Array(32);
    empty.set([0x43, 0x44, 0x46, 0x01]);
    expect(() => parseAia('other.cdf', empty)).toThrow(/not an AIA/);
  });
});
