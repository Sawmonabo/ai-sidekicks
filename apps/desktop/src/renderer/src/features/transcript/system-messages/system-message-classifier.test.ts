// Which rows classify as system messages, held to the reads that fail silently: a rollback is
// read off its own arm, a compaction and a switch off their wire types, and an ordinary row is
// never one.

import { AGENT_PROVIDER_BINDING_CHANGED_EVENT } from "@ai-sidekicks/contracts/agent-provider-binding";
import { describe, expect, it } from "vitest";

import { generalRow, rollbackBoundaryRow, runRow } from "../transcript-event-rows.test-support.js";
import { SystemMessageClassifier } from "./system-message-classifier.js";

describe("system messages — one row's classification", () => {
  it("reads a rollback off the rollback boundary's own arm", () => {
    const systemMessage = new SystemMessageClassifier().classify(
      rollbackBoundaryRow({
        id: "rb",
        sequence: 9,
        runId: "run-a",
        position: 6,
        targetPosition: 2,
      }),
    );
    expect(systemMessage?.kind).toBe("rollback");
    expect(systemMessage?.rowId).toBe("rb");
  });

  it("reads a compaction and a provider switch off their wire types", () => {
    const classifier = new SystemMessageClassifier();
    const compaction = classifier.classify(
      runRow({
        id: "c1",
        sequence: 3,
        type: "usage.context_compacted",
        category: "usage_telemetry",
        runId: "run-a",
        position: 7,
      }),
    );
    const providerSwitch = classifier.classify(
      runRow({
        id: "s1",
        sequence: 5,
        type: AGENT_PROVIDER_BINDING_CHANGED_EVENT,
        runId: "run-a",
        position: 5,
      }),
    );
    expect(compaction?.kind).toBe("compaction");
    expect(providerSwitch?.kind).toBe("provider-switch");
  });

  it("an ordinary row is not a system message", () => {
    const classifier = new SystemMessageClassifier();
    expect(
      classifier.classify(
        runRow({ id: "r1", sequence: 1, type: "run.running", runId: "run-a", position: 1 }),
      ),
    ).toBeUndefined();
    expect(
      classifier.classify(
        generalRow({
          id: "g1",
          sequence: 2,
          type: "session.renamed",
          category: "session_lifecycle",
        }),
      ),
    ).toBeUndefined();
  });
});
