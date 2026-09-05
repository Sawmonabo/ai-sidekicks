// The seam row, held to the members it claims to draw.
//
// Every case here reads the RENDERED line rather than the model behind it, because
// the defect this component answers was exactly that the model was correct and
// nothing drew it: `LedgerSeamIndex` derived the boundary, the continuity, the
// losses, the reason and the blocked-on state on every pass, and the only consumer
// was the replay dock's next-seam jump. A case asserting over `classify()` would
// have passed throughout.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { legacyStubRow, rollbackBoundaryRow, runRow } from "./timeline-rows.test-support.js";
import { SeamRow } from "./SeamRow.js";
import { LedgerSeamIndex, SEAM_WIRE_BINDINGS, type LedgerSeam } from "./seams.js";
import { type TimelineRow } from "@ai-sidekicks/contracts";

function seamOf(row: TimelineRow): LedgerSeam {
  const seam = new LedgerSeamIndex().classify(row);
  if (seam === undefined) {
    throw new Error(`expected ${row.type} to classify as a seam`);
  }
  return seam;
}

function renderSeam(seam: LedgerSeam): HTMLElement {
  const { container } = render(<SeamRow seam={seam} />);
  const line = container.querySelector<HTMLElement>(".meridian-seam-row");
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
    expect(line.textContent).toContain(SEAM_WIRE_BINDINGS.rollback.label);
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
    expect(line.textContent).toContain(SEAM_WIRE_BINDINGS.compaction.label);
    expect(line.textContent).toContain("7");
  });

  it("draws a paused run, which carries no boundary and is offered none", () => {
    const line = renderSeam(
      seamOf(runRow({ id: "p1", sequence: 2, type: "run.paused", runId: "run-a", position: 2 })),
    );
    expect(line.textContent).toContain(SEAM_WIRE_BINDINGS["run-paused"].label);
    expect(line.textContent).not.toContain("Boundary");
  });

  it("names the state a blocked run is waiting on, verbatim", () => {
    const line = renderSeam(
      seamOf(
        runRow({
          id: "b1",
          sequence: 4,
          type: "run.waiting_for_approval",
          runId: "run-a",
          position: 4,
        }),
      ),
    );
    expect(line.textContent).toContain(SEAM_WIRE_BINDINGS["run-blocked"].label);
    expect(line.textContent).toContain("run.waiting_for_approval");
  });

  it("carries the failed switch's reason verbatim, and marks it the one caution", () => {
    const line = renderSeam(
      seamOf(
        runRow({
          id: "sf",
          sequence: 5,
          type: "agent.provider_switch_failed",
          runId: "run-a",
          position: 5,
          payload: { reason: "output_speed_unavailable" },
        }),
      ),
    );
    expect(line.textContent).toContain("output_speed_unavailable");
    expect(line.classList.contains("meridian-seam-row--caution")).toBe(true);
  });

  it("negative control: an ordinary switch is not drawn as a caution", () => {
    // Without this the caution assertion above would pass over a row that painted
    // every seam amber, which rule 3 spends on attention alone.
    const line = renderSeam(
      seamOf(
        runRow({
          id: "sw",
          sequence: 6,
          type: "agent.provider_switched",
          runId: "run-a",
          position: 6,
          payload: { continuity: "in_place" },
        }),
      ),
    );
    expect(line.classList.contains("meridian-seam-row--caution")).toBe(false);
  });
});

describe("the seam row — the loss clause is the memo arm's and nobody else's", () => {
  it("renders each declared loss as itself on a memo switch", () => {
    const line = renderSeam(
      seamOf(
        runRow({
          id: "sm",
          sequence: 7,
          type: "agent.provider_switched",
          runId: "run-a",
          position: 7,
          payload: {
            continuity: "memo",
            declaredLosses: ["turn_content_truncated", "a_loss_this_build_never_heard_of"],
          },
        }),
      ),
    );
    expect(line.textContent).toContain("memo");
    expect(line.textContent).toContain("turn_content_truncated");
    // A value the closed wire vocabulary does not carry is still rendered as
    // itself. Mapping it onto a fallback phrase would go quiet on exactly the
    // newest kind of loss.
    expect(line.textContent).toContain("a_loss_this_build_never_heard_of");
  });

  it("negative control: a replayed switch renders the same line with no loss clause", () => {
    // The other two continuity values lost nothing, so a clause on them would be a
    // sentence this component invented. `declaredLosses` is empty on that arm by
    // construction, which is what makes the absence of the clause checkable.
    const line = renderSeam(
      seamOf(
        runRow({
          id: "sr",
          sequence: 8,
          type: "agent.provider_switched",
          runId: "run-a",
          position: 8,
          payload: { continuity: "replayed", declaredLosses: ["turn_content_truncated"] },
        }),
      ),
    );
    expect(line.textContent).toContain("replayed");
    expect(line.textContent).not.toContain("turn_content_truncated");
  });
});

describe("the seam row — a kind the wire does not register says so", () => {
  it("draws the not-checked absence for an unregistered seam type", () => {
    const { container } = render(
      <SeamRow
        seam={seamOf(
          runRow({
            id: "sw2",
            sequence: 9,
            type: "agent.provider_switched",
            runId: "run-a",
            position: 9,
          }),
        )}
      />,
    );
    expect(container.textContent).toContain("does not register that event type");
    expect(container.textContent).toContain("agent.provider_switched");
  });

  it("negative control: a registered seam type draws no such absence", () => {
    // Without this the case above would pass over a row that marked every seam
    // unregistered, which would report the whole vocabulary as unavailable.
    const { container } = render(
      <SeamRow
        seam={seamOf(
          runRow({ id: "p2", sequence: 10, type: "run.paused", runId: "run-a", position: 10 }),
        )}
      />,
    );
    expect(container.textContent).not.toContain("does not register that event type");
  });

  it("draws a compaction stub's missing boundary as an absence, never as zero", () => {
    const line = renderSeam(
      seamOf(
        legacyStubRow({
          id: "c2",
          sequence: 11,
          type: "usage.context_compacted",
          category: "usage_telemetry",
          runId: "run-a",
        }),
      ),
    );
    expect(line.textContent).toContain("carries no boundary position");
    expect(line.textContent).not.toContain("Boundary 0");
  });
});
