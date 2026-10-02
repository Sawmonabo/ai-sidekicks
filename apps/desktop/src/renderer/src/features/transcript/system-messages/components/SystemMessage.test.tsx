// The system message, read from the rendered line: it names the act and never the actor or the
// wire's spelling, and a failed switch is the one caution.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { runRow } from "../../timeline-rows.test-support.js";
import { SystemMessage } from "./SystemMessage.js";
import { SystemMessageClassifier } from "../system-message-classifier.js";
import {
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  type TimelineRow,
} from "@ai-sidekicks/contracts";

function renderSystemMessage(row: TimelineRow): HTMLElement {
  const systemMessage = new SystemMessageClassifier().classify(row);
  if (systemMessage === undefined) {
    throw new Error(`expected ${row.type} to classify as a system message`);
  }
  const { container } = render(<SystemMessage systemMessage={systemMessage} />);
  return container;
}

describe("the system message — the switch outcomes", () => {
  it("names the failed switch as the one caution, with no actor and no wire spelling", () => {
    const container = renderSystemMessage(
      runRow({
        id: "sf",
        sequence: 5,
        type: AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
        runId: "run-a",
        position: 5,
        actor: "user-ada",
        payload: { reason: "output_speed_unavailable" },
      }),
    );
    const line = container.querySelector(".meridian-system-message");
    expect(line?.classList.contains("meridian-system-message--caution")).toBe(true);
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
