/**
 * A stored media path as an absolute one, for showing and copying. Paths are
 * stored as `outputs/…`, `inputs/…`, `samples/…`; only the outputs can live
 * outside the data dir, where `outputs.dir` puts them (§3).
 */
export function diskPath(dataDir: string, outputsDir: string, path: string): string {
  if (path.startsWith("outputs/") && outputsDir) {
    return `${outputsDir}/${path.slice("outputs/".length)}`;
  }
  return `${dataDir}/${path}`;
}
