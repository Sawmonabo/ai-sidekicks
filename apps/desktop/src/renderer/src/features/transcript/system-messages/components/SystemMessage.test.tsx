// The system message, read from the rendered line: each declared loss is drawn as itself, a switch
// that declares no loss draws no clause and no caution, and a failed switch carries its reason
// verbatim as the one caution.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { runRow } from "../../timeline-rows.test-support.js";
import { SystemMessage } from "./SystemMessage.js";
import {
  SystemMessageClassifier,
  type SystemMessageReading,
} from "../system-message-classifier.js";
import {
  AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
  AGENT_PROVIDER_BINDING_CHANGED_EVENT,
  type TimelineRow,
} from "@ai-sidekicks/contracts";

function seamOf(row: TimelineRow): SystemMessageReading {
  const seam = new SystemMessageClassifier().classify(row);
  if (seam === undefined) {
    throw new Error(`expected ${row.type} to classify as a seam`);
  }
  return seam;
}

function renderSeam(seam: SystemMessageReading): HTMLElement {
  const { container } = render(<SystemMessage seam={seam} />);
  const line = container.querySelector<HTMLElement>(".meridian-system-message");
  if (line === null) {
    throw new Error("the system message drew no line");
  }
  return line;
}

describe("the system message — the switch outcomes", () => {
  it("carries the failed switch's reason verbatim, and marks it the one caution", () => {
    const line = renderSeam(
      seamOf(
        runRow({
          id: "sf",
          sequence: 5,
          type: AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT,
          runId: "run-a",
          position: 5,
          payload: { reason: "output_speed_unavailable" },
        }),
      ),
    );
    expect(line.textContent).toContain("output_speed_unavailable");
    expect(line.classList.contains("meridian-system-message--caution")).toBe(true);
  });

  it("negative control: an ordinary switch is not drawn as a caution", () => {
    // Without this the caution assertion above would pass over a row that painted every seam.
    const line = renderSeam(
      seamOf(
        runRow({
          id: "sw",
          sequence: 6,
          type: AGENT_PROVIDER_BINDING_CHANGED_EVENT,
          runId: "run-a",
          position: 6,
          payload: { continuity: "in_place" },
        }),
      ),
    );
    expect(line.classList.contains("meridian-system-message--caution")).toBe(false);
  });
});

describe("the system message — the loss clause", () => {
  it("renders each declared loss as itself", () => {
    const line = renderSeam(
      seamOf(
        runRow({
          id: "sm",
          sequence: 7,
          type: AGENT_PROVIDER_BINDING_CHANGED_EVENT,
          runId: "run-a",
          position: 7,
          payload: {
            continuity: "brief",
            declaredLosses: ["turn_content_truncated", "a_loss_this_build_never_heard_of"],
          },
        }),
      ),
    );
    expect(line.textContent).toContain("brief");
    expect(line.textContent).toContain("turn_content_truncated");
    // A value outside the closed wire vocabulary is still rendered as itself.
    expect(line.textContent).toContain("a_loss_this_build_never_heard_of");
  });

  it("negative control: a switch that declares no loss draws no clause", () => {
    // An empty list is the switch's claim that nothing was lost; a notice for it would
    // be a sentence this component invented.
    const line = renderSeam(
      seamOf(
        runRow({
          id: "si",
          sequence: 8,
          type: AGENT_PROVIDER_BINDING_CHANGED_EVENT,
          runId: "run-a",
          position: 8,
          payload: { continuity: "in_place", declaredLosses: [] },
        }),
      ),
    );
    expect(line.textContent).toContain("in_place");
    expect(line.querySelector(".meridian-system-message__losses")).toBeNull();
  });
});
