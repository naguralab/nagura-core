#!/usr/bin/env python3
"""Builds reference outputs for the AIA / ANDI tests with the Unidata netCDF library.

    pip install netCDF4 numpy
    python3 tools/make_aia_reference.py                  # committed fixtures
    python3 tools/make_aia_reference.py IN_DIR OUT_DIR   # any other folder

netCDF4-python (MIT) wraps Unidata's C library, independent of the TypeScript
reader. For chromatograms the reference holds times (minutes) and values;
for MS files every scan's time and summed intensity (TIC) and the pair count.
The reference applies the ANDI rules itself: times in seconds unless
retention_unit says minutes, from raw_data_retention when present.
"""
import json
import os
import sys

import netCDF4
import numpy as np


def summary(x, y):
    order = np.argsort(x, kind='stable')
    xs, ys = np.asarray(x, float)[order], np.asarray(y, float)[order]
    n = len(xs)
    samples = {}
    for k in range(21):
        i = round(k * (n - 1) / 20)
        samples[str(i)] = [float(xs[i]), float(ys[i])]
    return {
        'points': n,
        'first_x': float(xs[0]),
        'last_x': float(xs[-1]),
        'sum_y': float(ys.sum()),
        'moment_y': float((ys * np.arange(1, n + 1)).sum()),
        'samples': samples,
    }


def minutes_per(unit):
    unit = (unit or '').strip().lower()
    return 1.0 if unit.startswith('min') else 1 / 60


def reference(path):
    with netCDF4.Dataset(path) as f:
        f.set_auto_mask(False)
        v = f.variables
        if 'ordinate_values' in v:
            y = v['ordinate_values'][:]
            scale = minutes_per(getattr(f, 'retention_unit', ''))
            if 'raw_data_retention' in v and len(v['raw_data_retention']) == len(y):
                t = v['raw_data_retention'][:] * scale
            else:
                delay = float(v['actual_delay_time'][...]) if 'actual_delay_time' in v else 0.0
                t = (delay + float(v['actual_sampling_interval'][...]) * np.arange(len(y))) * scale
            return {'kind': 'chromatogram', 'spectra': [summary(t, y)]}
        t = v['scan_acquisition_time'][:] * minutes_per(getattr(v['scan_acquisition_time'], 'units', 'seconds'))
        counts = v['point_count'][:]
        inten = v['intensity_values'][:].astype(float)
        edges = np.concatenate([[0], np.cumsum(counts)])
        tic = [float(inten[edges[i]:edges[i + 1]].sum()) for i in range(len(counts))]
        return {'kind': 'ms', 'points': int(counts.sum()), 'mz_sum': float(v['mass_values'][: int(counts.sum())].astype(float).sum()),
                'spectra': [summary(t, tic)]}


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    core = os.path.join(root, 'packages', 'core') if os.path.isdir(os.path.join(root, 'packages', 'core')) else root
    in_dir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'fixtures', 'aia'))
    out_dir = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(core, 'test', 'reference-aia'))
    committed = in_dir == os.path.join(root, 'fixtures', 'aia')
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    for name in sorted(os.listdir(in_dir)):
        if not name.lower().endswith('.cdf'):
            continue
        path = os.path.join(in_dir, name)
        try:
            ref = reference(path)
        except Exception as err:  # not an ANDI file, or netCDF4 cannot read it
            print(f'{name}: skipped ({err})')
            continue
        with open(os.path.join(out_dir, name + '.json'), 'w') as f:
            json.dump(ref, f)
            f.write('\n')
        manifest.append({'data': name if committed else path, 'reference': name + '.json'})
        print(f"{name}: {ref['kind']}, {ref['spectra'][0]['points']} rows")
    with open(os.path.join(out_dir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
        f.write('\n')
