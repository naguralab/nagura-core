# Notice

`@naguralab/core` is licensed under the GNU Lesser General Public License,
version 3 or later (see `COPYING` and `COPYING.LESSER`).

The Agilent ChemStation and OpenLab CDS decoders in `src/agilent/` are a TypeScript port of
the format knowledge in [rainbow](https://github.com/evanyeyeye/rainbow)
(Copyright the rainbow authors, LGPL-3.0-or-later).

The test fixtures in `/fixtures/agilent` are taken from rainbow's test suite.

Zip archives (`.dx`) are read with [fflate](https://github.com/101arrowz/fflate) (MIT).

The JCAMP-DX decoder in `src/jcamp/` is written from the published JCAMP-DX
specifications (IUPAC). Its tests compare against
[jcampconverter](https://github.com/cheminfo/jcampconverter) 10.0.2 (MIT), which
is used only to generate reference files and is not part of this package.

The test fixtures in `/fixtures/jcamp` come from Robert J. Lancashire's JCAMP-DX
test set (University of the West Indies), as distributed with the
[jcamp](https://github.com/nzhagen/jcamp) Python package (MIT). Each is marked
`##OWNER= public domain`.
