// What a run started, and the one thing this fold is the ONLY record of.
//
// A refused create is zero-residue — no run, no queue entry, no link row — so if
// this list hides it, nothing else shows it. The other cases pin the three readings
// the view is forbidden to derive: the link type's meaning, the visibility outcome,
// and the depth limit.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse } from "../core/index.js";
import { RunLinkage } from "./RunLinkage.js";
import type { ChildRunLinkReading, ChildRunRejection } from "./agent-wire.js";
import type { PushDrivenReadState } from "../seats/index.js";

function loaded(value: ChildRunLinkReading): PushDrivenReadState<ChildRunLinkReading> {
  return { kind: "loaded", value };
}

describe("run linkage — before there is a run to ask about", () => {
  it("says the read is keyed by a run and there is none", () => {
    const { container } = render(<RunLinkage parentRunId={undefined} state={undefined} />);
    expect(container.textContent ?? "").toContain("read per run");
  });

  it("renders the refusal when the read failed", () => {
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={{ kind: "failed", refusal: refuse("child-run-linkage", "read-failed", "no route") }}
      />,
    );
    expect(container.textContent ?? "").toContain("no route");
  });

  it("negative control: a loaded empty read says the run started nothing", () => {
    // Distinct from both absences above: the question was asked and answered.
    const { container } = render(
      <RunLinkage parentRunId="run-1" state={loaded({ links: [], rejectedCreates: [] })} />,
    );
    expect(container.textContent ?? "").toContain("This run started nothing.");
    expect(container.textContent ?? "").not.toContain("read per run");
  });
});

describe("run linkage — the three relationships", () => {
  it("names what each link type means", () => {
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-2",
              linkType: "spawn",
              internalHelper: false,
              visibility: "reachable",
            },
            {
              childRunId: "run-3",
              linkType: "handoff",
              internalHelper: false,
              visibility: "reachable",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("its output returns here");
    expect(text).toContain("the parent completed");
  });

  it("renders a link type it does not know rather than dropping the row", () => {
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-4",
              linkType: "mirror",
              internalHelper: false,
              visibility: "reachable",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );
    expect(container.querySelectorAll(".meridian-linkage__link").length).toBe(1);
    expect(container.textContent ?? "").toContain("does not know by name");
  });

  it("keeps an internal helper in the list, de-emphasized", () => {
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-5",
              linkType: "spawn",
              internalHelper: true,
              visibility: "reachable",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );
    expect(container.querySelector(".meridian-linkage__link--helper")).not.toBeNull();
    expect(container.textContent ?? "").toContain("run-5");
  });

  it("negative control: an ordinary child carries no helper mark", () => {
    // Without this, the case above would pass over a list that marked every row.
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-6",
              linkType: "spawn",
              internalHelper: false,
              visibility: "reachable",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );
    expect(container.querySelector(".meridian-linkage__link--helper")).toBeNull();
  });
});

describe("run linkage — visibility is not a run state", () => {
  it("labels an unreachable child's last-known state as a visibility outcome", () => {
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-7",
              linkType: "delegate",
              internalHelper: false,
              visibility: "unreachable",
              state: "running",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Last known state");
    expect(text).toContain("not a run-state transition");
  });

  it("treats a visibility it does not know as not-confirmed-reachable", () => {
    // Reading an unrecognized member as reachable would present a stale state as a
    // live one — the one wrong answer on this axis.
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-9",
              linkType: "spawn",
              internalHelper: false,
              visibility: "quarantined",
              state: "running",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("quarantined");
    expect(text).toContain("Last known state");
  });

  it("negative control: a reachable child says nothing about visibility", () => {
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-8",
              linkType: "delegate",
              internalHelper: false,
              visibility: "reachable",
              state: "running",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );
    expect(container.textContent ?? "").not.toContain("Last known state");
  });
});

/**
 * More refused creates than any cap this view ever carried.
 *
 * Distinct reasons, because the list keys on the reason and its index: a run of
 * identical rows would prove nothing about how many of them survive the render.
 */
function manyRefusals(): readonly ChildRunRejection[] {
  return Array.from({ length: 17 }, (_unused, index) => ({
    reason: `orchestration.refused_${String(index)}`,
    targetAgentId: `agent-${String(index)}`,
  }));
}

describe("run linkage — refusals, the only record work asked for and denied gets", () => {
  it("shows a refusal even though the run it would have created never existed", () => {
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [],
          rejectedCreates: [{ reason: "orchestration.depth_exceeded", maxDepth: 1 }],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("orchestration.depth_exceeded");
    // Taken from the refusal's own payload rather than from a console constant.
    expect(text).toContain("1 layer of nesting");
  });

  it("renders every refusal, however many the run accumulated", () => {
    // The defect: the disclosure counted the whole collection and then sliced it, so
    // past the cap a person read a number they could not reach the rows behind. The
    // group scrolls instead — a bounded REGION, not a bounded list.
    const refusals = manyRefusals();
    const { container } = render(
      <RunLinkage parentRunId="run-1" state={loaded({ links: [], rejectedCreates: refusals })} />,
    );

    expect(container.querySelectorAll(".meridian-linkage__refusal")).toHaveLength(refusals.length);
    expect(container.textContent ?? "").toContain("orchestration.refused_16");
  });

  it("says the same number it renders", () => {
    // The count and the rows are one claim. A summary reporting more than the list
    // holds is exactly the shape the slice left behind.
    const refusals = manyRefusals();
    const { container } = render(
      <RunLinkage parentRunId="run-1" state={loaded({ links: [], rejectedCreates: refusals })} />,
    );

    expect(container.querySelector(".meridian-linkage__refusals-summary")?.textContent).toBe(
      `${String(refusals.length)} refused`,
    );
    expect(container.querySelectorAll(".meridian-linkage__refusal")).toHaveLength(refusals.length);
  });

  it("negative control: the list renders the collection it was handed and not a fixed run", () => {
    // Without this, the two cases above would pass over a view that rendered the
    // same number of rows whatever it was given.
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({ links: [], rejectedCreates: manyRefusals().slice(0, 2) })}
      />,
    );

    expect(container.querySelectorAll(".meridian-linkage__refusal")).toHaveLength(2);
  });

  it("negative control: a refusal carrying no depth prints no depth sentence", () => {
    // Without this, the case above would pass over a view that printed a hardcoded
    // limit on every refusal — which is precisely what it refuses to derive.
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [],
          rejectedCreates: [{ reason: "sidekick.not_found", targetAgentId: "agent-ghost" }],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("layer of nesting");
    expect(text).toContain("agent-ghost");
  });
});
