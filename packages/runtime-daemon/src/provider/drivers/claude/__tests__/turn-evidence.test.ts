// The Claude turn-evidence classifier over recorded `result` frames: a zero-turn synthetic reply
// carries no evidence, a real turn does even when it ended in a provider-side refusal.

import { describe, expect, it } from "vitest";

import { UNRECOGNIZED_TURN_EVIDENCE } from "../../../outbound-frame.js";
import { classifyClaudeTurnEvidence } from "../turn-evidence.js";
import {
  CLAUDE_API_ERRORED_TURN_RESULT_FRAME,
  CLAUDE_ORDINARY_TURN_RESULT_FRAME,
  CLAUDE_ZERO_TURN_RESULT_FRAME,
} from "../__fixtures__/turn-evidence-transcripts.js";

describe("Claude turn-evidence classifier", () => {
  it("finds no evidence in the recorded zero-turn synthetic reply", () => {
    const classification = classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME);

    expect(classification.recognized).toBe(true);
    expect(classification.observations).toStrictEqual([]);
  });

  it("finds evidence in the recorded ordinary turn", () => {
    const classification = classifyClaudeTurnEvidence(CLAUDE_ORDINARY_TURN_RESULT_FRAME);

    expect(classification.recognized).toBe(true);
    expect(classification.observations).toContain("turn_accounting");
    expect(classification.observations).toContain("model_output");
  });

  it("finds evidence in a genuine turn that ended in a provider-side refusal", () => {
    // The key negative control: this frame renders synthetic and reports `is_error: true` yet is
    // a real, billed turn, so a classifier keyed on either field would fail it.
    expect(classifyClaudeTurnEvidence(CLAUDE_API_ERRORED_TURN_RESULT_FRAME).observations).toContain(
      "turn_accounting",
    );
  });

  it("reads a declared failure subtype as a loud, non-silent outcome", () => {
    const classification = classifyClaudeTurnEvidence({
      type: "result",
      subtype: "error_during_execution",
      num_turns: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      modelUsage: {},
    });

    expect(classification.observations).toStrictEqual(["declared_turn_failure"]);
  });

  it("refuses to recognize a shape it was not given", () => {
    for (const envelope of [
      undefined,
      null,
      "result",
      42,
      [],
      {},
      { type: "assistant" },
      { type: "result" },
      { type: "result", subtype: "not_a_censused_subtype" },
    ]) {
      expect(classifyClaudeTurnEvidence(envelope)).toStrictEqual(UNRECOGNIZED_TURN_EVIDENCE);
    }
  });
});
