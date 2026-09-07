// The ceremony reader is fail-closed, and the writer round-trips through it.
//
// THE CLAIM THAT MATTERS IS THE NEGATIVE ONE. A resolution this build cannot read
// must never become `authenticated`: the shipped preload throws, a fixture with no
// stated host refuses, and a bridge whose ceremony surface is not the one this
// console compiles against resolves with something else entirely. Reading any of
// those as success would put a person in front of a signed-in console on the
// strength of nothing.

import type { ParticipantId } from "@ai-sidekicks/contracts";
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

/** The identity claims an authenticated arm carries. A real participant id, branded. */
const CLAIMS = { participantId: "019b78c9-0a80-79a4-8110-cca0117a3301" as ParticipantId };

describe("the ceremony reader — what it accepts", () => {
  it("round-trips every arm the fixture can write", () => {
    const written: readonly ProducedCeremonyOutcome[] = [
      { kind: "authenticated", custody: "durable", claims: CLAIMS },
      { kind: "authenticated", custody: "memory-only", claims: CLAIMS },
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
        readCeremonyOutcome(
          encodeCeremonyResolution({ kind: "authenticated", custody, claims: CLAIMS }),
        ),
      ).toStrictEqual({ kind: "authenticated", custody, claims: CLAIMS });
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
    // The identity half of the same claim, and the reason the arm is the strictest
    // one: `Spec-023 §WebAuthn Credential Flow` step 7 makes the participant claims
    // the whole of what crosses the bridge, so an authenticated resolution that names
    // nobody is an authentication with no subject. Reading it as success would sign a
    // person in as whoever the surface happened to be showing.
    [
      "an authenticated arm carrying no claims at all",
      { ceremonyOutcome: { kind: "authenticated", custody: "durable" } },
    ],
    [
      "claims that are not a record",
      {
        ceremonyOutcome: {
          kind: "authenticated",
          custody: "durable",
          claims: "019b78c9-0a80-79a4-8110-cca0117a3301",
        },
      },
    ],
    [
      "claims naming no participant",
      { ceremonyOutcome: { kind: "authenticated", custody: "durable", claims: {} } },
    ],
    [
      "a participant the contract's own schema refuses",
      {
        ceremonyOutcome: {
          kind: "authenticated",
          custody: "durable",
          // Not a participant id: the brand is a UUID, and a label is what a
          // hand-written `typeof value === "string"` narrowing would have admitted.
          claims: { participantId: "you" },
        },
      },
    ],
    [
      "a participant present as an empty string",
      {
        ceremonyOutcome: {
          kind: "authenticated",
          custody: "durable",
          claims: { participantId: "" },
        },
      },
    ],
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
