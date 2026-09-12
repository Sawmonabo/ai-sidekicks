// The session header's derivation: when it may say nothing needs anybody, and how much
// it says is waiting when something does.
//
// The all-clear's third conjunct is the one that reaches outside the log. The header
// draws an amber mark this fold cannot see — the node's health — so the verdict is an
// input here rather than a second derivation in the component, and the cases below are
// what says the strip can no longer contradict itself.

import { describe, expect, it } from "vitest";

import { deriveCastBar } from "./cast-bar-model.js";
import { castBarOver, castEvent, ledgerOver, withRun } from "./cast-bar-model.test-support.js";

const AGENT = "agent-architect";

describe("deriveCastBar — the all-clear line", () => {
  it("says nothing needs you only when nothing does", () => {
    expect(castBarOver([castEvent(1, AGENT, "run.running")]).standing).toBe("all-clear");
    expect(castBarOver([castEvent(1, AGENT, "run.waiting_for_approval")]).standing).toBe(
      "attention",
    );
  });

  it("keeps a block standing while a parallel run moves on, and counts it", () => {
    // The defect: attention was read off the newest row, so an agent waiting on an
    // approval in one run and working in another looked clear, and the header said
    // "Nothing needs you" over a run that was still blocked.
    const model = castBarOver([
      withRun(castEvent(1, AGENT, "run.waiting_for_approval"), "run-a"),
      withRun(castEvent(2, AGENT, "run.running"), "run-b"),
      withRun(castEvent(3, AGENT, "tool.invoked"), "run-b"),
    ]);
    expect(model.standing).toBe("attention");
    expect(model.outstandingAskCount).toBe(1);
  });

  it("negative control: the block clears once that run itself moves on", () => {
    // Without this, the case above would pass over a fold that never cleared
    // anything, which would leave the header permanently amber.
    const model = castBarOver([
      withRun(castEvent(1, AGENT, "run.waiting_for_approval"), "run-a"),
      withRun(castEvent(2, AGENT, "run.running"), "run-b"),
      withRun(castEvent(3, AGENT, "run.running"), "run-a"),
    ]);
    expect(model.standing).toBe("all-clear");
    expect(model.outstandingAskCount).toBe(0);
  });

  it("refuses to claim all-clear over an incomplete projection", () => {
    // A store with a sequence gap cannot know whether something needs an answer, and
    // "Nothing needs you." over an incomplete projection is a claim the console has
    // no standing to make.
    const model = castBarOver([], { isDegraded: true });
    expect(model.standing).toBe("attention");
    // And no figure, because nothing was counted: the degradation is reported by the
    // banner above, and a count of zero beside it would read as a count of asks.
    expect(model.outstandingAskCount).toBe(0);
  });

  it("refuses to claim all-clear while the node's health mark is amber", () => {
    // The mark the header draws beside this line is one this fold cannot see, and a
    // line saying nothing is amber printed next to an amber mark is the strip
    // contradicting itself. The log here is spotless: the verdict alone decides it.
    const model = castBarOver([], { isNodeUnwell: true });
    expect(model.standing).toBe("attention");
    expect(model.outstandingAskCount).toBe(0);
  });

  it("says the count is partial where the window opened partway through the log", () => {
    // The all-clear line is a CLAIM about everything, and a resumed read establishes a
    // window whose head is somewhere in the middle: the request lifecycles below it
    // have no base-state carrier, so zero read is not zero. The strip says which, and
    // the log here is otherwise spotless — the read position alone decides it.
    const model = deriveCastBar({
      outstandingAsks: ledgerOver([], { readFromCursor: "cursor-42" }),
      isDegraded: false,
      isNodeUnwell: false,
    });
    expect(model.standing).toBe("earlier-unread");
  });

  it("lets a block the console DID read outrank the rows it did not", () => {
    // Two true things, one line: a reader with a block in front of them gains nothing
    // from a sentence about rows below the window, and the pair would leave them
    // deciding which is the news.
    const blocked = [withRun(castEvent(1, AGENT, "run.waiting_for_approval"), "run-a")];
    const model = deriveCastBar({
      outstandingAsks: ledgerOver(blocked, { readFromCursor: "cursor-42" }),
      isDegraded: false,
      isNodeUnwell: false,
    });
    expect(model.standing).toBe("attention");
    expect(model.outstandingAskCount).toBe(1);
  });

  it("negative control: the same spotless log with a healthy node IS the all-clear", () => {
    // Without this the cases above would pass over a fold that had stopped saying the
    // line at all, which is the failure the line exists to avoid from the other side.
    expect(castBarOver([]).standing).toBe("all-clear");
  });
});
