#!/usr/bin/env python3
"""Writes the synthetic AIA / ANDI netCDF test files in fixtures/aia.

The chromatograms and spectra are made up (Gaussian peaks on a baseline), so
the files carry no third-party rights. Variable and attribute names follow the
public ANDI templates (ASTM E1947 chromatography, E2077 mass spectrometry).

    pip install scipy numpy netCDF4
    python3 tools/make_aia_fixtures.py [OUT_DIR]

scipy (BSD) writes the classic and 64-bit offset files; netCDF4 (MIT, the
Unidata library) writes the CDF-5 file. The output is reproducible.
"""
import math
import os
import sys

import numpy as np
from scipy.io import netcdf_file


def gauss(t, center, width, height):
    return height * np.exp(-0.5 * ((t - center) / width) ** 2)


def put_attrs(f, attrs):
    for k, v in attrs.items():
        setattr(f, k, v)


def hplc_uv(path):
    """Chromatography, CDF-1: evenly sampled, times from delay and interval, with a peak table."""
    interval, delay, n = 0.4, 6.0, 3000  # seconds
    t = delay + interval * np.arange(n)
    y = 1.5 + 0.0004 * t + gauss(t, 180, 3, 250) + gauss(t, 420, 4, 90) + gauss(t, 845, 6, 410)
    with netcdf_file(path, 'w', version=1) as f:
        put_attrs(f, {
            'dataset_completeness': 'C1+C2', 'aia_template_revision': '1.0', 'netcdf_revision': '2.3',
            'languages': 'English only', 'dataset_origin': 'Nagura Lab test data', 'dataset_owner': 'public domain',
            'injection_date_time_stamp': '20260924083000+0200', 'experiment_title': 'Synthetic HPLC run',
            'operator_name': 'Nagura Lab', 'separation_experiment_type': 'liquid chromatography',
            'sample_name': 'Synthetic mix A', 'sample_id': 'S-001', 'detector_name': 'UV 254 nm',
            'detector_unit': 'mAU', 'retention_unit': 'Seconds', 'raw_data_table_name': 'Synthetic mix A',
        })
        f.createDimension('_2_byte_string', 2)
        f.createDimension('_30_byte_string', 30)
        f.createDimension('point_number', n)
        f.createDimension('peak_number', 3)
        for key, value in [('actual_sampling_interval', interval), ('actual_delay_time', delay),
                           ('actual_run_time_length', interval * n), ('detector_maximum_value', float(y.max())),
                           ('detector_minimum_value', float(y.min()))]:
            f.createVariable(key, 'f', ())[()] = value
        f.createVariable('ordinate_values', 'f', ('point_number',))[:] = y.astype('f4')
        f.createVariable('peak_retention_time', 'f', ('peak_number',))[:] = [180, 420, 845]
        f.createVariable('peak_height', 'f', ('peak_number',))[:] = [250, 90, 410]
        names = f.createVariable('peak_name', 'c', ('peak_number', '_30_byte_string'))
        for i, name in enumerate(['caffeine', 'theobromine', 'unknown']):
            names[i] = np.array(list(name.ljust(30, '\0')), dtype='S1')


def gc_fid_retention(path):
    """Chromatography, 64-bit offset (CDF-2): explicit, unevenly spaced retention times in minutes, doubles."""
    t = np.concatenate([np.linspace(0, 5, 1501), np.linspace(5.002, 20, 3000)])
    y = 10 + gauss(t, 2.4, 0.02, 800) + gauss(t, 7.7, 0.03, 350) + gauss(t, 15.1, 0.05, 1200)
    with netcdf_file(path, 'w', version=2) as f:
        put_attrs(f, {
            'aia_template_revision': '1.0', 'dataset_origin': 'Nagura Lab test data', 'dataset_owner': 'public domain',
            'injection_date_time_stamp': '20251103141500-0500', 'sample_name': 'Synthetic hydrocarbons',
            'detector_name': 'FID', 'detector_unit': 'pA', 'retention_unit': 'Minutes',
        })
        f.createDimension('point_number', len(t))
        f.createVariable('ordinate_values', 'd', ('point_number',))[:] = y
        f.createVariable('raw_data_retention', 'd', ('point_number',))[:] = t
        f.createVariable('actual_sampling_interval', 'f', ())[()] = 0
        f.createVariable('detector_maximum_value', 'd', ())[()] = float(y.max())
        f.createVariable('detector_minimum_value', 'd', ())[()] = float(y.min())


