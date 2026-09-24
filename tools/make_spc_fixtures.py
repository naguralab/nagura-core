#!/usr/bin/env python3
"""Writes the synthetic Galactic SPC test files in fixtures/spc.

The spectra are made up (Gaussian and Lorentzian bands on a baseline), so the
files carry no third-party rights. The layout follows Galactic's SPC.H: one
file per storage form the decoder must handle.

    python3 tools/make_spc_fixtures.py [OUT_DIR]

Standard library only; the output is byte-for-byte reproducible.
"""
import math
import os
import struct
import sys

TSPREC, TCGRAM, TMULTI, TRANDM, TORDRD, TALABS, TXYXYS, TXVALS = 1, 2, 4, 8, 16, 32, 64, 128
FLOAT = -128


def fdate(year, month, day, hour, minute):
    return (year << 20) | (month << 16) | (day << 11) | (hour << 6) | minute


def cstr(text, size):
    raw = text.encode('latin-1')[: size - 1]
    return raw + b'\0' * (size - len(raw))


def header(*, flags, exper=0, exp=FLOAT, npts, first, last, nsub, xtype, ytype, ztype=0,
           date=0, res='', source='', comment='', catxt=b'', logoff=0, zinc=0.0, wplanes=0, winc=0.0, wtype=0):
    h = struct.pack('<BBBbIddIBBBBI', flags, 0x4B, exper, exp, npts, first, last, nsub, xtype, ytype, ztype, 0, date)
    h += cstr(res, 9) + cstr(source, 9) + struct.pack('<H', 0) + b'\0' * 32
    h += cstr(comment, 130) + catxt.ljust(30, b'\0') + struct.pack('<IIBBHf', logoff, 0, 0, 0, 0, 0.0)
    h += b'\0' * 48 + struct.pack('<fIfB', zinc, wplanes, winc, wtype) + b'\0' * 187
    assert len(h) == 512
    return h


def subheader(*, exp=FLOAT, index, z=0.0, znext=0.0, npts=0, w=0.0):
    return struct.pack('<BbHfffIIf4s', 0, exp, index, z, znext, 0.0, npts, 0, w, b'')


def ydata(values, exp, short=False):
    if exp == FLOAT:
        return struct.pack(f'<{len(values)}f', *values)
    bits = 16 if short else 32
    ints = [round(v * 2 ** (bits - exp)) for v in values]
    assert all(-(2 ** (bits - 1)) <= i < 2 ** (bits - 1) for i in ints), 'value out of range for the exponent'
    return struct.pack(f'<{len(ints)}{"h" if short else "i"}', *ints)


def exponent_for(values):
    """Smallest exponent at which every value fits: |y| < 2^(exp - 1) for signed fractions."""
    peak = max(abs(v) for v in values) or 1
    return math.floor(math.log2(peak)) + 2


