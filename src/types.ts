/** What measured a signal. `null` when the file does not say. */
export type Detector = 'UV' | 'FID' | 'CAD' | 'ELSD' | 'RID' | 'MS' | null;

/**
 * One data file decoded into a (retention time x ylabel) matrix.
 *
 * A single-channel chromatogram (FID, one DAD wavelength) has one column.
 * A diode-array spectrum file has one column per wavelength, and a mass
 * spectrometry file one column per m/z bin.
 */
export interface Signal {
  /** File name the signal was read from, e.g. `DAD1A.ch`. */
  name: string;
  detector: Detector;
  /** Retention times in minutes, one per row. */
  times: Float64Array;
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
  vendor: 'Agilent';
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
