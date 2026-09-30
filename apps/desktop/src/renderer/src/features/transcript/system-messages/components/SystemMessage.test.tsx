// The seam row, held to the members it claims to draw.
//
// Every case here reads the RENDERED line rather than the model behind it, because
// the defect this component answers was exactly that the model was correct and
// nothing drew it: `SystemMessageClassifier` derived the boundary, the continuity, the
// losses and the reason on every pass, and the only consumer
// was the replay dock's next-seam jump, itself since removed. A case asserting over
// `classify()` would have passed throughout.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { rollbackBoundaryRow, runRow } from "../../timeline-rows.test-support.js";
import { SystemMessage } from "./SystemMessage.js";
import { SYSTEM_MESSAGE_BINDINGS } from "../system-message-kinds.js";
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
    throw new Error("the seam row drew no line");
  }
  return line;
}

describe("the seam row — one kind at a time, over its registered members", () => {
  it("draws a rewind with the boundary its typed payload carried", () => {
    const line = renderSeam(
      seamOf(
        rollbackBoundaryRow({
          id: "rb",
          sequence: 9,
          runId: "run-a",
          position: 6,
          targetPosition: 2,
        }),
      ),
    );
    expect(line.textContent).toContain(SYSTEM_MESSAGE_BINDINGS.rollback.label);
    expect(line.textContent).toContain("2");
  });

  it("draws a compaction with the boundary its own position carried", () => {
    const line = renderSeam(
      seamOf(
        runRow({
          id: "c1",
          sequence: 3,
          type: "usage.context_compacted",
          category: "usage_telemetry",
          runId: "run-a",
          position: 7,
        }),
      ),
    );
    expect(line.textContent).toContain(SYSTEM_MESSAGE_BINDINGS.compaction.label);
    expect(line.textContent).toContain("7");
  });

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
    // Without this the caution assertion above would pass over a row that painted
    // every seam amber, which is spent on attention alone.
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

describe("the seam row — the loss clause", () => {
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
    // A value the closed wire vocabulary does not carry is still rendered as
    // itself. Mapping it onto a fallback phrase would go quiet on exactly the
    // newest kind of loss.
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
