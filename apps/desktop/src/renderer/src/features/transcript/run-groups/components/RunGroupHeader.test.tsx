// The run group header, held to what a person can read off one folded run. These are rendering
// claims, so they are read off the rendered line rather than off the fold model.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RUN_GROUP_VISIBLE_ROW_CAP } from "../../structure/structure-caps.js";
import { RunGroupHeader } from "./RunGroupHeader.js";
import { groupRowsByRun } from "../run-groups.js";
import { findRunGroup } from "../run-groups.test-support.js";
import { runRow } from "../../timeline-rows.test-support.js";
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
    <RunGroupHeader
      runGroup={findRunGroup(groupRowsByRun(rows).runGroups, RUN_ID)}
      isOpen={isOpen}
      onToggle={() => undefined}
    />,
  );
  const line = container.querySelector<HTMLElement>(".meridian-run-group-header");
  if (line === null) {
    throw new Error("the run group drew no header");
  }
  return line;
}

describe("the run group header — what one run's line says", () => {
  it("says what the run is doing, which a live run group could not say before", () => {
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
  it("mounts no body while the run group is folded", () => {
    expect(
      renderHeader(oneRun(RUN_GROUP_VISIBLE_ROW_CAP + 2)).querySelector(".meridian-run-group-body"),
    ).toBeNull();
  });

  it("mounts the clipped head once the run group is open", () => {
    const body = renderHeader(oneRun(RUN_GROUP_VISIBLE_ROW_CAP + 2), true).querySelector(
      ".meridian-run-group-body",
    );
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain("entry 1");
  });

  it("mounts no body for an open run group that clips nothing", () => {
    expect(renderHeader(oneRun(3), true).querySelector(".meridian-run-group-body")).toBeNull();
  });
});
