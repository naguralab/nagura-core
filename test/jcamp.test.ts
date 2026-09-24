import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isJcampBytes, parseFiles, parseJcamp, signalToCsv, overviewTrace, tracesToCsv } from '../src/index.js';
import { decodeXppYY, tokenize } from '../src/jcamp/jcamp.js';
import type { Signal } from '../src/index.js';

/**
 * JCAMP-DX is checked two independent ways:
 * - against jcampconverter 10.0.2 (tools/make_jcamp_reference.mjs), and
 * - against the values every file states about itself: NPOINTS, FIRSTY and
 *   the X value at the start of each data line.
 * Set NAGURA_EXTRA_JCAMP_REFERENCE to a reference folder (with manifest.json)
 * to also check files that are not committed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = [resolve(here, '../fixtures/jcamp'), resolve(here, '../../../fixtures/jcamp')].find(existsSync)!;

interface Summary {
  points: number;
  first_x: number;
  last_x: number;
  sum_y: number;
  moment_y: number;
  samples: Record<string, [number, number]>;
}

function close(actual: number, expected: number, rel = 1e-9): boolean {
  return Math.abs(actual - expected) <= rel * Math.max(1, Math.abs(expected));
}

function expectMatches(signal: Signal, ref: Summary, what: string) {
  expect(signal.times.length, `${what} points`).toBe(ref.points);
  // x is computed from FIRSTX, LASTX and NPOINTS, so allow for rounding on large axes.
  expect(close(signal.times[0]!, ref.first_x, 1e-8), `${what} first x ${signal.times[0]} vs ${ref.first_x}`).toBe(true);
  expect(close(signal.times[ref.points - 1]!, ref.last_x, 1e-8), `${what} last x`).toBe(true);
  const ys = Array.from(signal.data);
  const scale = Math.max(...ys.map(Math.abs), 1e-300);
  const sum = ys.reduce((a, b) => a + b, 0);
  const moment = ys.reduce((a, b, i) => a + b * (i + 1), 0);
  expect(Math.abs(sum - ref.sum_y) <= 1e-9 * scale * ys.length, `${what} sum ${sum} vs ${ref.sum_y}`).toBe(true);
  expect(Math.abs(moment - ref.moment_y) <= 1e-9 * scale * ys.length * ys.length, `${what} moment`).toBe(true);
  for (const [i, [x, y]] of Object.entries(ref.samples)) {
    expect(close(signal.times[Number(i)]!, x, 1e-8), `${what} x[${i}]`).toBe(true);
    expect(Math.abs(signal.data[Number(i)]! - y) <= 1e-9 * scale, `${what} y[${i}]: ${signal.data[Number(i)]} vs ${y}`).toBe(true);
  }
}

function referenceSets(): { root: string; base: string; entries: { data: string; reference: string }[] }[] {
  const sets = [{ root: join(here, 'reference-jcamp'), base: fixtures }];
  if (process.env.NAGURA_EXTRA_JCAMP_REFERENCE) sets.push({ root: resolve(process.env.NAGURA_EXTRA_JCAMP_REFERENCE), base: '' });
  return sets
    .filter((s) => existsSync(join(s.root, 'manifest.json')))
    .map((s) => ({ ...s, entries: JSON.parse(readFileSync(join(s.root, 'manifest.json'), 'utf8')) }));
}

describe('JCAMP-DX against jcampconverter', () => {
  for (const set of referenceSets()) {
    for (const entry of set.entries) {
      it(entry.data.split('/').pop()!, () => {
        const path = set.base ? join(set.base, entry.data) : entry.data;
        const run = parseJcamp(path, readFileSync(path));
        const ref = JSON.parse(readFileSync(join(set.root, entry.reference), 'utf8')) as { spectra: Summary[] };
        expect(run.signals.length).toBe(ref.spectra.length);
        run.signals.forEach((s, i) => expectMatches(s, ref.spectra[i]!, `${entry.data}[${i}]`));
      });
    }
  }
});

/** Header values of the first block, as written. */
function header(text: string, label: string): number | undefined {
  const m = new RegExp(`^\\s*##${label}=\\s*([^\\r\\n$]+)`, 'im').exec(text);
  return m ? Number(m[1]!.replace(/\s+/g, '')) : undefined;
}

