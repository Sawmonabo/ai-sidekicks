// The three pure readers over one capability readout, in their own file because none performs a
// read: these cases need a `Map`, not a bridge, a frozen clock and a mounted probe.

import { describe, expect, it } from "vitest";
import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";
import { neverRead } from "./driver-capability-readout.test-support.js";
import type { DriverCapabilityReadout } from "./driver-capability-readout.js";
import {
  DRIVER_CAPABILITY_READINGS,
  boundDriverNameForRun,
  declaredFlagsForDriver,
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
    // The declarations are carried through untouched; the join decides nothing about them.
    expect(joined?.flagsByDriverName).toBe(declarations.flagsByDriverName);
  });

  it("returns the reading itself when there is nothing to join", () => {
    const declarations: DriverCapabilityReadout = {
      flagsByDriverName: new Map(),
      driverNameByRunId: new Map(),
      readRefusal: undefined,
    };
    // The same pointer, so a view whose session named no binding does not re-render.
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

describe("readingForRun — one readout, one run, one answer for every view", () => {
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
    // Exactly one driver filed a report and the session projection named no binding. The run
    // must resolve through the fallback, as a view handed the driver's name would.
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
    // Guards against a resolver that answered `unknown` for everything, the collapse the third
    // state exists to stop.
    const readout = soleReportReadout();
    expect(readingForRun(readout, CLAUDE_RUN, "rollback")).toBe("undeclared");
    expect(DRIVER_CAPABILITY_READINGS).toStrictEqual(["declared", "undeclared", "unknown"]);
  });
});
