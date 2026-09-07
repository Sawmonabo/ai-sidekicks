// The three pure readers over one capability readout.
//
// Their own file because none of them performs a read: `withRunDriverBindings` joins
// a session's bindings onto a node's declarations, and the other two answer a
// question about a readout already in hand. The read's own cases need a bridge, a
// frozen clock, and a mounted probe; these need a `Map`, and keeping them beside
// each other made the file's subject two things at once.

import { describe, expect, it } from "vitest";
import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import { neverRead } from "./driver-capability-read.test-support.js";
import type { DeclaredDriverFlags, DriverCapabilityReadout } from "./driver-capability-read.js";
import {
  DRIVER_CAPABILITY_READINGS,
  boundDriverNameForRun,
  declaredFlagsForDriver,
  readingAcrossRuns,
  readingForRun,
  withRunDriverBindings,
} from "./driver-capability-readings.js";

describe("withRunDriverBindings", () => {
  it("joins the session's bindings onto the node's declarations", () => {
    const declarations: DriverCapabilityReadout = {
      flagsByDriverName: new Map(),
      driverNameByRunId: new Map(),
      readRefusal: undefined,
    };
    const joined = withRunDriverBindings(declarations, new Map([["run-one", "codex"]]));
    expect(joined?.driverNameByRunId.get("run-one")).toBe("codex");
    // The declarations are carried through untouched: this joins a second reading
    // onto the first and decides nothing about either.
    expect(joined?.flagsByDriverName).toBe(declarations.flagsByDriverName);
  });

  it("returns the reading itself when there is nothing to join", () => {
    const declarations: DriverCapabilityReadout = {
      flagsByDriverName: new Map(),
      driverNameByRunId: new Map(),
      readRefusal: undefined,
    };
    // The same pointer, so a surface whose session named no binding re-renders no
    // more often than one that asked for no join at all.
    expect(withRunDriverBindings(declarations, new Map())).toBe(declarations);
    expect(withRunDriverBindings(undefined, new Map([["run-one", "codex"]]))).toBeUndefined();
  });
});

describe("declaredFlagsForDriver", () => {
  it("says nothing about a driver nobody named", () => {
    expect(declaredFlagsForDriver(undefined, "claude")).toBeUndefined();
    expect(declaredFlagsForDriver(neverRead(), undefined)).toBeUndefined();
  });
});

describe("readingForRun — one readout, one run, one answer for every surface", () => {
  const CLAUDE_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
  const CODEX_RUN = "c4e1b2d3-5f60-4071-9b82-0d3e4f506172";

  /** One report, and no session projection to name which run is bound to it. */
  function soleReportReadout(): DriverCapabilityReadout {
    return {
      flagsByDriverName: new Map([
        [
          "claude",
          Object.fromEntries(
            DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, flag === "context_compaction"]),
          ) as Readonly<Record<DriverCapabilityFlag, boolean>>,
        ],
      ]),
      driverNameByRunId: new Map(),
      readRefusal: undefined,
    };
  }

  it("answers the same for a run whose binding only the sole-report fallback names", () => {
    // The state the composer's rail and the runs pane disagreed in: exactly one
    // driver filed a report and the session projection has named no binding, so the
    // pane resolved the driver through the fallback and offered its gated control
    // while the rail — handed a driver name the projection had not supplied — said
    // nobody had asked. One readout, one run, one moment, two answers.
    const readout = soleReportReadout();
    expect(boundDriverNameForRun(readout, CLAUDE_RUN)).toBe("claude");
    expect(readingForRun(readout, CLAUDE_RUN, "context_compaction")).toBe("declared");
    expect(readingForRun(readout, CODEX_RUN, "context_compaction")).toBe("declared");
  });

  it("says nobody has asked where no reading can name the binding", () => {
    expect(readingForRun(undefined, CLAUDE_RUN, "context_compaction")).toBe("unknown");
    expect(readingForRun(neverRead(), CLAUDE_RUN, "context_compaction")).toBe("unknown");
  });

  it("negative control: a declared absence is not the same reading as an unasked one", () => {
    // Without this the case above would pass over a resolver that answered
    // `unknown` for everything, which is the collapse the third state exists to stop.
    const readout = soleReportReadout();
    expect(readingForRun(readout, CLAUDE_RUN, "rollback")).toBe("undeclared");
    expect(DRIVER_CAPABILITY_READINGS).toStrictEqual(["declared", "undeclared", "unknown"]);
  });
});

