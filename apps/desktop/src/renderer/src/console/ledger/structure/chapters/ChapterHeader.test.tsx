// The chapter header, held to what a person can read off one folded run.
//
// The two cases that matter are the ones a fold-level suite cannot make: a live
// chapter had NOTHING on its line but an actor and a count, and the clipped figure
// named rows nothing could reach. Both are rendering claims, so both are read off the
// rendered line.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CHAPTER_VISIBLE_ROW_CAP } from "../../../core/index.js";
import { ChapterHeader } from "./ChapterHeader.js";
import { foldChapters } from "./chapters.js";
import { chapterFor } from "./chapters.test-support.js";
import { runRow } from "../timeline-rows.test-support.js";
import { type TimelineRow } from "@ai-sidekicks/contracts";

const RUN_ID = "run-a";

function oneRun(rowCount: number, payload?: Readonly<Record<string, unknown>>): TimelineRow[] {
  return Array.from({ length: rowCount }, (_unused, index) =>
    runRow({
      id: `r${String(index + 1)}`,
      sequence: index + 1,
      type: index === 0 ? "run.queued" : "run.running",
      summary: `entry ${String(index + 1)}`,
      runId: RUN_ID,
      position: index + 1,
      actor: "agent-one",
      ...(index === 0 && payload !== undefined ? { payload } : {}),
    }),
  );
}

function renderHeader(rows: readonly TimelineRow[], isOpen = false): HTMLElement {
  const { container } = render(
    <ChapterHeader
      chapter={chapterFor(foldChapters(rows).chapters, RUN_ID)}
      isOpen={isOpen}
      onToggle={() => undefined}
    />,
  );
  const line = container.querySelector<HTMLElement>(".meridian-chapter-header");
  if (line === null) {
    throw new Error("the chapter drew no header");
  }
  return line;
}

describe("the chapter header — what one run's line says", () => {
  it("says what the run is doing, which a live chapter could not say before", () => {
    expect(renderHeader(oneRun(3)).textContent).toContain("run.running");
  });

  it("names the account the run is billed to, where the log named one", () => {
    const line = renderHeader(oneRun(3, { admittedProviderAccountId: "acct-7" }));
    expect(line.textContent).toContain("billed to");
    expect(line.textContent).toContain("acct-7");
  });

  it("negative control: draws no account label where the log named none", () => {
    expect(renderHeader(oneRun(3)).textContent).not.toContain("billed to");
  });

  it("keeps the actor and the counts it already carried", () => {
    const line = renderHeader(oneRun(3));
    expect(line.textContent).toContain("agent-one");
    expect(line.textContent).toContain("3 entries");
  });
});

describe("the header's body — mounted only where there is something folded open", () => {
  it("mounts no body while the chapter is folded", () => {
    expect(
      renderHeader(oneRun(CHAPTER_VISIBLE_ROW_CAP + 2)).querySelector(".meridian-chapter-body"),
    ).toBeNull();
  });

  it("mounts the clipped head once the chapter is open", () => {
    const body = renderHeader(oneRun(CHAPTER_VISIBLE_ROW_CAP + 2), true).querySelector(
      ".meridian-chapter-body",
    );
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("entry 1");
  });

  it("mounts no body for an open chapter that clips nothing", () => {
    expect(renderHeader(oneRun(3), true).querySelector(".meridian-chapter-body")).toBeNull();
  });
});
