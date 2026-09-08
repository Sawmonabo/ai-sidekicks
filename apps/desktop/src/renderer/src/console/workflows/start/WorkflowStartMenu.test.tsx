// The composer's picker, driven through the real port: what it lists, what a press
// sends, and what it shows when the daemon says no.
//
// THE DENIAL CASE IS THE ONE THIS SURFACE EXISTS FOR. `workflow.start_denied` had no
// producer anywhere in the composer, so a participant who could not start a run met
// nothing at all. Here the daemon's sentence is carried verbatim and the public role
// matrix renders beside it — and, the half that is easy to lose, the matrix renders for
// THAT code and not for every refusal a start can meet.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { growthUnavailableFromRejection, type GrowthPort } from "../../bridge/index.js";
import {
  PROBE_SESSION_ID,
  definition,
  portAnswering,
  settle,
} from "../workflows-probe.test-support.js";
import { WorkflowStartMenu } from "./WorkflowStartMenu.js";

afterEach(cleanup);

/** The channel a chat-borne start carries as provenance. */
const PROBE_CHANNEL_ID = "019b7a12-0280-75e5-8510-ada11a5a34c1";

/** Two definitions, so the list is a list and the press names one of them. */
const TWO_DEFINITIONS = [
  definition({ id: "release", name: "Release checklist", scope: "session" }),
  definition({
    id: "audit",
    name: "Quarterly audit",
    scope: "project",
    latestWorkflowVersionId: "audit-version-7",
  }),
];

/** Mount the picker over one port and let its enumeration settle. */
async function mountMenu(
  growth: GrowthPort,
  channelId: string | undefined = undefined,
): Promise<HTMLElement> {
  const { container } = render(
    <WorkflowStartMenu growth={growth} sessionId={PROBE_SESSION_ID} channelId={channelId} />,
  );
  await settle();
  return container;
}

describe("the composer's workflow picker", () => {
  it("lists the definitions this session can start, each with the scope it resolves from", async () => {
    const container = await mountMenu(
      portAnswering({ status: "served", value: { definitions: TWO_DEFINITIONS } }),
    );

    expect(screen.getByRole("button", { name: "Release checklist" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Quarterly audit" })).toBeDefined();
    expect(container.textContent).toContain("project");
  });

  it("starts the pressed definition at the pin the enumeration gave it", async () => {
    const workflowRunStart = vi.fn(async () => ({
      status: "served" as const,
      value: { workflowRunId: "run-1", state: "running" as const, phaseStates: [] },
    }));
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: TWO_DEFINITIONS } }),
      workflowRunStart,
    };
    await mountMenu(growth, PROBE_CHANNEL_ID);

    fireEvent.click(screen.getByRole("button", { name: "Quarterly audit" }));
    await settle();

    expect(workflowRunStart).toHaveBeenCalledWith({
      // The entry's own pin and never a version this surface chose.
      workflowVersionId: "audit-version-7",
      sessionId: PROBE_SESSION_ID,
      // Provenance, read off the composer's address rather than composed here.
      channelId: PROBE_CHANNEL_ID,
    });
  });

  it("carries no channel at all when the composer is not addressed within one", async () => {
    const started: unknown[] = [];
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: TWO_DEFINITIONS } }),
      workflowRunStart: async (request) => {
        started.push(request);
        return {
          status: "served" as const,
          value: { workflowRunId: "run-1", state: "running" as const, phaseStates: [] },
        };
      },
    };
    await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: "Release checklist" }));
    await settle();

    expect(started).toHaveLength(1);
    expect(started[0]).not.toHaveProperty("channelId");
  });

  it("names the run a start produced rather than leaving the press unacknowledged", async () => {
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: TWO_DEFINITIONS } }),
      workflowRunStart: async () => ({
        status: "served" as const,
        value: { workflowRunId: "019b7a12-run", state: "running" as const, phaseStates: [] },
      }),
    };
    const container = await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: "Release checklist" }));
    await settle();

    const started = container.querySelector(".meridian-workflow-start-menu__started");
    expect(started?.textContent).toContain("Release checklist");
    expect(started?.textContent).toContain("019b7a12-run");
  });

  it("renders a denied start's own sentence and the public role matrix beside it", async () => {
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: TWO_DEFINITIONS } }),
      // Built through the port's OWN rejection builder rather than as a literal, which
      // is what makes this case about the arm the daemon's word actually arrives on:
      // the builder puts `call-rejected` on `code` and the envelope on `cause`, so a
      // surface reading `code` alone fails here rather than passing on a hand-written
      // shape no seam produces.
      workflowRunStart: async () =>
        growthUnavailableFromRejection("workflowRunStart", {
          code: "workflow.start_denied",
          message: "This participant may not start a workflow in this session.",
        }),
    };
    const container = await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: "Release checklist" }));
    await settle();

    // Verbatim: nothing here paraphrases the daemon or adds a sentence of its own.
    expect(container.textContent).toContain(
      "This participant may not start a workflow in this session.",
    );
    expect(container.textContent).toContain("workflow.start_denied");
    const roles = container.querySelectorAll(".meridian-workflow-start-menu__role");
    expect([...roles].map((role) => role.querySelector("dt")?.textContent)).toEqual([
      "owner",
      "collaborator",
      "runtime contributor",
      "viewer",
    ]);
  });

  it("shows no role matrix for a refusal that is not the denial", async () => {
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: TWO_DEFINITIONS } }),
      workflowRunStart: async () =>
        growthUnavailableFromRejection("workflowRunStart", {
          code: "workflow.not_found",
          message: "That version is gone; refresh the list.",
        }),
    };
    const container = await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: "Release checklist" }));
    await settle();

    expect(container.textContent).toContain("That version is gone; refresh the list.");
    expect(container.querySelector(".meridian-workflow-start-menu__roles")).toBeNull();
  });

  it("leaves the control offered after a refusal, so the press can be made again", async () => {
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: TWO_DEFINITIONS } }),
      workflowRunStart: async () =>
        growthUnavailableFromRejection("workflowRunStart", {
          code: "workflow.start_denied",
          message: "Denied.",
        }),
    };
    await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: "Release checklist" }));
    await settle();

    expect(screen.getByRole("button", { name: "Release checklist" })).toBeDefined();
  });

  it("says where definitions come from rather than offering a dead control when there are none", async () => {
    const container = await mountMenu(
      portAnswering({ status: "served", value: { definitions: [] } }),
    );

    expect(container.textContent).toContain("resolves no workflow definitions");
    expect(container.querySelector(".meridian-workflow-start-menu__list")).toBeNull();
  });

  it("renders the enumeration's own refusal rather than an empty list", async () => {
    const container = await mountMenu(createRefusingGrowthPort());

    expect(container.querySelector(".meridian-refusal")).not.toBeNull();
    expect(container.textContent).not.toContain("resolves no workflow definitions");
  });

  it("offers the next page only while the enumeration holds one", async () => {
    const withMore = await mountMenu(
      portAnswering({
        status: "served",
        value: { definitions: TWO_DEFINITIONS, nextCursor: "definitions-page-2" },
      }),
    );

    expect(withMore.textContent).toContain("Show more definitions");
    cleanup();

    const exhausted = await mountMenu(
      portAnswering({ status: "served", value: { definitions: TWO_DEFINITIONS } }),
    );

    expect(exhausted.textContent).not.toContain("Show more definitions");
  });
});