describe("readingAcrossRuns — one answer for a session, over every run it addresses", () => {
  const CLAUDE_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
  const CODEX_RUN = "c4e1b2d3-5f60-4071-9b82-0d3e4f506172";
  const UNBOUND_RUN = "d5f2c3e4-6071-4182-ac93-1e4f50617283";

  /** One flag set, declaring exactly the flags named. */
  function declaring(...declared: readonly DriverCapabilityFlag[]): DeclaredDriverFlags {
    return Object.fromEntries(
      DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, declared.includes(flag)]),
    ) as DeclaredDriverFlags;
  }

  /** Two drivers reported, and a session projection naming which run is on which. */
  function twoDriverReadout(): DriverCapabilityReadout {
    return {
      flagsByDriverName: new Map([
        ["claude", declaring("callback_tools")],
        ["codex", declaring("rollback")],
      ]),
      driverNameByRunId: new Map([
        [CLAUDE_RUN, "claude"],
        [CODEX_RUN, "codex"],
      ]),
      readRefusal: undefined,
    };
  }

  it("answers the node's own reading where no run is addressed", () => {
    // An unresolved addressed set and a resolved empty one land here together, and
    // both are answered honestly: the sole-report fallback is decisive exactly when
    // one driver reported, and says nobody has asked when two did.
    expect(readingAcrossRuns(twoDriverReadout(), [], "callback_tools")).toBe("unknown");
  });

  it("does not let the first addressed run answer for the rest", () => {
    // The finding: a session whose pending decisions name runs on two drivers had its
    // capability read off `addressedPostures[0]`, so reordering the records changed
    // what the section reported while the bindings stood still.
    const readout = twoDriverReadout();
    expect(readingAcrossRuns(readout, [CLAUDE_RUN, CODEX_RUN], "callback_tools")).toBe("declared");
    expect(readingAcrossRuns(readout, [CODEX_RUN, CLAUDE_RUN], "callback_tools")).toBe("declared");
    expect(readingAcrossRuns(readout, [CLAUDE_RUN, CODEX_RUN], "rollback")).toBe("declared");
    expect(readingAcrossRuns(readout, [CODEX_RUN, CLAUDE_RUN], "rollback")).toBe("declared");
  });

  it("holds an unanswerable binding apart from a declared absence", () => {
    // `undeclared` is the claim that NO addressed run can reach the capability, so a
    // run whose binding nobody could name may not be folded into it — and a run that
    // does declare it settles the session's answer whatever the others say.
    const readout = twoDriverReadout();
    expect(readingAcrossRuns(readout, [CODEX_RUN, UNBOUND_RUN], "callback_tools")).toBe("unknown");
    expect(readingAcrossRuns(readout, [UNBOUND_RUN, CODEX_RUN], "callback_tools")).toBe("unknown");
    expect(readingAcrossRuns(readout, [CLAUDE_RUN, UNBOUND_RUN], "callback_tools")).toBe(
      "declared",
    );
  });

  it("negative control: every addressed run declaring it absent is still an absence", () => {
    // Without this the fold above would pass over a resolver that never answered
    // `undeclared` at all, which is the reading the section's absence is gated on.
    const readout = twoDriverReadout();
    expect(readingAcrossRuns(readout, [CODEX_RUN], "callback_tools")).toBe("undeclared");
    expect(readingAcrossRuns(readout, [CLAUDE_RUN], "rollback")).toBe("undeclared");
  });
});
