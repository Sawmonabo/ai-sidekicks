// The identity read, and the two rows that still refuse under both bridges.
//
// The gitflow cases are about a DISTINCTION — one operation served, one refused.
// These are about the other half of that discipline: an operation refuses when the
// scenario states nothing it could answer from, and the case that earns its place
// is not the refusal (the sweep in `fixture-growth-port.test.ts` already covers
// every operation's answer) but the PREMISE the refusal rests on. So each finder
// below asserts what no scenario says, and each has a negative control that plants
// it.
//
// The identity row is the one whose premise MOVED. `ConsoleScenario` grew
// `viewingParticipantId`, so the fact now has a home and the read is answered from
// it — and the premise worth pinning inverted with it: what no scenario may do is
// state a viewer under some OTHER name, because the port reads exactly one field and
// a second spelling would be a fact on the script that never reaches a surface. The
// sidekick row has no finder because its premise cannot go stale: a definition is
// node-local configuration and `ConsoleScenario` models no node at all, so there is
// no field a scenario could grow that would make one derivable.

import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "./fixture-bridge.js";
import {
  callOperation,
  findScenariosNaming,
  fixturePort,
} from "./fixture-growth-port.test-support.js";
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "./fixture-growth-port.js";
import type { GrowthOperationId } from "./growth-entry.js";
import { GROWTH_OPERATIONS } from "./growth-operations/index.js";
import { createLiveBridge } from "./live-bridge.js";
import type { ConsoleScenario } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { CONSOLE_SCENARIOS } from "./scenarios/index.js";
import { createTier1Bridge } from "@ai-sidekicks/contracts";

/**
 * Names a scenario must NOT state a viewer under — the spellings that are not the
 * field the port reads.
 *
 * `viewingParticipantId` is deliberately absent from this list: it is the one name
 * the fixture answers from, and every substrate scenario now carries it. What the
 * finder catches is the near-miss — a family scenario that writes `viewerParticipantId`
 * into a scripted reply and quietly gets a refusal, because the port never looks
 * there. Not `participantIdsInJoinOrder` either, which every scenario carries and
 * which is deliberately not this fact: join order is who opened the session and who
 * followed, on any machine.
 */
const VIEWER_NAMING_MEMBERS = [
  "viewerParticipantId",
  "callerParticipantId",
  "selfParticipantId",
] as const;

/** Members a scenario would have to carry to state a registered callback tool. */
const CALLBACK_TOOL_NAMING_MEMBERS = ["callbackTools", "inputSchema"] as const;

describe("the fixture's identity read — answered from the field, refused without it", () => {
  it("answers which participant this window is, from the scenario's own statement", async () => {
    const port = fixturePort();

    const outcome = await port.callerParticipantRead({ sessionId: FLAGSHIP_SCENARIO.sessionId });

    expect(outcome.status).toBe("served");
    if (outcome.status === "served") {
      expect(outcome.value.participantId).toBe(FLAGSHIP_SCENARIO.viewingParticipantId);
      // In the roster, which is what makes the answer resolvable to a role. The
      // wire-truth predicate holds every scenario to this; the assertion here is
      // that the PORT answers with the member rather than with something adjacent.
      expect(FLAGSHIP_SCENARIO.participantIdsInJoinOrder).toContain(outcome.value.participantId);
    }
  });

  it("refuses for a scenario that states no viewer, rather than reading join order", () => {
    // The fabrication the field exists to prevent, asserted as a refusal rather
    // than argued in a comment: the head of the join order is right there and is
    // not the answer.
    const { viewingParticipantId: _statedViewer, ...withoutViewerFields } = FLAGSHIP_SCENARIO;
    const withoutViewer: ConsoleScenario = { ...withoutViewerFields, id: "states-no-viewer" };

    return expect(
      createFixtureBridge({ scenario: withoutViewer }).growth.callerParticipantRead({
        sessionId: withoutViewer.sessionId,
      }),
    ).resolves.toMatchObject({ status: "unavailable", code: "wire-unregistered" });
  });

  it("lends no session's viewer to another, a role being a fact about one roster", async () => {
    const port = fixturePort();

    const outcome = await port.callerParticipantRead({ sessionId: "session-somebody-else" });

    expect(outcome.status).toBe("unavailable");
    expect(outcome).not.toHaveProperty("value");
  });

  it("keeps that answer out of the live bridge, which still has no wire for it", async () => {
    const bridge = createLiveBridge(createTier1Bridge());

    const outcome = await bridge.growth.callerParticipantRead({
      sessionId: FLAGSHIP_SCENARIO.sessionId,
    });

    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.slateRow).toBe("caller-participant-identity");
      expect(outcome.owningDocument).toContain("Authenticated Principal");
    }
  });

  it("plays no scenario that states a viewer under a name the port does not read", () => {
    expect(findScenariosNaming(CONSOLE_SCENARIOS, VIEWER_NAMING_MEMBERS)).toStrictEqual([]);
  });

  it("negative control: reports a scenario that states one under the wrong name", () => {
    const withMisnamedViewer: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "names-a-viewer",
      replies: [
        {
          call: "participant.projectionRead",
          result: { viewerParticipantId: FLAGSHIP_SCENARIO.participantIdsInJoinOrder[0] },
        },
      ],
    };

    expect(findScenariosNaming([withMisnamedViewer], VIEWER_NAMING_MEMBERS)).toStrictEqual([
      "names-a-viewer",
    ]);
  });
});

