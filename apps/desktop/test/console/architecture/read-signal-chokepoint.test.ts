// Every call at the daemon door declares which kind it is, and shows what stops it.
//
// THE COMPLEMENT OF THE READ-CANCELLATION CLAIMS NEXT DOOR, which the three of them
// left open. `read-cancellation-chokepoint.test.ts` holds the SEAM, the scheduler, and
// the run-control dispatcher modules; none of the three is about an individual call,
// and `DaemonCallOptions.signal` is optional by design — so a read that simply forgot
// one was the same source text as a mutation that deliberately passes none. Absence
// was legal, and two reads shipped through the gap before anything looked.
//
// THE CLAIM IS PER CALL AND IT RUNS IN FOUR DIRECTIONS, one per verdict. Every call at
// the door is classified from the source as a read, a record, a union of both, or a
// method the scan could not reduce to a classified registry row; a read must SHOW the
// signal that stops it — a member merely NAMED `signal` is not one — and a record must
// SHOW it carries none, while the mixed and unresolved verdicts are reported whatever
// their options said, because no signal argument is right for a line that is two kinds
// at once and none settles a line whose kind is unknown.
//
// THE MODEL AND THE NEEDLES LIVE BESIDE THIS FILE, on the `daemon-call-census.ts`
// pattern: `daemon-call-sites.ts` reads a call off the syntax tree,
// `daemon-method-bindings.ts` resolves what the names it passes are bound to, and
// `daemon-read-signal-census.ts` folds the console's own method partition — declared
// in `bridge/daemon/daemon-method-classification.ts` — over those calls and holds the
// four offender readings.
// The first two are driven against planted sources in `daemon-call-sites.test.ts` and
// the last in `daemon-read-signal-census.test.ts`, which is where the offending shapes
// can be written; what stays here is the claim over the real tree.

import { describe, expect, it } from "vitest";

import { MUTATING_DAEMON_METHODS } from "../../../src/renderer/src/console/store/shell-mutation-block.js";
import type { DaemonCallSite } from "./daemon-call-sites.js";
import {
  classifyDaemonCallSite,
  mixedMethodOffenders,
  readConsoleDaemonCalls,
  stoppableRecordOffenders,
  unresolvedMethodOffenders,
  unstoppableReadOffenders,
} from "./daemon-read-signal-census.js";

/**
 * How many of the shell block's roster the registry binds, and so how many this gate
 * can hold to the partition.
 *
 * Seven of its nine: `driver.applyIntervention` and `driver.respondToRequest` reach the
 * daemon through a surface the console has not registered a reply shape for yet, so the
 * partition says nothing about them and neither does this claim. A reading below that
 * is the instrument having gone blind rather than the claim holding.
 */
const CLASSIFIED_BLOCKED_METHOD_COUNT = 7;

describe("read cancellation — every door call declares which kind it is", () => {
  const { readings, sites } = readConsoleDaemonCalls();
  const verdicts = (kind: string): readonly DaemonCallSite[] =>
    sites.filter((site) => classifyDaemonCallSite(site, readings) === kind);

  it("finds the console's partition and the calls held to it", () => {
    // The derivation's floor, on both sides. A partition that classified everything
    // one way, or a scan that resolved nothing, would make the claims below
    // vacuously true — which is the failure mode a derived set has and the reason the
    // module the fix landed in is named rather than counted.
    //
    // Counted at this commit: 31 bound methods, 12 of them readings and 19 records, and
    // 36 door calls, 18 read and 18 record. The floors sit under those rather than on
    // them, because the registry grows and a pin on today's total would fail on the
    // diff that adds a method rather than on the defect this gate is about.
    expect([...readings.values()].filter(Boolean).length).toBeGreaterThanOrEqual(10);
    expect([...readings.values()].filter((reads) => !reads).length).toBeGreaterThanOrEqual(10);
    expect(verdicts("read").length).toBeGreaterThanOrEqual(15);
    expect(verdicts("record").length).toBeGreaterThanOrEqual(15);
    expect(sites.map((site) => site.displayPath)).toContain(
      "console/browser/pane/file/file-boundary.ts",
    );
  });

  it("classifies every method the shell block closes as a record", () => {
    // THE TWO ANSWERS, HELD TOGETHER. `store/shell-mutation-block.ts` names the writes a
    // supervisor outage closes and this partition names every write at the door; a
    // method the first calls a write and the second calls a reading would be one console
    // disabling a control while another gate demanded the abort signal that abandons it.
    //
    // ONE DIRECTION, BECAUSE THAT ROSTER IS A SUBSET ON PURPOSE — it names the writes a
    // surface offers a CONTROL for, and a write no surface dispatches has no control to
    // disable, so the partition's records are the wider set. The floor beside the claim
    // is what keeps a roster that stopped resolving from reading as agreement.
    const blocked = [...MUTATING_DAEMON_METHODS].filter((method) => readings.has(method));
    expect(blocked).toHaveLength(CLASSIFIED_BLOCKED_METHOD_COUNT);
    expect(blocked.filter((method) => readings.get(method) === true)).toStrictEqual([]);
  });

  it("every call names a method the registry classifies", () => {
    // Reported on its own reading rather than through the read rule, because no
    // signal argument settles a call whose kind is unknown: a generic binder over the
    // whole registry that passed one used to satisfy the read rule and be dropped by
    // all three of the others. The fix is at the call — narrow the method until the
    // parse can see which kind it is.
    expect(unresolvedMethodOffenders(sites, readings)).toStrictEqual([]);
  });

  it("every read carries the signal that stops it", () => {
    expect(unstoppableReadOffenders(sites, readings)).toStrictEqual([]);
  });

  it("no record is handed one", () => {
    // The positive control the mutation claim owes. Its sibling next door holds run
    // controls to naming no abort at all; this holds every recording call at the door
    // to being unstoppable, which is the property a durable act needs.
    expect(stoppableRecordOffenders(sites, readings)).toStrictEqual([]);
  });

  it("no call names a read and a record at once", () => {
    // Neither rule can hold over a union of both — a signal cannot be conditional on
    // which arm ran — so such a site is reported whatever it was handed, and the fix
    // is at the call rather than in the classifier.
    expect(mixedMethodOffenders(sites, readings)).toStrictEqual([]);
  });
});
