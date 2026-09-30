// The pure readers over one capability readout, in their own file because none performs a
// read: these cases need a `Map`, not a bridge, a frozen clock and a mounted probe.

import { describe, expect, it } from "vitest";
import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";
import type { DriverCapabilityReadout } from "./driver-capability-readout.js";
import { boundDriverNameForRun, readingForRun } from "./driver-capability-readings.js";

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

  it("reads a flag the driver declared absent as undeclared, not as unknown", () => {
    // Guards against a resolver that answered `unknown` for everything, the collapse the third
    // state exists to stop.
    const readout = soleReportReadout();
    expect(readingForRun(readout, CLAUDE_RUN, "rollback")).toBe("undeclared");
  });
});