describe("the fixture's registry reads — refusing on a stated premise", () => {
  it("plays no scenario that states a registered callback tool", () => {
    expect(findScenariosNaming(CONSOLE_SCENARIOS, CALLBACK_TOOL_NAMING_MEMBERS)).toStrictEqual([]);
  });

  it("negative control: reports a scenario that DOES state one", () => {
    const withCallbackTools: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "states-a-callback-tool",
      replies: [
        {
          call: "session.read",
          result: { callbackTools: [{ name: "workflow_start", inputSchema: {} }] },
        },
      ],
    };

    expect(findScenariosNaming([withCallbackTools], CALLBACK_TOOL_NAMING_MEMBERS)).toStrictEqual([
      "states-a-callback-tool",
    ]);
  });

  it("refuses every unserved one under both bridges, each naming the row that owes its wire", async () => {
    const liveBridge = createLiveBridge(createTier1Bridge());
    const port = fixturePort();
    const rows = ["callback-tool-registry-read", "sidekick-definition-registry"];
    const served = new Set<string>(FIXTURE_SERVED_GROWTH_OPERATION_IDS);
    const operationIds = (Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[]).filter(
      (operationId) =>
        rows.includes(GROWTH_OPERATIONS[operationId].slateRow) && !served.has(operationId),
    );

    // Four, and the count is asserted so a row that quietly lost its operations
    // cannot make the loop below vacuously pass. Two transitions have already moved
    // it and this count is where each was noticed: the identity row left when it
    // became answerable from the scenario's own field, and the definition list left
    // when the agent console's picker began reading it from the same script — beside
    // the peer-invocation grant that joined the row and is served with it.
    expect(operationIds).toHaveLength(4);
    for (const operationId of operationIds) {
      for (const outcome of [
        await callOperation(port, operationId),
        await callOperation(liveBridge.growth, operationId),
      ]) {
        expect(outcome.status, operationId).toBe("unavailable");
        if (outcome.status === "unavailable") {
          expect(outcome.slateRow, operationId).toBe(GROWTH_OPERATIONS[operationId].slateRow);
          // Not an empty list, an empty registry, or a null identity. Each of those
          // is a real daemon answer to a question nobody asked here, and a surface
          // handed one renders a checked state it never checked.
          expect(outcome.code, operationId).toBe("wire-unregistered");
        }
        expect(outcome, operationId).not.toHaveProperty("value");
      }
    }
  });

  it("names each row's owning document, so a reader knows who owes the wire", async () => {
    const port = fixturePort();

    for (const [operationId, owner] of [
      ["callbackToolRegistryRead", "Spec-005"],
      // The definition row's own refusal, taken from an operation the fixture does
      // NOT serve: its list read is answered from the script now, so the attribution
      // claim has to be made on a sibling that still refuses.
      ["sidekickDefinitionCreate", "Spec-030"],
    ] as const) {
      const outcome = await callOperation(port, operationId);

      expect(outcome.status).toBe("unavailable");
      if (outcome.status === "unavailable") {
        expect(outcome.owningDocument, operationId).toContain(owner);
      }
    }
  });
});
