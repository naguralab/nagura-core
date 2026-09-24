import { isAgilentDataFile, parseAgilentRuns, type ParseOptions } from './agilent/run.js';
import { isJcampBytes, isJcampPath, parseJcamp } from './jcamp/jcamp.js';
import type { InputFile, Run } from './types.js';

/**
 * True for a file worth reading: one a decoder may recognize. The final
 * decision is made on the bytes, since extensions are shared (`.dx` is both
 * an OpenLab CDS archive and a JCAMP-DX text file).
 */
export function isSupportedPath(path: string): boolean {
  return isAgilentDataFile(path) || isJcampPath(path);
}

/**
 * Decodes dropped files, whatever the format: each file is recognized by its
 * contents and handed to the matching decoder. Agilent files are grouped
 * into runs per `.D` folder; every JCAMP-DX file is a run of its own.
 */
export function parseFiles(files: InputFile[], options: ParseOptions = {}): Run[] {
  const agilent: InputFile[] = [];
  const runs: Run[] = [];
  for (const file of files) {
    if (isJcampPath(file.path) && isJcampBytes(file.bytes)) {
      try {
        runs.push(parseJcamp(file.path, file.bytes));
      } catch (err) {
        const name = file.path.slice(file.path.lastIndexOf('/') + 1);
        runs.push({ name, vendor: 'JCAMP-DX', signals: [], metadata: {}, skipped: [{ path: file.path, reason: err instanceof Error ? err.message : String(err) }] });
      }
    } else {
      agilent.push(file);
    }
  }
  runs.push(...parseAgilentRuns(agilent, options));
  return runs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