describe("JCAMP-DX against each file's own checks", () => {
  for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.jdx'))) {
    it(name, () => {
      const bytes = readFileSync(join(fixtures, name));
      const text = bytes.toString('latin1');
      const run = parseJcamp(name, bytes);
      expect(run.skipped).toEqual([]);
      const signal = run.signals[0]!;
      const npoints = header(text, 'NPOINTS');
      if (npoints !== undefined) expect(signal.times.length).toBe(npoints);

      const firstX = header(text, 'FIRSTX');
      const lastX = header(text, 'LASTX');
      const firstY = header(text, 'FIRSTY');
      if (firstY !== undefined && firstX !== undefined && lastX !== undefined) {
        // FIRSTY is the value at FIRSTX; rows are stored ascending.
        const y0 = firstX <= lastX ? signal.data[0]! : signal.data[signal.data.length - 1]!;
        // Stored values are whole multiples of YFACTOR, and FIRSTY is often written with few digits:
        // this catches a wrong point or factor; exact values are checked against the reference.
        const step = Math.abs(header(text, 'YFACTOR') ?? 0);
        expect(Math.abs(y0 - firstY) <= step + 1e-4 * Math.abs(firstY), `FIRSTY: got ${y0}, file says ${firstY}`).toBe(true);
      }

      // Every (X++(Y..Y)) line starts with the X of its first ordinate.
      const table = /##XYDATA=\s*\(X\+\+\(Y\.\.Y\)\)[^\n]*\n([\s\S]*?)(?:\n\s*##|$)/i.exec(text);
      if (table && firstX !== undefined && lastX !== undefined && npoints) {
        const starts: { x: number; index: number }[] = [];
        decodeXppYY(table[1]!.split(/\r?\n/), starts);
        const xFactor = header(text, 'XFACTOR') ?? 1;
        const step = (lastX - firstX) / (npoints - 1);
        let worst = 0;
        for (const s of starts) worst = Math.max(worst, Math.abs((s.x * xFactor - (firstX + s.index * step)) / step));
        expect(starts.length).toBeGreaterThan(0);
        expect(worst, 'X check: lines out of step with the decoded points').toBeLessThan(0.1);
      }
    });
  }
});

