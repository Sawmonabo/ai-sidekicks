// Every call at the daemon door declares which kind it is, and shows what stops it.
//
// THE COMPLEMENT OF THE READ-CANCELLATION CLAIMS NEXT DOOR, which the three of them
// left open. `read-cancellation-chokepoint.test.ts` holds the SEAM, the scheduler, and
// the run-control dispatcher modules; none of the three is about an individual call,
// and `DaemonCallOptions.signal` is optional by design — so a read that simply forgot
// one was the same source text as a mutation that deliberately passes none. Absence
// was legal, and two reads shipped through the gap before anything looked.
//
// THE CLAIM IS PER CALL AND IT RUNS IN BOTH DIRECTIONS. Every call at the door is
// classified from the source as a read or a record; a read must SHOW the signal that
// stops it, a record must SHOW it carries none, a call whose method the scan cannot
// resolve is held to the read rule rather than exempted, and a call whose method union
// admits both kinds is reported on its own reading — because no signal argument is
// right for a line that is two kinds at once.
//
// THE MODEL AND THE NEEDLES LIVE BESIDE THIS FILE, on the `daemon-call-census.ts`
// pattern: `daemon-call-sites.ts` reads a call off the syntax tree,
// `daemon-method-bindings.ts` resolves what the name it passes is bound to, and
// `daemon-read-signal-census.ts` holds the partition and the three offender readings.
// Each is driven against planted sources in `daemon-read-signal-census.test.ts`, which
// is where the offending shapes can be written; what stays here is the claim over the
// real tree.

import { describe, expect, it } from "vitest";

import type { DaemonCallSite } from "./daemon-call-sites.js";
import {
  classifyDaemonCallSite,
  mixedMethodOffenders,
  readConsoleDaemonCalls,
  stoppableRecordOffenders,
  unstoppableReadOffenders,
} from "./daemon-read-signal-census.js";

describe("read cancellation — every door call declares which kind it is", () => {
  const { readings, sites } = readConsoleDaemonCalls();
  const verdicts = (kind: string): readonly DaemonCallSite[] =>
    sites.filter((site) => classifyDaemonCallSite(site, readings) === kind);

  it("finds the registry's partition and the calls held to it", () => {
    // The derivation's floor, on both sides. A partition that classified everything
    // one way, or a scan that resolved nothing, would make the claims below
    // vacuously true — which is the failure mode a derived set has and the reason the
    // module the fix landed in is named rather than counted.
    expect([...readings.values()].filter(Boolean).length).toBeGreaterThanOrEqual(10);
    expect([...readings.values()].filter((reads) => !reads).length).toBeGreaterThanOrEqual(10);
    expect(verdicts("read").length).toBeGreaterThanOrEqual(15);
    expect(verdicts("record").length).toBeGreaterThanOrEqual(15);
    expect(verdicts("unresolved")).toStrictEqual([]);
    expect(sites.map((site) => site.displayPath)).toContain(
      "console/browser/pane/file/file-boundary.ts",
    );
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
