// The system message, read from the rendered line: it names the act and never the actor or the
// wire's spelling, a failed switch names the provider it tried, and it is the one caution.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { runRow } from "../../event-rows.test-support.js";
import { SystemMessage } from "./SystemMessage.js";
import { SystemMessageClassifier } from "../classifier.js";
import {
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
} from "@ai-sidekicks/contracts/agent/provider-binding";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

const CLAUDE_BINDING = {
  driverName: "claude",
  modelId: "opus",
  providerAccountId: "claude-work",
  effort: "high",
} as const;

/** A failed switch's payload, trying `attempted` from a Claude Code binding. */
function failedSwitch(attempted: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: "33333333-3333-4333-8333-333333333333",
    agentId: "44444444-4444-4444-8444-444444444444",
    switchId: "switch-2",
    actor: "user-ada",
    from: CLAUDE_BINDING,
    attempted,
    reason: "output_speed_unavailable",
  };
}

function renderSystemMessage(row: TranscriptEventRow): HTMLElement {
  const systemMessage = new SystemMessageClassifier().classify(row);
  if (systemMessage === undefined) {
    throw new Error(`expected ${row.type} to classify as a system message`);
  }
  const { container } = render(<SystemMessage systemMessage={systemMessage} />, {
    wrapper: liveBridgeWrapper(),
  });
  return container;
}

describe("the system message — the switch outcomes", () => {
  it("names the failed switch by the provider it tried, as the one caution, with no actor", () => {
    const failedRow = (attempted: Record<string, unknown>): TranscriptEventRow =>
      runRow({
        id: "sf",
        sequence: 5,
        type: AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
        runId: "run-a",
        position: 5,
        actor: "user-ada",
        payload: failedSwitch(attempted),
      });
    const container = renderSystemMessage(
      failedRow({ driverName: "codex", modelId: "gpt-5.5", largerWindow: null }),
    );
    const line = container.querySelector(".meridian-system-message");
    expect(line?.textContent).toBe("Switch to Codex failed");
    expect(line?.classList.contains("meridian-system-message--caution")).toBe(true);
    // A switch that tried another model only names the provider it stayed on.
    expect(
      renderSystemMessage(failedRow({ modelId: "sonnet", largerWindow: null })).textContent,
    ).toContain("Switch to Claude Code failed");
    expect(container.textContent).not.toContain("user-ada");
    expect(container.textContent).not.toContain(AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT);
    expect(container.textContent).not.toContain("output_speed_unavailable");
  });

  it("negative control: an ordinary switch is not drawn as a caution", () => {
    // Without this the caution assertion above would pass over a row that painted every one.
    const container = renderSystemMessage(
      runRow({
        id: "sw",
        sequence: 6,
        type: AGENT_PROVIDER_BINDING_CHANGED_EVENT,
        runId: "run-a",
        position: 6,
        payload: { continuity: "in_place" },
      }),
    );
    const line = container.querySelector(".meridian-system-message");
    expect(line).not.toBeNull();
    expect(line?.classList.contains("meridian-system-message--caution")).toBe(false);
  });
});
