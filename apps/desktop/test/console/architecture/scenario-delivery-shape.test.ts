// What a subscriber actually receives when a scenario plays.
//
// `scenario-wire-truth.test.ts` measures the beats a scenario DECLARES. This file
// measures what comes out the other end, through the real bridge over the real
// engine, and the two are different claims: the envelope composition sits in the
// bridge's delivery path, so a bridge that forwarded the authoring record verbatim
// would leave every case in that file green while handing the console a shape no
// daemon sends. That defect is only reachable from this side.
//
// THE TIER IS ARCHITECTURE for the same reason its sibling's is: the subject is the
// whole scenario MANIFEST, and each of the six family branches building against
// `bridge/scenarios/index.ts` adds a line to it. A family's scenario joins this
// sweep the day it lands, without that family knowing this file exists.
//
// WHAT IS NOT HERE. The predicate over declared beats, and its controls, are the
// sibling's. Delivery ORDER — the engine's due-prefix rule — is
// `bridge/scenario-engine.test.ts`'s. This file owns delivered SHAPE.

import { EventEnvelopeSchema } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  createFixture,
  subscribeThroughBridge,
} from "../../../src/renderer/src/console/bridge/fixture-bridge.test-support.js";
import { CONSOLE_SCENARIOS } from "../../../src/renderer/src/console/bridge/scenarios/index.js";
import { SESSION_EVENT_STREAM } from "../../../src/renderer/src/console/bridge/session-event-streams.js";
import { readConsoleSessionEvent } from "../../../src/renderer/src/console/bridge/session-event-payload.js";

describe("scenario delivery shape — what the fixture bridge actually delivers", () => {
  it.each(CONSOLE_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "delivers %s as envelopes the carrier accepts and the console reads back",
    (_scenarioId, scenario) => {
      const fixture = createFixture(scenario);
      const received = subscribeThroughBridge<unknown>(fixture, SESSION_EVENT_STREAM);

      fixture.engine.runToCompletion();

      expect(received).toHaveLength(scenario.beats.length);
      received.forEach((delivered, beatIndex) => {
        const parsed = EventEnvelopeSchema.safeParse(delivered);
        expect(parsed.error?.issues.map((issue) => issue.message) ?? []).toStrictEqual([]);

        // The other half of the seam, and the half a schema check alone misses: a
        // composer and a boundary can both be self-consistently wrong. `payload` is
        // the one member the trip normalizes, and it normalizes toward the wire —
        // the canonical envelope's payload is required, so a beat that states none
        // travels as an empty record and arrives as one.
        const authored = scenario.beats[beatIndex]?.event;
        expect(readConsoleSessionEvent(delivered)).toStrictEqual({
          ...authored,
          payload: authored?.payload ?? {},
        });
      });
    },
  );

  it("negative control: the authoring record those beats are written in does not", () => {
    // Without it, the sweep above passes against a schema that accepts anything —
    // and it is the exact record the bridge used to deliver, so a regression to
    // forwarding the beat verbatim fails the sweep for the reason named here.
    const authored = CONSOLE_SCENARIOS.flatMap((scenario) => scenario.beats).at(0)?.event;

    expect(authored).toBeDefined();
    expect(EventEnvelopeSchema.safeParse(authored).success).toBe(false);
  });
});
