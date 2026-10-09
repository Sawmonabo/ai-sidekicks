// The temporary trees a case plants on disk, and their removal. Any tier may use it; the budget
// tier plants documents a loader must refuse. A suite registers `removeAll` once from
// `afterEach`, which Vitest runs after a failed assertion too, and never from `afterAll`: a tree
// that outlives its case is state the next case runs against. A suite whose cases need their own
// tree calls `create` per case.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The temporary directories one case has planted, and their removal. */
export class TemporaryDirectoryTrail {
  readonly #plantedDirectories: string[] = [];

  /**
   * Plants one directory under the system temporary directory. `namePrefix` names the suite that
   * made it, so a leaked tree is traceable; `mkdtempSync` makes the path unique.
   */
  create(namePrefix: string): string {
    const directory = mkdtempSync(path.join(tmpdir(), namePrefix));
    this.#plantedDirectories.push(directory);
    return directory;
  }

  /** What is planted and not yet removed, in creation order. */
  get plantedDirectories(): readonly string[] {
    return [...this.#plantedDirectories];
  }

  /** Remove every planted tree, and forget them. */
  removeAll(): void {
    for (const directory of this.#plantedDirectories) {
      // A process a case killed can still be closing files in its tree, so a removal that finds
      // the directory refilled (ENOTEMPTY) tries again, as Node's own retry does.
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    this.#plantedDirectories.length = 0;
  }
}
