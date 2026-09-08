// The provenance every linkage row carries, which for a long time none of them rendered.
//
// Split from `RunLinkage.test.tsx`, which is about what the view is forbidden to
// DERIVE — the link type's meaning, the visibility outcome, the depth limit, and the
// refusal fold's completeness. This is about members that were on the read and reached
// no pixel, which is the opposite failure: nothing was derived wrongly, the facts were
// simply dropped. Two subjects, and keeping them in one file put it past the module
// budget besides.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunLinkage } from "./RunLinkage.js";
import { formatDateTime } from "../../primitives/index.js";
import type { ChildRunLinkReading } from "../../bridge/index.js";
import type { PushDrivenReadState } from "../../seats/index.js";

function loaded(value: ChildRunLinkReading): PushDrivenReadState<ChildRunLinkReading> {
  return { kind: "loaded", value };
}

describe("run linkage — the provenance every row carries and none of them rendered", () => {
  it("dates a refusal, which is the only record the refused work leaves anywhere", () => {
    // A refusal is zero-residue, so a fold with no instant on it cannot place the
    // refusal against anything else: two refusals of one reason read as one repeated
    // fact, and a refusal before a link is indistinguishable from one after it.
    const occurredAt = "2026-03-04T11:22:33.000Z";
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [],
          rejectedCreates: [{ reason: "orchestration.budget_exhausted", occurredAt }],
        })}
      />,
    );

    const when = container.querySelector(".meridian-linkage__refusal-when");
    expect(when?.textContent ?? "").toContain(formatDateTime(occurredAt));
    // The formatted reading hides nothing: the exact wire value rides `title`.
    expect(when?.querySelector(".meridian-figure--wire")?.getAttribute("title")).toBe(occurredAt);
  });

  it("negative control: a refusal carrying no instant prints no time clause", () => {
    // Without this, the case above would pass over a row that stamped every refusal
    // with a time the console had invented.
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [],
          rejectedCreates: [{ reason: "orchestration.node_not_local" }],
        })}
      />,
    );

    expect(container.querySelector(".meridian-linkage__refusal-when")).toBeNull();
    expect(container.textContent ?? "").toContain("orchestration.node_not_local");
  });

  it("says where a child was started and when it was linked", () => {
    // Both members are on the read and neither reached a pixel, which left an
    // unreachable child unable to answer either question a person asks of one.
    const createdAt = "2026-03-04T09:00:00.000Z";
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-20",
              linkType: "delegate",
              internalHelper: false,
              visibility: "unreachable",
              state: "running",
              producingNodeId: "node-atlas",
              createdAt,
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );

    const provenance = container.querySelector(".meridian-linkage__link-provenance");
    const text = provenance?.textContent ?? "";
    expect(text).toContain("node-atlas");
    expect(text).toContain(formatDateTime(createdAt));
    expect(provenance?.querySelector('[title="' + createdAt + '"]')).not.toBeNull();
  });

  it("carries the creation facts separately from the live visibility reading", () => {
    // The node id is where the child was STARTED and never where it is running now;
    // reading it off the same line as `visibility` would invite exactly the inference
    // this view is forbidden to make.
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-21",
              linkType: "spawn",
              internalHelper: false,
              visibility: "unreachable",
              state: "running",
              producingNodeId: "node-atlas",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );

    expect(
      container.querySelector(".meridian-linkage__link-state")?.textContent ?? "",
    ).not.toContain("node-atlas");
    expect(
      container.querySelector(".meridian-linkage__link-provenance")?.textContent ?? "",
    ).toContain("node-atlas");
  });

  it("negative control: a link carrying neither member renders no provenance line", () => {
    // Without this, the two cases above would pass over a row that printed an empty
    // provenance line on every child.
    const { container } = render(
      <RunLinkage
        parentRunId="run-1"
        state={loaded({
          links: [
            {
              childRunId: "run-22",
              linkType: "spawn",
              internalHelper: false,
              visibility: "reachable",
            },
          ],
          rejectedCreates: [],
        })}
      />,
    );

    expect(container.querySelector(".meridian-linkage__link-provenance")).toBeNull();
    expect(container.querySelectorAll(".meridian-linkage__link")).toHaveLength(1);
  });
});
