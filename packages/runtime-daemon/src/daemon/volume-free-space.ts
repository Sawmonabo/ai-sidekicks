// The free room on the volume holding a folder, read from the file system when asked. Node's
// `statfs` reads it the same way on macOS, Linux and Windows.

import { statfs } from "node:fs/promises";

/** The bytes an unprivileged process may still write on the volume holding `folderPath`. */
export async function readVolumeFreeBytes(folderPath: string): Promise<number> {
  const volume = await statfs(folderPath);
  return volume.bavail * volume.bsize;
}
