// The ceremony reader is fail-closed, and the writer round-trips through it.
//
// THE CLAIM THAT MATTERS IS THE NEGATIVE ONE. A resolution this build cannot read
// must never become `authenticated`: the shipped preload throws, a fixture with no
// stated host refuses, and a bridge whose ceremony surface is not the one this
// console compiles against resolves with something else entirely. Reading any of
// those as success would put a person in front of a signed-in console on the
// strength of nothing.

import { describe, expect, it } from "vitest";

import {
  readCeremonyOutcome,
  WEB_AUTHN_CUSTODY_STATES,
  WEB_AUTHN_PROBE_RESULTS,
  WEB_AUTHN_REFUSAL_REASONS,
  type ProducedCeremonyOutcome,
} from "./ceremony-outcome.js";
import { encodeCeremonyResolution } from "./ceremony-resolution.js";

const HANDOFF = { verificationUri: "http://127.0.0.1:8419/callback", userCode: "JQPD-4KTM" };

describe("the ceremony reader — what it accepts", () => {
  it("round-trips every arm the fixture can write", () => {
    const written: readonly ProducedCeremonyOutcome[] = [
      { kind: "authenticated", custody: "durable" },
      { kind: "authenticated", custody: "memory-only" },
      { kind: "fallback-required", probeResult: "no-prf", handoff: HANDOFF },
      { kind: "refused", reason: "cancelled" },
    ];
    for (const outcome of written) {
      expect(readCeremonyOutcome(encodeCeremonyResolution(outcome))).toStrictEqual(outcome);
    }
  });

  it("reads every member of each closed vocabulary", () => {
    // Driven off the tuples rather than a hand-listed copy: a vocabulary restated in
    // a test is a second closed set, and the first one to go stale.
    for (const custody of WEB_AUTHN_CUSTODY_STATES) {
      expect(
        readCeremonyOutcome(encodeCeremonyResolution({ kind: "authenticated", custody })),
      ).toStrictEqual({ kind: "authenticated", custody });
    }
    for (const probeResult of WEB_AUTHN_PROBE_RESULTS) {
      const resolution = encodeCeremonyResolution({
        kind: "fallback-required",
        probeResult,
        handoff: HANDOFF,
      });
      expect(readCeremonyOutcome(resolution)).toStrictEqual({
        kind: "fallback-required",
        probeResult,
        handoff: HANDOFF,
      });
    }
    for (const reason of WEB_AUTHN_REFUSAL_REASONS) {
      expect(
        readCeremonyOutcome(encodeCeremonyResolution({ kind: "refused", reason })),
      ).toStrictEqual({ kind: "refused", reason });
    }
  });
});

describe("the ceremony reader — what it refuses to read", () => {
  it.each([
    ["a value that is not a record", 7],
    ["a record with no ceremony member", {}],
    ["a ceremony member that is not a record", { ceremonyOutcome: "authenticated" }],
    ["an arm this build does not know", { ceremonyOutcome: { kind: "enrolled" } }],
    ["an unknown custody state", { ceremonyOutcome: { kind: "authenticated", custody: "disk" } }],
    ["a custody state that is missing", { ceremonyOutcome: { kind: "authenticated" } }],
    [
      "a fallback with no hand-off",
      { ceremonyOutcome: { kind: "fallback-required", probeResult: "no-prf" } },
    ],
    [
      "a fallback whose hand-off has no code",
      {
        ceremonyOutcome: {
          kind: "fallback-required",
          probeResult: "no-prf",
          handoff: { verificationUri: "http://127.0.0.1:8419/callback" },
        },
      },
    ],
    ["a refusal with no reason", { ceremonyOutcome: { kind: "refused" } }],
    [
      "the console's own unavailable arm, which no host may write",
      {
        ceremonyOutcome: { kind: "unavailable", refusal: { code: "x", detail: "y", origin: "z" } },
      },
    ],
  ])("answers undefined for %s", (_description, resolution) => {
    expect(readCeremonyOutcome(resolution)).toBeUndefined();
  });
});
