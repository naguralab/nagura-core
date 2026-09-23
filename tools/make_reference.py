"""
Builds reference outputs for the parser tests from rainbow, the Python
library whose format knowledge @naguralab/core ports.

    pip install rainbow-api
    python3 tools/make_reference.py                       # committed fixtures
    python3 tools/make_reference.py IN_DIR OUT_DIR        # any other folder of .D runs and .dx files

Each data file gets a JSON summary (shape, labels, row and column sums,
sampled rows, header metadata). The tests decode the same file and compare.
A manifest.json in OUT_DIR maps each summary to its data file (relative to
the fixtures folder for the committed set, absolute otherwise).
"""

import json
import os
import sys

import numpy as np
from rainbow.agilent import chemstation, openlab

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_IN = os.path.join(ROOT, 'fixtures', 'agilent')
# The monorepo keeps the core in packages/core; the public nagura-core repo at the root.
_CORE = os.path.join(ROOT, 'packages', 'core') if os.path.isdir(os.path.join(ROOT, 'packages', 'core')) else ROOT
DEFAULT_OUT = os.path.join(_CORE, 'test', 'reference')


def floats(a):
    return [None if not np.isfinite(x) else float(x) for x in np.asarray(a, dtype=np.float64).ravel()]


def summarize(df):
    data = np.asarray(df.data, dtype=np.float64)
    n_times = data.shape[0]
    sample_rows = sorted({0, n_times // 3, n_times // 2, n_times - 1})
    ylabels = []
    for y in df.ylabels:
        try:
            ylabels.append(float(y))
        except (TypeError, ValueError):
            ylabels.append(None)
    metadata = {k: v for k, v in df.metadata.items() if k != 'unit'}
    return {
        'detector': df.detector,
        'unit': df.metadata.get('unit', ''),
        'shape': list(data.shape),
        'ylabels': ylabels,
        'times': floats(df.xlabels),
        'row_sums': floats(data.sum(axis=1)),
        'col_sums': floats(data.sum(axis=0)),
        'sample_rows': {str(i): floats(data[i]) for i in sample_rows},
        'metadata': {k: (v if isinstance(v, (int, float)) else str(v)) for k, v in metadata.items()},
    }


def main(in_dir, out_dir, relative):
    manifest = []
    os.makedirs(out_dir, exist_ok=True)
    for run in sorted(os.listdir(in_dir)):
        run_dir = os.path.join(in_dir, run)
        if run.lower().endswith('.dx') and os.path.isfile(run_dir):
            archive = openlab.read(run_dir)
            for df in archive.datafiles if archive else []:
                ref_name = f'{run}__{df.name}.json'
                with open(os.path.join(out_dir, ref_name), 'w') as f:
                    json.dump(summarize(df), f)
                data_path = os.path.relpath(run_dir, in_dir) if relative else os.path.abspath(run_dir)
                manifest.append({'data': data_path, 'reference': ref_name, 'member': df.name})
                print(f'{run}/{df.name}: {df.detector} {df.data.shape}')
            continue
        if not (os.path.isdir(run_dir) and run.upper().endswith('.D')):
            continue
        for name in sorted(os.listdir(run_dir)):
            path = os.path.join(run_dir, name)
            if os.path.splitext(name)[1].lower() not in ('.ch', '.uv', '.ms'):
                continue
            df = chemstation.parse_file(path)
            if df is None:
                print(f'skip (rainbow reads nothing): {run}/{name}')
                continue
            ref_name = f'{run}__{name}.json'
            os.makedirs(out_dir, exist_ok=True)
            with open(os.path.join(out_dir, ref_name), 'w') as f:
                json.dump(summarize(df), f)
            data_path = os.path.relpath(path, in_dir) if relative else os.path.abspath(path)
            manifest.append({'data': data_path, 'reference': ref_name})
            print(f'{run}/{name}: {df.detector} {df.data.shape}')
    with open(os.path.join(out_dir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)


if __name__ == '__main__':
    if len(sys.argv) == 3:
        main(sys.argv[1], sys.argv[2], relative=False)
    else:
        main(DEFAULT_IN, DEFAULT_OUT, relative=True)
