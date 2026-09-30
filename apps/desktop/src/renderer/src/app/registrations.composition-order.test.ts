// The one ordering claim inside the composition root's module body: `providers.tsx` arms the
// tripwire route and then registers every feature's contributions. A registrar can report while
// it registers and the tripwire emitter replays nothing to a late subscriber, so a route armed
// after registration would miss the breaches the capture most needs. It is its own file because
// the only way to report from inside the composition is to replace `registrations.ts` for the
// whole module graph, and the other cases drive the real registrations.

import { beforeAll, describe, expect, it, vi } from "vitest";

import { windowDiagnosticCapture } from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { windowTripwires } from "@renderer/lib/tripwires.js";

/** What the stand-in registrar reports, and what the captured record must carry. */
const COMPOSITION_DETAIL = "a registrar reported while the features were being registered";

// The setup imports the whole console, which exceeds the default ten-second hook budget when
// every package's suite runs at once.
const WHOLE_CONSOLE_IMPORT_TIMEOUT_MS = 30_000;

// The real registrations replaced by one that reports. The `vi.mock` factory runs lazily, when
// `providers.js` first imports this specifier inside the `beforeAll`, so `windowTripwires` is
// already initialized.
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
    // Set before the import: the report happens during module evaluation, and a throwing
    // registry would abort the composition instead of exercising the route.
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
    // Without this the case above would pass on a report made from anywhere, not from inside
    // the composition.
    expect(batches.join("\n")).toContain("registrations.test-registrar");
  });
});