describe('JCAMP-DX encodings', () => {
  it('reads SQZ, DIF, DUP and PAC values', () => {
    expect(tokenize('1@A1b2')).toEqual([
      { kind: 'abs', value: 1 },
      { kind: 'abs', value: 0 },
      { kind: 'abs', value: 11 },
      { kind: 'abs', value: -22 },
    ]);
    expect(tokenize('A%J1j2T')).toEqual([
      { kind: 'abs', value: 1 },
      { kind: 'dif', value: 0 },
      { kind: 'dif', value: 11 },
      { kind: 'dif', value: -12 },
      { kind: 'dup', count: 2 },
    ]);
    expect(tokenize('10+2-3 4,5')).toEqual([10, 2, -3, 4, 5].map((value) => ({ kind: 'abs', value })));
    expect(tokenize('1 ? 2')[1]!).toMatchObject({ kind: 'abs' });
  });

  it('tells an exponent from an SQZ digit', () => {
    expect(tokenize('1.5E+03 2e-2')).toEqual([
      { kind: 'abs', value: 1500 },
      { kind: 'abs', value: 0.02 },
    ]);
    // Without a sign, E is SQZ +5: "4400E839" is the X value 4400, then 5839.
    expect(tokenize('4400E839')).toEqual([
      { kind: 'abs', value: 4400 },
      { kind: 'abs', value: 5839 },
    ]);
  });

  it('drops the check value after a DIF line and repeats differences', () => {
    // 10, +1, +1 (DUP 2) | check 12, then +1 (DUP 3) | check 15
    expect(decodeXppYY(['1 A0JT', '4 A2JU', '7 A5'])).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('counts the check value as the first of a DUP', () => {
    // As dupinc2.jdx: "A666T" after a DIF line is the check value 1666 plus one more 1666.
    expect(decodeXppYY(['1 A707m1', '3 A666TL1'])).toEqual([1707, 1666, 1666, 1697]);
  });

  it('applies a factor whose line carries a comment', () => {
    const run = parseJcamp('jtpolys.jdx', readFileSync(join(fixtures, 'jtpolys.jdx')));
    expect(close(run.signals[0]!.data[0]!, 0.9816334969, 1e-8)).toBe(true);
  });

  it('refuses a table whose point count does not match NPOINTS', () => {
    const text = '##TITLE=bad\n##XUNITS=1/CM\n##YUNITS=ABSORBANCE\n##FIRSTX=1\n##LASTX=4\n##NPOINTS=4\n##XYDATA=(X++(Y..Y))\n1 1 2 3\n##END=\n';
    const run = parseJcamp('bad.jdx', new TextEncoder().encode(text));
    expect(run.signals).toEqual([]);
    expect(run.skipped[0]!.reason).toMatch(/declares 4 points but contains 3/);
  });
});

const COMPOUND = `##TITLE= Two spectra $$ link block
##JCAMP-DX= 5.01
##DATA TYPE= LINK
##BLOCKS= 2
##TITLE= IR, descending wavenumbers
##JCAMP-DX= 4.24
##DATA TYPE= INFRARED SPECTRUM
##XUNITS= 1/CM
##YUNITS= ABSORBANCE
##XFACTOR= 1
##YFACTOR= 0.001
##FIRSTX= 4000
##LASTX= 3994
##NPOINTS= 4
##FIRSTY= 0.1
##XYDATA= (X++(Y..Y))
4000 100 200 300 400
##END=
##TITLE= MS peaks
##DATA TYPE= MASS SPECTRUM
##DATA CLASS= PEAK TABLE
##XUNITS= M/Z
##YUNITS= RELATIVE ABUNDANCE
##NPOINTS= 3
##PEAK TABLE= (XY..XY)
43,100; 29,55.5; 58,12
##END=
##TITLE= FID
##DATA TYPE= NMR FID
##NTUPLES= NMR FID
##END NTUPLES= NMR FID
##END=
##END=
`;

describe('JCAMP-DX compound files and axes', () => {
  const run = parseJcamp('pair.jdx', new TextEncoder().encode(COMPOUND));

  it('reads every block as its own signal', () => {
    expect(run.vendor).toBe('JCAMP-DX');
    expect(run.metadata.sample).toBe('Two spectra');
    expect(run.signals.map((s) => s.name)).toEqual(['IR, descending wavenumbers', 'MS peaks']);
    expect(run.skipped).toHaveLength(1);
    expect(run.skipped[0]!.reason).toMatch(/NTUPLES/);
  });

  it('stores rows ascending and marks the IR axis as reversed', () => {
    const ir = run.signals[0]!;
    expect(Array.from(ir.times)).toEqual([3994, 3996, 3998, 4000]);
    [0.4, 0.3, 0.2, 0.1].forEach((y, i) => expect(ir.data[i]).toBeCloseTo(y, 12));
    expect(ir.xAxis).toEqual({ label: 'Wavenumber', unit: 'cm⁻¹', reversed: true });
    expect(ir.technique).toBe('IR spectrum');
    expect(ir.unit).toBe('Absorbance');
  });

  it('reads a peak table as sticks', () => {
    const ms = run.signals[1]!;
    expect(ms.sticks).toBe(true);
    expect(Array.from(ms.times)).toEqual([29, 43, 58]);
    expect(Array.from(ms.data)).toEqual([55.5, 100, 12]);
    expect(ms.xAxis).toEqual({ label: 'm/z', unit: '' });
  });

  it('labels CSV columns with the spectral axis', () => {
    const ir = run.signals[0]!;
    expect(signalToCsv(ir).split('\n')[0]).toBe('Wavenumber (cm⁻¹),"IR, descending wavenumbers (Absorbance)"');
    expect(tracesToCsv([overviewTrace(ir)]).split('\n')[0]).toBe('Wavenumber (cm⁻¹),"IR, descending wavenumbers (Absorbance)"');
  });

  it('converts NMR Hz to ppm with the observe frequency', () => {
    const nmr = `##TITLE=h\n##DATA TYPE=NMR SPECTRUM\n##.OBSERVE FREQUENCY=100\n##XUNITS=HZ\n##YUNITS=ARBITRARY UNITS\n##FIRSTX=1000\n##LASTX=0\n##NPOINTS=3\n##XYDATA=(X++(Y..Y))\n1000 1 2 3\n##END=\n`;
    const s = parseJcamp('h.jdx', new TextEncoder().encode(nmr)).signals[0]!;
    expect(Array.from(s.times)).toEqual([0, 5, 10]);
    expect(s.xAxis).toEqual({ label: 'Chemical shift', unit: 'ppm', reversed: true });
  });
});

describe('recognizing files by content', () => {
  it('tells a JCAMP-DX .dx from an OpenLab .dx', () => {
    expect(isJcampBytes(new TextEncoder().encode(COMPOUND))).toBe(true);
    expect(isJcampBytes(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(false);
    const runs = parseFiles([{ path: 'drop/pair.dx', bytes: new TextEncoder().encode(COMPOUND) }]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.vendor).toBe('JCAMP-DX');
    expect(runs[0]!.signals).toHaveLength(2);
  });
});
