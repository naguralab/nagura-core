import { describe, expect, it } from 'vitest';
import { runsToCsv, windowRowsToCsv, windowStats } from '../src/index.js';
import type { Run } from '../src/index.js';

/** A Gaussian peak on a sloping baseline, sampled every 0.01 min. */
function synthetic() {
  const times: number[] = [];
  const values: number[] = [];
  for (let i = 0; i <= 1000; i++) {
    const t = i * 0.01; // 0..10 min
    const peak = 100 * Math.exp(-((t - 5) ** 2) / (2 * 0.05 ** 2)); // height 100, sigma 0.05 min
    times.push(t);
    values.push(peak + 2 + 0.5 * t); // baseline 2 + 0.5 t
  }
  return { times, values };
}

describe('windowStats', () => {
  it('finds the apex and the peak area above a sloping baseline', () => {
    const { times, values } = synthetic();
    const r = windowStats(times, values, { label: 'peak', start: 4.5, end: 5.5 });
    expect(r.points).toBe(101);
    expect(r.rtAtMax).toBeCloseTo(5, 6);
    expect(r.max).toBeCloseTo(100 + 2 + 2.5, 6);
    // Gaussian area = height * sigma * sqrt(2 pi), in minutes; * 60 for seconds.
    const expected = 100 * 0.05 * Math.sqrt(2 * Math.PI) * 60;
    expect(r.areaAboveBaseline!).toBeCloseTo(expected, 1);
    // Raw area adds the baseline trapezoid: (4.25 + 4.75) / 2 * 1 min * 60.
    expect(r.area!).toBeCloseTo(expected + ((4.25 + 4.75) / 2) * 60, 1);
  });

  it('handles reversed, empty and one-point windows', () => {
    const { times, values } = synthetic();
    expect(windowStats(times, values, { label: 'r', start: 5.5, end: 4.5 }).points).toBe(101);
    const empty = windowStats(times, values, { label: 'e', start: 20, end: 21 });
    expect([empty.points, empty.max, empty.area]).toEqual([0, null, null]);
    const one = windowStats(times, values, { label: 'o', start: 5, end: 5 });
    expect(one.points).toBe(1);
    expect(one.area).toBeNull();
    expect(one.max).not.toBeNull();
  });
});

describe('batch CSV', () => {
  it('writes the run table and window table', () => {
    const runs: Run[] = [
      { name: 'a.D', vendor: 'Agilent', signals: [], metadata: { sample: 'Std, 1 mg/mL', date: '27-Feb-18' }, skipped: [] },
    ];
    const csv = runsToCsv(runs).trim().split('\n');
    expect(csv[0]).toBe('Run,Sample,Date,Method,Vial,Operator,Signals');
    expect(csv[1]).toBe('a.D,"Std, 1 mg/mL",27-Feb-18,,,,');
    const rows = windowRowsToCsv([
      { run: 'a.D', sample: '', trace: 'DAD1A.ch 254 nm', unit: 'mAU', result: { label: 'p1', start: 1, end: 2, points: 3, max: 5, rtAtMax: 1.5, area: 10, areaAboveBaseline: 4 } },
    ]).trim().split('\n');
    expect(rows[1]).toBe('a.D,,DAD1A.ch 254 nm,p1,1,2,3,1.5,5,10,4,mAU');
  });
});