MS_SCANS = [
    # (time s, [(m/z, intensity)...])
    (60.0, [(41.0, 1200), (43.1, 5400), (57.0, 3100)]),
    (60.5, [(41.0, 1500), (43.0, 8800), (57.1, 4000), (71.2, 950)]),
    (61.0, [(39.0, 700), (51.0, 900), (77.0, 6300), (78.1, 12000)]),
    (61.5, [(77.0, 3000), (78.0, 5100)]),
    (62.0, []),
    (62.5, [(91.0, 22000), (92.0, 14500), (65.0, 3300)]),
]


def ms_file(path, unlimited_points):
    """Mass spectrometry: scans with m/z-intensity pairs. Optionally stores the pairs as record variables."""
    counts = [len(p) for _, p in MS_SCANS]
    index = np.concatenate([[0], np.cumsum(counts)[:-1]]).astype('i4')
    mz = [m for _, p in MS_SCANS for m, _ in p]
    inten = [i for _, p in MS_SCANS for _, i in p]
    with netcdf_file(path, 'w', version=1) as f:
        put_attrs(f, {
            'ms_template_revision': '1.0.1', 'dataset_origin': 'Nagura Lab test data', 'dataset_owner': 'public domain',
            'experiment_date_time_stamp': '20260101120000+0000', 'experiment_title': 'Synthetic GC-MS scans',
            'sample_name': 'Synthetic aromatics', 'intensity_axis_units': 'Arbitrary Intensity Units',
        })
        # scipy allows only the first dimension to be unlimited.
        f.createDimension('point_number', None if unlimited_points else len(mz))
        f.createDimension('scan_number', len(MS_SCANS))
        time = f.createVariable('scan_acquisition_time', 'd', ('scan_number',))
        time[:] = [t for t, _ in MS_SCANS]
        time.units = 'Seconds'
        f.createVariable('scan_index', 'i', ('scan_number',))[:] = index
        f.createVariable('point_count', 'i', ('scan_number',))[:] = counts
        f.createVariable('total_intensity', 'd', ('scan_number',))[:] = [sum(i for _, i in p) for _, p in MS_SCANS]
        f.createVariable('mass_range_min', 'd', ('scan_number',))[:] = [min((m for m, _ in p), default=0) for _, p in MS_SCANS]
        f.createVariable('mass_range_max', 'd', ('scan_number',))[:] = [max((m for m, _ in p), default=0) for _, p in MS_SCANS]
        # As record variables (unlimited point_number), the two arrays are interleaved point by point.
        f.createVariable('mass_values', 'f', ('point_number',))[:] = np.array(mz, 'f4')
        f.createVariable('intensity_values', 'h' if unlimited_points else 'i', ('point_number',))[:] = np.array(
            inten, 'i2' if unlimited_points else 'i4')


def cdf5(path):
    """Chromatography in CDF-5 (64-bit data), written by the Unidata library."""
    import netCDF4
    t = 0.2 * np.arange(1200)
    y = 0.5 + gauss(t, 60, 2, 75) + gauss(t, 150, 3, 30)
    with netCDF4.Dataset(path, 'w', format='NETCDF3_64BIT_DATA') as f:
        f.setncatts({'dataset_origin': 'Nagura Lab test data', 'dataset_owner': 'public domain',
                     'sample_name': 'Synthetic CDF-5', 'detector_name': 'ELSD', 'detector_unit': 'mV', 'retention_unit': 'Seconds'})
        f.createDimension('point_number', len(t))
        f.createVariable('ordinate_values', 'f4', ('point_number',))[:] = y
        f.createVariable('actual_sampling_interval', 'f4', ())[...] = 0.2
        f.createVariable('actual_delay_time', 'f4', ())[...] = 0


FILES = {
    'hplc-uv.cdf': hplc_uv,
    'gc-fid-retention.cdf': gc_fid_retention,
    'gcms-scans.cdf': lambda p: ms_file(p, False),
    'gcms-record-vars.cdf': lambda p: ms_file(p, True),
    'elsd-cdf5.cdf': cdf5,
}

if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'fixtures', 'aia')
    os.makedirs(out, exist_ok=True)
    for name, make in FILES.items():
        path = os.path.join(out, name)
        make(path)
        print(f'{name}: {os.path.getsize(path)} bytes')
