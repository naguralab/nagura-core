# Test fixtures

`agilent/` holds small Agilent ChemStation runs copied from the test suite of
[rainbow](https://github.com/evanyeyeye/rainbow) (LGPL-3.0-or-later). They are
public example data, not data from any customer or employer.

Reference outputs in the core's `test/reference/` folder are generated from these
files with `npm run reference` (needs `pip install rainbow-api`).

Larger files (an OpenLab `OL` `.uv` and partial `.MS` files) are checked the
same way without being committed:

    git clone --depth 1 https://github.com/evanyeyeye/rainbow /tmp/rainbow
    python3 tools/make_reference.py /tmp/rainbow/tests/inputs /tmp/ref-extra
    NAGURA_EXTRA_REFERENCE=/tmp/ref-extra npm test

Agilent version 181 `.ch` files (not committed; license CeCILL-2.1) come from
[chromConverterExtraTests](https://github.com/ethanbass/chromConverterExtraTests)
(`inst/chemstation_181.D`, originally from IFPEN's
[GC2ASM](https://github.com/ifpen/GC2ASM)):

    git clone --depth 1 https://github.com/ethanbass/chromConverterExtraTests /tmp/cce
    mkdir -p /tmp/v181 && cp -r /tmp/cce/inst/chemstation_181.D /tmp/v181/
    python3 tools/make_reference.py /tmp/v181 /tmp/ref181
    NAGURA_EXTRA_REFERENCE=/tmp/ref181 npm test

For these files rainbow returns one time point fewer than values. The decoded
values match both rainbow and GC2ASM (5914 samples, first value 2.10104 pA);
Nagura Lab spreads the time axis over the header's start and end times.
