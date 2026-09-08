// The fixture trees a budget refusal case plants, and the removal that is part of
// planting one.
//
// WHY A TRAIL RATHER THAN A REMOVAL PER CALL SITE. A refusal case in this tier needs a
// tree that is wrong in exactly one way, and the only way to build one is on disk. A
// call site that also spells out its own removal is how a call site ends up not
// spelling it out: every suite in this directory planted trees and not one removed
// them, so each local run and each CI run left more behind under the system temporary
// directory — a trail nothing bounds and nothing reports. The pair lives here for the
// same reason `launch-profile.ts` holds the launch profile's: what was created is what
// gets removed, and a suite registers one hook however many trees it plants.
//
// REMOVAL IS TOTAL AND NEVER CONDITIONAL. `removeAll` is registered from `afterEach` —
// or `afterAll` where one tree serves a whole suite and emptying it between cases would
// take the directory the next case writes into — and Vitest runs both after a FAILED
// assertion exactly as it does after a passed one, with each removal forced so a case
// that threw before writing its fixture leaves nothing behind either.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The temporary directories one suite has planted, and their removal. */
export class TemporaryDirectoryTrail {
  readonly #plantedDirectories: string[] = [];

  /**
   * Plant one directory under the system temporary directory.
   *
   * @param namePrefix - What the tree is for, so a leak that outlives every hook still
   *   names the suite that made it. `mkdtempSync` appends the characters that make the
   *   path unique, so two calls with one prefix never collide.
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
      rmSync(directory, { recursive: true, force: true });
    }
    this.#plantedDirectories.length = 0;
  }
}
