// The one ordering claim inside the composition root's own module body.
//
// `ConsoleRoot.tsx` arms the tripwire route and composes the seven boards, both at
// module scope, and its comment says the ordering is part of the design. It is: a
// registrar can report while it registers — the boards refuse a second owner on one
// slot, and a projector claim can collide — and the tripwire registry's emitter
// replays nothing to a late subscriber, so a route armed BELOW the registration
// records none of that. The window in which that is invisible is the window in which
// the composition-time breaches the capture most needs are the ones it misses.
//
// Its own file rather than a case in `ConsoleRoot.test.tsx`, because the only way to
// report from inside the composition is to replace `families.ts` for the whole module
// graph, and every other case in that suite drives the real families.

import { beforeAll, describe, expect, it, vi } from "vitest";

import { consoleDiagnosticCapture } from "../../core/diagnostic-capture/diagnostic-capture.js";
import { consoleTripwires } from "../../core/tripwires.js";

/** What the stand-in registrar reports, and what the captured record must carry. */
const COMPOSITION_DETAIL = "a registrar reported while the boards were being composed";

// The real registrar replaced by one that reports. `vi.mock`'s factory is invoked
// lazily — when `ConsoleRoot.js` first imports this specifier, which is inside the
// `beforeAll` below — so it reads a `consoleTripwires` binding that has long since
// initialised, the shape `test/helpers/electron-mock.ts` documents for the same reason.
vi.mock("../../families.js", () => ({
  registerConsoleFamilies: () => {
    consoleTripwires.report({
      kind: "bridge-shape-drift",
      site: "families.test-registrar",
      detail: COMPOSITION_DETAIL,
    });
  },
}));

describe("ConsoleRoot — the tripwire route is armed before the boards are composed", () => {
  const batches: string[] = [];

  beforeAll(async () => {
    // Set before the import, because the report happens during module evaluation and
    // a throwing registry would abort the composition rather than exercise the route.
    consoleTripwires.setThrowOnReport(false);
    const detachForwarder = consoleDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    try {
      await import("./ConsoleRoot.js");
      consoleDiagnosticCapture.flush();
    } finally {
      detachForwarder();
      consoleTripwires.setThrowOnReport(true);
      consoleTripwires.reset();
    }
  });

  it("captures a report the composition itself made", () => {
    expect(
      batches.join("\n"),
      "a tripwire reported during composition reached no diagnostic record, so the route is armed below the boards",
    ).toContain(COMPOSITION_DETAIL);
  });

  it("negative control: the registrar this suite composed is the one that reported", () => {
    // Without this the case above would pass over a registry that had somehow been
    // reported to from anywhere at all, rather than from inside the composition.
    expect(batches.join("\n")).toContain("families.test-registrar");
  });
});
