// The one ordering claim inside the composition root's own module body.
//
// `providers.tsx` arms the tripwire route and then registers every feature's
// contributions, both at module scope, and the order is part of the design: a registrar
// can report while it registers (the registries refuse a second owner on one name, and a
// projector claim can collide), and the tripwire registry's emitter replays nothing to a
// late subscriber, so a route armed below the registration would miss exactly the
// composition-time breaches the capture most needs.
//
// Its own file rather than a case in `providers.test.ts`, because the only way to
// report from inside the composition is to replace `registrations.ts` for the whole
// module graph, and every other case in that suite drives the real registrations.

import { beforeAll, describe, expect, it, vi } from "vitest";

import { windowDiagnosticCapture } from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";

/** What the stand-in registrar reports, and what the captured record must carry. */
const COMPOSITION_DETAIL = "a registrar reported while the features were being registered";

// The setup imports the whole console, and with every package's suite running at once
// that has taken longer than the default ten-second hook budget.
const WHOLE_CONSOLE_IMPORT_TIMEOUT_MS = 30_000;

// The real registrations replaced by one that reports. `vi.mock`'s factory is invoked
// lazily — when `providers.js` first imports this specifier, which is inside the
// `beforeAll` below — so it reads a `windowTripwires` binding that has long since
// initialized, the shape `test/helpers/electron-mock.ts` documents for the same reason.
vi.mock("./registrations.js", () => ({
  registerFeatureContributions: () => {
    windowTripwires.report({
      kind: "bridge-shape-drift",
      site: "registrations.test-registrar",
      detail: COMPOSITION_DETAIL,
    });
  },
}));

describe("providers — the tripwire route is armed before the features register", () => {
  const batches: string[] = [];

  beforeAll(async () => {
    // Set before the import, because the report happens during module evaluation and
    // a throwing registry would abort the composition rather than exercise the route.
    windowTripwires.setThrowOnReport(false);
    const detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    try {
      await import("./providers.js");
      windowDiagnosticCapture.flush();
    } finally {
      detachForwarder();
      windowTripwires.setThrowOnReport(true);
      windowTripwires.reset();
    }
  }, WHOLE_CONSOLE_IMPORT_TIMEOUT_MS);

  it("captures a report the composition itself made", () => {
    expect(
      batches.join("\n"),
      "a tripwire reported during composition reached no diagnostic record, so the route is armed below the registrations",
    ).toContain(COMPOSITION_DETAIL);
  });

  it("negative control: the registrar this suite composed is the one that reported", () => {
    // Without this the case above would pass over a registry that had somehow been
    // reported to from anywhere at all, rather than from inside the composition.
    expect(batches.join("\n")).toContain("registrations.test-registrar");
  });
});
