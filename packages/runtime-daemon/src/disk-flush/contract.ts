// How the operating system makes what was written survive a power loss: a written file is flushed
// to disk, and so is the folder a rename or removal changed, where the system can flush a folder.

import type { FlushOpener } from "./handle.js";

/** How the system flushes a written file, and a changed folder, to disk. */
export interface DiskFlush {
  /**
   * Flushes the file at `path` to disk. Throws the first failure, any failed cleanup after it
   * attached to its `cause`.
   */
  flushFile(path: string): Promise<void>;
  /**
   * Flushes `folderPath`'s entries to disk, so a rename or removal in it survives a power loss,
   * opening it through `openFolder`; does nothing where the system has no folder flush. Throws the
   * first failure.
   */
  flushFolder(folderPath: string, openFolder?: FlushOpener): Promise<void>;
}
