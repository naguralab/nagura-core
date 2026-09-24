/** What measured a signal. `null` when the file does not say. */
export type Detector = 'UV' | 'FID' | 'CAD' | 'ELSD' | 'RID' | 'MS' | null;

/** What the rows of a signal are measured against. */
export interface Axis {
  /** Quantity, e.g. `Wavenumber`, `Wavelength`, `Chemical shift`. */
  label: string;
  /** Unit as displayed, e.g. `cm⁻¹`, `nm`, `ppm`; empty when the file gives none. */
  unit: string;
  /** Plot high values on the left, as IR spectra and NMR are conventionally drawn. */
  reversed?: boolean;
}

/** The axis of every chromatogram: retention time in minutes. */
export const TIME_AXIS: Axis = { label: 'Time', unit: 'min' };

/**
 * One data file decoded into a (row axis x ylabel) matrix.
 *
 * A single-channel chromatogram (FID, one DAD wavelength) has one column.
 * A diode-array spectrum file has one column per wavelength, and a mass
 * spectrometry file one column per m/z bin. A standalone spectrum (IR,
 * Raman, UV-Vis, NMR) has one column, with the spectral axis as rows.
 */
export interface Signal {
  /** File name the signal was read from, e.g. `DAD1A.ch`. */
  name: string;
  detector: Detector;
  /**
   * Row positions, ascending: retention times in minutes for chromatograms,
   * otherwise values on `xAxis` (e.g. wavenumbers).
   */
  times: Float64Array;
  /** The row axis. Absent for chromatograms (retention time, see `TIME_AXIS`). */
  xAxis?: Axis;
  /** The measurement, for data that is not a chromatogram, e.g. `IR spectrum`. */
  technique?: string;
  /** A list of peaks (e.g. a centroided mass spectrum) rather than a continuous curve. */
  sticks?: boolean;
  /**
   * Column labels: wavelength in nm (UV), m/z (MS), or `NaN` for a channel
   * that has no numeric label (FID, CAD, ELSD).
   */
  ylabels: Float64Array;
  /** Row-major values, `times.length * ylabels.length` long. */
  data: Float64Array;
  /** Unit of the values, as the file states it (e.g. `mAU`, `pA`). */
  unit: string;
  metadata: Record<string, string | number>;
}

/** A file handed to the parsers: its path inside the run and its bytes. */
export interface InputFile {
  /** Path relative to the dropped folder, e.g. `sample1.D/DAD1A.ch`. */
  path: string;
  bytes: Uint8Array;
}

/** One acquisition: a `.D` folder, or a loose file dropped on its own. */
export interface Run {
  /** Folder name (`sample1.D`), `.dx` file name, or the loose file's name. */
  name: string;
  /** Vendor or open format the run was read as, e.g. `Agilent`, `JCAMP-DX`. */
  vendor: string;
  signals: Signal[];
  metadata: Record<string, string | number>;
  /** Files that looked like data but could not be decoded, with the reason. */
  skipped: { path: string; reason: string }[];
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