def log_block(text):
    body = ''.join(f'{k}={v}\r\n' for k, v in text.items()).encode('latin-1') + b'\0'
    size = 64 + len(body)
    return struct.pack('<IIIII44s', size, (size // 4096 + 1) * 4096, 64, 0, 0, b'') + body


def band(x, center, width, height):
    return height * math.exp(-0.5 * ((x - center) / width) ** 2)


def linspace(first, last, n):
    return [first + i * (last - first) / (n - 1) for i in range(n)]


def with_log(head_args, body, log):
    """Header + body + log, with flogoff pointing at the log."""
    head_args['logoff'] = 512 + len(body)
    return header(**head_args) + body + log_block(log)


def ir_absorbance():
    """Single spectrum, evenly spaced X from high to low wavenumber, float Y."""
    x = linspace(4000, 400, 1801)
    y = [0.02 + 0.00001 * (4000 - v) + band(v, 2950, 25, 0.8) + band(v, 1715, 12, 1.2) + band(v, 1240, 30, 0.5) for v in x]
    body = subheader(index=0) + ydata(y, FLOAT)
    args = dict(flags=0, exper=4, npts=len(x), first=x[0], last=x[-1], nsub=1, xtype=1, ytype=2,
                date=fdate(2026, 9, 24, 10, 30), res='4 cm-1', source='Synthetic',
                comment='Synthetic IR spectrum (Nagura Lab test data)')
    return with_log(args, body, {'MODEL': 'NaguraLabSynthetic', 'NPTS': len(x), 'BEGX': 4000, 'ENDX': 400, 'NSUBS': 1})


def raman_xvals():
    """Single spectrum with an explicit, unevenly spaced X array (a CCD Raman)."""
    x = [100 + 3000 * (i / 1023) ** 1.1 for i in range(1024)]
    y = [200 + band(v, 1001, 4, 5000) + band(v, 1602, 6, 2500) + band(v, 3060, 10, 1200) for v in x]
    xs = struct.pack(f'<{len(x)}f', *x)
    body = xs + subheader(index=0) + ydata(y, FLOAT)
    first, last = struct.unpack('<ff', xs[:4] + xs[-4:])
    head = header(flags=TXVALS, exper=11, npts=len(x), first=first, last=last, nsub=1, xtype=13, ytype=4,
                  comment='Synthetic Raman spectrum, uneven X (Nagura Lab test data)')
    return head + body


def uvvis_kinetics():
    """Multifile: 12 UV-Vis spectra on a common, evenly spaced X axis; Z evenly spaced (fzinc)."""
    x = linspace(200, 800, 601)
    body = b''
    for i in range(12):
        k = 1 - math.exp(-i / 4)
        y = [band(v, 260, 15, 1.4 * (1 - k)) + band(v, 520, 40, 0.9 * k) + 0.01 for v in x]
        body += subheader(index=i, z=30.0 * i if i == 0 else 0.0) + ydata(y, FLOAT)
    args = dict(flags=TMULTI, exper=6, npts=len(x), first=200, last=800, nsub=12, xtype=3, ytype=2, ztype=4,
                zinc=30.0, comment='Synthetic UV-Vis kinetics, 12 spectra 30 s apart (Nagura Lab test data)')
    return with_log(args, body, {'NPTS': len(x), 'NSUBS': 12, 'BEGX': 200, 'ENDX': 800, 'BEGZ': 0, 'ENDZ': 330})


def nir_int16():
    """Multifile with 16-bit fixed-point Y and a different exponent per subfile; Z ordered (TORDRD)."""
    x = linspace(1100, 2498, 700)
    body = b''
    for i, scale in enumerate([0.3, 0.6, 1.1, 2.2, 4.5]):
        y = [scale * (0.2 + band(v, 1450, 40, 0.5) + band(v, 1940, 50, 0.8)) for v in x]
        exp = exponent_for(y)
        body += subheader(exp=exp, index=i, z=[0.5, 1.0, 2.5, 5.0, 10.0][i]) + ydata(y, exp, short=True)
    return header(flags=TMULTI | TORDRD | TSPREC, exper=5, exp=0, npts=len(x), first=1100, last=2498, nsub=5,
                  xtype=3, ytype=10, ztype=0, comment='Synthetic NIR set, 16-bit values (Nagura Lab test data)') + body


def hplc_int32():
    """Chromatogram in minutes with 32-bit fixed-point Y (the older Galactic default)."""
    x = linspace(0, 15, 4501)
    y = [0.5 + 0.02 * t + band(t, 3.2, 0.05, 120) + band(t, 6.8, 0.07, 45) + band(t, 11.4, 0.1, 300) for t in x]
    exp = exponent_for(y)
    body = subheader(index=0, exp=exp) + ydata(y, exp)
    args = dict(flags=TCGRAM, exper=3, exp=exp, npts=len(x), first=0, last=15, nsub=1, xtype=5, ytype=9,
                comment='Synthetic HPLC chromatogram (Nagura Lab test data)', date=fdate(2026, 9, 24, 8, 5))
    return with_log(args, body, {'NPTS': len(x), 'BEGX': 0, 'ENDX': 15})


def ms_xyxy():
    """Multifile with its own X array per subfile (GC-MS), a subfile directory, custom axis labels."""
    spectra = [
        [(15, 12), (29, 40), (31, 100), (45, 22), (46, 18)],
        [(27, 30), (43, 100), (58, 25)],
        [(39, 18), (51, 12), (63, 8), (65, 9), (77, 45), (78, 100), (79, 7)],
    ]
    body = b''
    entries = []
    for i, peaks in enumerate(spectra):
        exp = exponent_for([p[1] for p in peaks])
        z = 2.0 + 0.75 * i
        rec = subheader(exp=exp, index=i, z=z, znext=z, npts=len(peaks))
        rec += struct.pack(f'<{len(peaks)}f', *[p[0] for p in peaks]) + ydata([p[1] for p in peaks], exp)
        entries.append((512 + len(body), len(rec), z))
        body += rec
    directory = b''.join(struct.pack('<IIf', *e) for e in entries)
    catxt = b'm/z\0Abundance\0Retention time\0'
    head = header(flags=TMULTI | TORDRD | TXVALS | TXYXYS | TALABS, exper=9, npts=512 + len(body), first=0, last=0,
                  nsub=len(spectra), xtype=9, ytype=0, ztype=5, catxt=catxt,
                  comment='Synthetic GC-MS spectra (Nagura Lab test data)')
    return head + body + directory


def old_format():
    """Old Spectra Calc / Lab Calc format (0x4D): float header fields, word-swapped 32-bit Y."""
    x = linspace(100, 1800, 851)
    y = [50 + band(v, 465, 8, 900) + band(v, 1085, 6, 1500) for v in x]
    exp = exponent_for(y)
    ints = ydata(y, exp)
    swapped = b''.join(ints[i + 2:i + 4] + ints[i:i + 2] for i in range(0, len(ints), 4))
    head = struct.pack('<BBhfffBBHBBBB8sHH28s130s30s', 0, 0x4D, exp, float(len(x)), 100.0, 1800.0, 13, 0,
                       (0 << 12) | 1994, 3, 14, 15, 9, b'2 cm-1', 0, 0, b'',
                       cstr('Synthetic Raman spectrum, old format (Nagura Lab test data)', 130), b'')
    head += subheader(exp=0, index=0)
    assert len(head) == 256
    return head + swapped


FILES = {
    'ir-absorbance.spc': ir_absorbance,
    'raman-xvals.spc': raman_xvals,
    'uvvis-kinetics.spc': uvvis_kinetics,
    'nir-int16.spc': nir_int16,
    'hplc-int32.cgm': hplc_int32,
    'ms-xyxy.spc': ms_xyxy,
    'raman-old-format.spc': old_format,
}

if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 'fixtures', 'spc')
    os.makedirs(out, exist_ok=True)
    for name, make in FILES.items():
        data = make()
        with open(os.path.join(out, name), 'wb') as f:
            f.write(data)
        print(f'{name}: {len(data)} bytes')
