// The seam row, read from the rendered line: each declared loss is drawn as itself.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { runRow } from "../../timeline-rows.test-support.js";
import { SystemMessage } from "./SystemMessage.js";
import {
  SystemMessageClassifier,
  type SystemMessageReading,
} from "../system-message-classifier.js";
import { AGENT_PROVIDER_BINDING_CHANGED_EVENT, type TimelineRow } from "@ai-sidekicks/contracts";

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
    // A value outside the closed wire vocabulary is still rendered as itself.
    expect(line.textContent).toContain("a_loss_this_build_never_heard_of");
  });
});
