// The runtime-node seam, held to the wire it claims to speak.
//
// Three claims, and each one is a way the seam could look right and be wrong:
//
//   • **The subscribed name set is the contract's, minus a partition the contract
//     itself draws.** This file imports the census as a VALUE — a test is not
//     bundled, so it can read what the seam may only reference as a type — and
//     derives the expected set from `RUNTIME_NODE_EVENT_NAMES` rather than listing
//     five strings a second time. A hand-list would go on passing over a name the
//     contract added and the seam never subscribed to.
//   • **The procedure name is the method namespace's, not the event namespace's.**
//     One string is the whole coupling point between this console and a
//     control-plane router.
//   • **Every shipped roster frame is a reading the wire could actually return.**
//     The scenarios assert branded identifiers with `as`, which the compiler takes
//     on trust; `RuntimeNodeRosterResponseSchema` is what discharges the claim, and
//     it is `.strict()`, so an invented member fails here too.
//
// What this seam ANSWERS with is not here: the fixture arm is
// `fixture/fixture-runtime-node-roster.ts` and its suite is beside it, and the live
// arms are `runtime-node-roster-transport.ts` and its suite beside that.

import { describe, expect, it } from "vitest";

import { RUNTIME_NODE_EVENT_NAMES, RuntimeNodeRosterResponseSchema } from "@ai-sidekicks/contracts";

import { CONSOLE_SCENARIOS } from "../scenarios/index.js";
import { SETTINGS_SCENARIO } from "../scenarios/settings.js";
import {
  RUNTIME_NODE_PRESENCE_EVENT_NAMES,
  RUNTIME_NODE_ROSTER_PROCEDURE,
} from "./runtime-node-roster.js";

describe("the presence subscription's name set", () => {
  it("carries every registered name that announces a node-state transition", () => {
    // Derived from the census, not listed: the two excluded names are the two whose
    // registered payload uses the REDUCED base and carries no state transition at
    // all, so the partition is the contract's own and an eighth registered name
    // would land in whichever half this derivation puts it in — and fail the
    // seam's own `satisfies` table first if nobody classified it.
    const capabilityNames = RUNTIME_NODE_EVENT_NAMES.filter((name) =>
      name.startsWith("runtime_node.capability_"),
    );
    const expected = RUNTIME_NODE_EVENT_NAMES.filter((name) => !capabilityNames.includes(name));
    expect([...RUNTIME_NODE_PRESENCE_EVENT_NAMES].sort()).toStrictEqual([...expected].sort());
    // The negative control for the derivation above: a partition that selected
    // everything would make the assertion vacuous.
    expect(capabilityNames).toHaveLength(2);
    expect(RUNTIME_NODE_PRESENCE_EVENT_NAMES.length).toBeLessThan(RUNTIME_NODE_EVENT_NAMES.length);
  });

  it("names only strings the contract registers", () => {
    for (const eventName of RUNTIME_NODE_PRESENCE_EVENT_NAMES) {
      expect(RUNTIME_NODE_EVENT_NAMES).toContain(eventName);
    }
  });
});

describe("the registered procedure name", () => {
  it("is the runtime-node namespace's separator-free method name", () => {
    // Spelled out once here, deliberately: this string is the whole coupling point
    // between the console and a control-plane router, and a test that read it back
    // off the constant it is asserting would check nothing.
    expect(RUNTIME_NODE_ROSTER_PROCEDURE).toBe("runtimenode.roster");
    // The `runtime_node.*` EVENT names use an underscore; the METHOD namespace does
    // not. Confusing the two is the mistake this pair of assertions catches.
    expect(RUNTIME_NODE_ROSTER_PROCEDURE).not.toContain("_");
  });
});

describe("every shipped roster frame", () => {
  it("is a reading the registered response schema accepts", () => {
    // What discharges the scenarios' `as NodeId` / `as ParticipantId` /
    // `as EventEnvelopeVersion` assertions. The schema is `.strict()`, so a member
    // the wire does not carry fails here as loudly as a malformed identifier.
    let framesChecked = 0;
    for (const scenario of CONSOLE_SCENARIOS) {
      for (const frame of scenario.runtimeNodeRoster ?? []) {
        expect(() =>
          RuntimeNodeRosterResponseSchema.parse({
            nodes: [...frame.nodes],
            controlHolder: frame.controlHolder,
          }),
        ).not.toThrow();
        framesChecked += 1;
      }
    }
    // The negative control: with no scenario carrying a roster this loop would pass
    // by never running.
    expect(framesChecked).toBeGreaterThan(0);
  });

  it("is rejected by that same schema once a member is invented", () => {
    const [frame] = SETTINGS_SCENARIO.runtimeNodeRoster ?? [];
    expect(frame).toBeDefined();
    expect(() =>
      RuntimeNodeRosterResponseSchema.parse({
        nodes: [...(frame?.nodes ?? [])],
        controlHolder: frame?.controlHolder ?? null,
        health: "green",
      }),
    ).toThrow();
  });
});
