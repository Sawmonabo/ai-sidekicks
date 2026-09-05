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
import {
  DRIVER_CAPABILITY_READINGS,
  boundDriverNameForRun,
  declaredFlagsForDriver,
  readingForRun,
  withRunDriverBindings,
  type DriverCapabilityReadout,
} from "./driver-capability-read.js";

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
