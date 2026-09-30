// The per-driver output-speed vocabulary table: totality, immutability, and refusal of unknown
// names. Both readers (each driver's live `getCapabilities()` and the cache's
// `DriverCapabilitiesWriter.hydrate()`) serve these values; their tests assert each path.

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
    // Derived from the floors table, so a driver added there without an entry fails here rather
    // than at the first cold-start hydrate.
    expect(Object.keys(DRIVER_OUTPUT_SPEED_LEVELS).sort()).toStrictEqual([...ALL_DRIVERS].sort());
  });

  it("pins the shipped values, including the deliberately EMPTY one", () => {
    // The empty entry is a declaration, not an omission: an absent-or-empty vocabulary is what
    // marks the axis unsettable.
    expect([...DRIVER_OUTPUT_SPEED_LEVELS.claude]).toStrictEqual(["off", "on"]);
    expect([...DRIVER_OUTPUT_SPEED_LEVELS.codex]).toStrictEqual([]);
  });

  it("publishes the SETTABLE levels, which are narrower than the reportable ones", () => {
    // A provider can report a rate-limit cooldown, but a user cannot request one.
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
    // A bare index read would resolve `constructor` to a function; the lookup is own-key only.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      expect(() => declaredOutputSpeedLevelsFor(inherited)).toThrow(
        /no output-speed vocabulary is declared/,
      );
    }
  });
});
