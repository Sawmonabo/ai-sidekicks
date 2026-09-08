// The temporary trees a case plants on disk, and the removal that is part of planting
// one.
//
// CONSOLE-WIDE SCAFFOLDING, WHICH IS WHY IT IS FLAT. This is one of `test/console/`'s
// role files beside `bounded-cleanup.ts`, `cleanup-contract.ts` and
// `launch-profile.ts`, and any tier may consume it: the budget tier plants fixture
// documents a loader must refuse, and a tier that needs a tree that is wrong in exactly
// one way needs the same pair. It lived under `test/console/budget/` first, which made a
// TIER directory own a cross-tier cleanup role — so the next tier to plant a tree had
// two choices and both are wrong: import the budget tier, or write the removal again.
//
// WHY A TRAIL RATHER THAN A REMOVAL PER CALL SITE. The only way to build a wrong-on-disk
// input is on disk. A call site that also spells out its own removal is how a call site
// ends up not spelling it out: every suite in the budget tier planted trees and not one
// removed them, so each local run and each CI run left more behind under the system
// temporary directory — a trail nothing bounds and nothing reports. The pair lives in one
// module for the same reason `launch-profile.ts` holds the launch profile's: what was
// created is what gets removed, and a suite registers one hook however many trees it
// plants.
//
// AND IT STANDS BESIDE THOSE NEIGHBOURS RATHER THAN INSIDE ONE OF THEM. None of them
// owns a register-a-resource-and-release-it-after-the-case role for this to be an
// instance of: `cleanup-contract.ts` is the contract one LAUNCHED APPLICATION's cleanup
// is handed, `bounded-cleanup.ts` is the bounded close-or-kill race that produces a
// verdict about that one application, `cleanup-disposition.ts` is what a caller is told
// about that verdict, and `launch-profile.ts` is a single resource's create/remove pair
// with the Windows retry a SIGKILLed Electron's lock needs. All four are about one
// launch; none of them registers an nth resource, and none of them can be handed a tree
// this class planted. What they share with it is the RULE — creation and removal in one
// module — which is stated in `launch-profile.ts`'s own header and applied again here.
//
// REMOVAL IS TOTAL AND NEVER CONDITIONAL. `removeAll` is registered from `afterEach`, and
// Vitest runs that hook after a FAILED assertion exactly as it does after a passed one,
// with each removal forced so a case that threw before writing its fixture leaves nothing
// behind either. It is never `afterAll`: a directory that outlives the case that planted
// it is filesystem state the next case runs against, which `apps/desktop/AGENTS.md`
// §Pre-PR self-audit closes with "every temporary directory removed in `afterEach`". A
// suite whose cases each need their own tree calls `create` per case rather than sharing
// one, which is what makes the per-case removal safe.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The temporary directories one case has planted, and their removal. */
export class TemporaryDirectoryTrail {
  readonly #plantedDirectories: string[] = [];

  /**
   * Plant one directory under the system temporary directory.
   *
   * @param namePrefix - What the tree is for, so a leak that outlives every hook still
   *   names the suite that made it. `mkdtempSync` appends the characters that make the
   *   path unique, so two calls with one prefix never collide — which is what lets a
   *   suite call this once per case under one prefix.
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
