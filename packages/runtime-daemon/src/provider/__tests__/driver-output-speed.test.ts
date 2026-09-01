// The per-driver output-speed vocabulary table — Plan-005 T3.26.
//
// Guards the property that makes this a table rather than a pair of driver
// constants: BOTH readers — each driver's live `getCapabilities()` and the
// durable cache's `DriverCapabilitiesWriter.hydrate()` — serve the same values,
// so a report reconstructed from cache carries the vocabulary a live read would
// have published. The per-path assertions live with those readers; this suite
// owns the table's own totality, immutability, and refusal.
//
// Refs: Plan-005 T3.26, `Spec-005 §The output-speed axis`,
// `Spec-005 §Provider Parameter Vocabularies`.

import { describe, expect, it } from "vitest";

import { DRIVER_CLI_VERSION_FLOORS, type FlooredDriverName } from "../capability-refresh.js";
import {
  DRIVER_OUTPUT_SPEED_LEVELS,
  declaredOutputSpeedLevelsFor,
} from "../driver-output-speed.js";

const ALL_DRIVERS: readonly FlooredDriverName[] = Object.keys(
  DRIVER_CLI_VERSION_FLOORS,
) as FlooredDriverName[];

describe("DRIVER_OUTPUT_SPEED_LEVELS — the declared, settable vocabularies", () => {
  it("is TOTAL over the driver set, with an entry for every shipped driver", () => {
    // Derived from the floors table rather than from a second literal list, so a
    // driver added there without a vocabulary entry goes red here rather than at
    // the first cold-start hydrate that reads its cached flag.
    expect(Object.keys(DRIVER_OUTPUT_SPEED_LEVELS).sort()).toStrictEqual([...ALL_DRIVERS].sort());
  });

  it("pins the shipped values, including the deliberately EMPTY one", () => {
    // The empty entry is a declaration, not an omission: codex declares no
    // settable output-speed level vocabulary, and an absent-or-empty vocabulary
    // is what the axis contract reads as "unsettable".
    expect([...DRIVER_OUTPUT_SPEED_LEVELS.claude]).toStrictEqual(["off", "on"]);
    expect([...DRIVER_OUTPUT_SPEED_LEVELS.codex]).toStrictEqual([]);
  });

  it("publishes the SETTABLE levels, which are narrower than the reportable ones", () => {
    // The pinned Claude build can REPORT a rate-limit cooldown; no participant
    // may REQUEST one. A table that carried it would offer a level whose
    // selection cannot be honoured.
    expect(DRIVER_OUTPUT_SPEED_LEVELS.claude).not.toContain("cooldown");
  });

  it("is deep-frozen, so a reader cannot rewrite the vocabulary process-wide", () => {
    expect(Object.isFrozen(DRIVER_OUTPUT_SPEED_LEVELS)).toBe(true);
    for (const driverName of ALL_DRIVERS) {
      expect(Object.isFrozen(DRIVER_OUTPUT_SPEED_LEVELS[driverName])).toBe(true);
    }
  });
});

describe("declaredOutputSpeedLevelsFor — the by-name lookup", () => {
  it("resolves each shipped driver to its own entry", () => {
    for (const driverName of ALL_DRIVERS) {
      expect(declaredOutputSpeedLevelsFor(driverName)).toBe(DRIVER_OUTPUT_SPEED_LEVELS[driverName]);
    }
  });

  it("THROWS for a driver name the table does not carry", () => {
    expect(() => declaredOutputSpeedLevelsFor("gemini")).toThrow(
      /no output-speed vocabulary is declared for driver 'gemini'/,
    );
  });

  it("THROWS for an inherited Object.prototype key rather than resolving it", () => {
    // A bare index read would resolve `constructor` to a function and hand a
    // caller something that is not a vocabulary at all. The lookup is own-key
    // only, so these fail the same way an unknown driver does.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      expect(() => declaredOutputSpeedLevelsFor(inherited)).toThrow(
        /no output-speed vocabulary is declared/,
      );
    }
  });
});
