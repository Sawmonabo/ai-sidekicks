// The Codex turn-evidence classifier over `turn/completed` payloads and in-flight item
// notifications: model output is evidence, a synthesized command dispatch is not, and a declared
// failure passes through so an unrelated outage is not misreported.

import { describe, expect, it } from "vitest";

import { UNRECOGNIZED_TURN_EVIDENCE } from "../../../../outbound-frame.js";
import {
  classifyCodexTurnEvidence,
  classifyCodexTurnEvidenceObservation,
} from "../turn-evidence.js";
import {
  codexCommandDispatchResponse,
  codexQuotaExhaustedTurn,
  codexTurnWithModelOutput,
} from "../__fixtures__/turn-evidence-transcripts.js";

describe("Codex turn-evidence classifier", () => {
  it("finds model output in a turn that produced an agent message", () => {
    const classification = classifyCodexTurnEvidence(codexTurnWithModelOutput("turn-1"));

    expect(classification.recognized).toBe(true);
    expect(classification.observations).toStrictEqual(["model_output"]);
  });

  it("finds no evidence in a synthesized command-dispatch response", () => {
    const classification = classifyCodexTurnEvidence(codexCommandDispatchResponse("turn-1"));

    expect(classification.recognized).toBe(true);
    expect(classification.observations).toStrictEqual([]);
  });

  it("passes a typed declared failure so an unrelated outage is not misreported", () => {
    // The measured quota-exhausted turn has no model output but is not a neutralization failure;
    // reporting it as one would put the wrong cause in a shared field the person sees.
    expect(classifyCodexTurnEvidence(codexQuotaExhaustedTurn("turn-1")).observations).toStrictEqual(
      ["declared_turn_failure"],
    );
  });

  it("reads an interrupted turn as a declared non-completion", () => {
    expect(
      classifyCodexTurnEvidence({
        turn: { id: "turn-1", items: [], itemsView: "loaded", status: "interrupted", error: null },
      }).observations,
    ).toStrictEqual(["declared_turn_failure"]);
  });

  it("refuses to recognize a shape it was not given", () => {
    for (const envelope of [
      undefined,
      null,
      [],
      {},
      { turn: null },
      { turn: {} },
      { turn: { status: "notAStatus" } },
    ]) {
      expect(classifyCodexTurnEvidence(envelope)).toStrictEqual(UNRECOGNIZED_TURN_EVIDENCE);
    }
  });

  it("accrues in-flight model output from item notifications", () => {
    // `turn/completed` can carry `itemsView: "notLoaded"` beside an empty item list (measured at
    // the pinned build): items not loaded, not output absent.
    expect(
      classifyCodexTurnEvidenceObservation("item/completed", {
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-2" },
      }),
    ).toStrictEqual({ turnId: "turn-1", observation: "model_output" });
  });

  it("reads no in-flight evidence off a user echo or an unrelated method", () => {
    expect(
      classifyCodexTurnEvidenceObservation("item/completed", {
        turnId: "turn-1",
        item: { type: "userMessage", id: "item-1" },
      }),
    ).toBeNull();
    expect(classifyCodexTurnEvidenceObservation("turn/started", { turnId: "turn-1" })).toBeNull();
    expect(
      classifyCodexTurnEvidenceObservation("item/completed", { item: { type: "agentMessage" } }),
    ).toBeNull();
  });
});
