// The screenshot tier's skip notice says its sentence once per file, not once per suite.
//
// IN THE BROWSER TIER, BECAUSE THE SUBJECT CANNOT BE IMPORTED ANYWHERE ELSE THE
// AGGREGATE `test` SCRIPT RUNS. `baseline-guard.ts` reads `vitest/browser`'s `server`
// at module scope for the resolved environment and the snapshot-update mode, so a
// Node-context architecture test cannot import it at all — and its own screenshot tier
// is the one project the aggregate script omits. The browser tier is on that script
// and gives the module the context it needs, so the checker runs where its subject
// runs.
//
// The latch is driven directly rather than through `console`: the notice takes its
// writer as an argument, so a case can count what was written without replacing a
// global and without depending on which host the suite happens to be on.

import { describe, expect, it } from "vitest";

import { RunScopedNotice } from "../screenshot/baseline-guard.js";

/** What a notice wrote, in order, so a case can count as well as read. */
function saidBy(notice: RunScopedNotice, asks: number): readonly string[] {
  const written: string[] = [];
  for (let ask = 0; ask < asks; ask += 1) {
    notice.say((message) => {
      written.push(message);
    });
  }
  return written;
}

describe("the run-scoped notice", () => {
  it("says its sentence to the first caller", () => {
    // The zero-match guard for the case below, which would otherwise pass over a
    // notice that never said anything at all.
    expect(saidBy(new RunScopedNotice("references are committed elsewhere"), 1)).toStrictEqual([
      "references are committed elsewhere",
    ]);
  });

  it("says it once however many suites ask", () => {
    // The defect: every suite in the screenshot tier calls the warning during
    // collection, and the unlatched body printed the whole paragraph for each one.
    expect(saidBy(new RunScopedNotice("references are committed elsewhere"), 4)).toStrictEqual([
      "references are committed elsewhere",
    ]);
  });

  it("says nothing at all when there is no reason to", () => {
    // On the pinned platform there is no sentence, which is a different silence from
    // one already said. A latch that conflated them would say the empty case's nothing
    // and then refuse to say a real reason.
    expect(saidBy(new RunScopedNotice(undefined), 4)).toStrictEqual([]);
  });
});
