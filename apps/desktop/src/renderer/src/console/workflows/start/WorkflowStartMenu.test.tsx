// The composer's picker, driven through the real port: what it lists, what a press
// sends, and what it shows when the daemon says no.
//
// THE CONTROLS ARE NAMED BY DEFINITION AND SCOPE, which is why every query here asks for
// a scoped name: two definitions may deliberately share a name across scopes, so a query
// on the name alone would be ambiguous exactly where the surface is.
//
// THE DENIAL CASE IS THE ONE THIS SURFACE EXISTS FOR. `workflow.start_denied` had no
// producer anywhere in the composer, so a participant who could not start a run met
// nothing at all. Here the daemon's sentence is carried verbatim and the public role
// matrix renders beside it — and, the half that is easy to lose, the matrix renders for
// THAT code and not for every refusal a start can meet.
//
// THE PAGES PAST THE FIRST ARE NEXT DOOR, in `WorkflowStartMenu.continuation.test.tsx`:
// a second page is another wire with its own four states, and the one case here about
// the continuation is the one this suite's subject decides — whether the control is
// offered at all.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { growthUnavailableFromRejection, type GrowthPort } from "../../bridge/index.js";
import {
  PROBE_SESSION_ID,
  definition,
  portAnswering,
  settle,
} from "../workflows-probe.test-support.js";
import { START_DEFINITIONS, heldStartPort, mountMenu } from "./workflow-start.test-support.js";

afterEach(cleanup);

/** The channel a chat-borne start carries as provenance. */
const PROBE_CHANNEL_ID = "019b7a12-0280-75e5-8510-ada11a5a34c1";

/** The two scoped names the picker gives its controls, as a person hears them. */
const RELEASE_CONTROL = "Start Release checklist from the session scope";
const AUDIT_CONTROL = "Start Quarterly audit from the project scope";

describe("the composer's workflow picker", () => {
  it("lists the definitions this session can start, each with the scope it resolves from", async () => {
    const container = await mountMenu(
      portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
    );

    expect(screen.getByRole("button", { name: RELEASE_CONTROL })).toBeDefined();
    expect(screen.getByRole("button", { name: AUDIT_CONTROL })).toBeDefined();
    expect(container.textContent).toContain("project");
  });

  it("starts the pressed definition at the pin the enumeration gave it", async () => {
    const workflowRunStart = vi.fn(async () => ({
      status: "served" as const,
      value: { workflowRunId: "run-1", state: "running" as const, phaseStates: [] },
    }));
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
      workflowRunStart,
    };
    await mountMenu(growth, PROBE_CHANNEL_ID);

    fireEvent.click(screen.getByRole("button", { name: AUDIT_CONTROL }));
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
      ...portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
      workflowRunStart: async (request) => {
        started.push(request);
        return {
          status: "served" as const,
          value: { workflowRunId: "run-1", state: "running" as const, phaseStates: [] },
        };
      },
    };
    await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: RELEASE_CONTROL }));
    await settle();

    expect(started).toHaveLength(1);
    expect(started[0]).not.toHaveProperty("channelId");
  });

  it("names the run a start produced rather than leaving the press unacknowledged", async () => {
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
      workflowRunStart: async () => ({
        status: "served" as const,
        value: { workflowRunId: "019b7a12-run", state: "running" as const, phaseStates: [] },
      }),
    };
    const container = await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: RELEASE_CONTROL }));
    await settle();

    const started = container.querySelector(".meridian-workflow-start-menu__started");
    expect(started?.textContent).toContain("Release checklist");
    expect(started?.textContent).toContain("019b7a12-run");
  });

  it("renders a denied start's own sentence and the public role matrix beside it", async () => {
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
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

    fireEvent.click(screen.getByRole("button", { name: RELEASE_CONTROL }));
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
      ...portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
      workflowRunStart: async () =>
        growthUnavailableFromRejection("workflowRunStart", {
          code: "workflow.not_found",
          message: "That version is gone; refresh the list.",
        }),
    };
    const container = await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: RELEASE_CONTROL }));
    await settle();

    expect(container.textContent).toContain("That version is gone; refresh the list.");
    expect(container.querySelector(".meridian-workflow-start-menu__roles")).toBeNull();
  });

  it("leaves the control offered after a refusal, so the press can be made again", async () => {
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
      workflowRunStart: async () =>
        growthUnavailableFromRejection("workflowRunStart", {
          code: "workflow.start_denied",
          message: "Denied.",
        }),
    };
    await mountMenu(growth);

    fireEvent.click(screen.getByRole("button", { name: RELEASE_CONTROL }));
    await settle();

    expect(screen.getByRole("button", { name: RELEASE_CONTROL })).toBeDefined();
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
        value: { definitions: START_DEFINITIONS, nextCursor: "definitions-page-2" },
      }),
    );

    expect(withMore.textContent).toContain("Show more definitions");
    cleanup();

    const exhausted = await mountMenu(
      portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
    );

    expect(exhausted.textContent).not.toContain("Show more definitions");
  });
});

describe("each start control says which definition AND which scope it would start", () => {
  /** Two definitions that deliberately share a name, which is what scopes are for. */
  const SHARED_NAME = [
    definition({ id: "release-session", name: "Release checklist", scope: "session" }),
    definition({
      id: "release-shared",
      name: "Release checklist",
      scope: "shared",
      scopeRef: "",
      latestWorkflowVersionId: "release-shared-version-1",
    }),
  ];

  it("distinguishes two controls whose visible names are the same", async () => {
    await mountMenu(portAnswering({ status: "served", value: { definitions: SHARED_NAME } }));

    // The scope chip sits beside the button and is not part of its name, so before this
    // a screen-reader user met two identically named start controls and could not tell
    // which one they were about to press.
    expect(screen.getByRole("button", { name: RELEASE_CONTROL })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Start Release checklist from the shared scope" }),
    ).toBeDefined();
  });

  it("starts the definition whose scoped name was pressed", async () => {
    const started: unknown[] = [];
    const growth: GrowthPort = {
      ...portAnswering({ status: "served", value: { definitions: SHARED_NAME } }),
      workflowRunStart: async (request) => {
        started.push(request);
        return {
          status: "served" as const,
          value: { workflowRunId: "run-1", state: "running" as const, phaseStates: [] },
        };
      },
    };
    await mountMenu(growth);

    fireEvent.click(
      screen.getByRole("button", { name: "Start Release checklist from the shared scope" }),
    );
    await settle();

    // The name has to lead to the row it names, or it is a label rather than a control.
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ workflowVersionId: "release-shared-version-1" });
  });

  it("keeps the visible label the name alone, as the design has it", async () => {
    const container = await mountMenu(
      portAnswering({ status: "served", value: { definitions: SHARED_NAME } }),
    );

    // The scope reaches the accessible name and the visible row is unchanged: the chip
    // beside it is still where a sighted reader meets the scope.
    const starts = container.querySelectorAll(".meridian-workflow-start-menu__start");
    expect([...starts].map((start) => start.textContent)).toStrictEqual([
      "Release checklist",
      "Release checklist",
    ]);
  });
});

describe("a start in flight closes the picker's controls and says why", () => {
  it("disables every start while one is outstanding, with the cause said once", async () => {
    const held = heldStartPort();
    const container = await mountMenu({
      ...portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
      workflowRunStart: held.workflowRunStart,
    });

    fireEvent.click(screen.getByRole("button", { name: RELEASE_CONTROL }));
    await settle();

    const starts = [
      ...container.querySelectorAll<HTMLButtonElement>(".meridian-workflow-start-menu__start"),
    ];
    expect(starts).toHaveLength(2);
    expect(starts.map((start) => start.disabled)).toStrictEqual([true, true]);
    // Once, for the list, rather than a copy per row: it is one fact about the picker.
    const flight = container.querySelectorAll(".meridian-workflow-start-menu__flight");
    expect(flight).toHaveLength(1);
    expect(flight[0]?.textContent).toContain("Release checklist");
  });

  it("offers every start again once the daemon has answered", async () => {
    const held = heldStartPort();
    const container = await mountMenu({
      ...portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
      workflowRunStart: held.workflowRunStart,
    });

    fireEvent.click(screen.getByRole("button", { name: RELEASE_CONTROL }));
    await settle();
    held.serve();
    await settle();

    const starts = [
      ...container.querySelectorAll<HTMLButtonElement>(".meridian-workflow-start-menu__start"),
    ];
    expect(starts.map((start) => start.disabled)).toStrictEqual([false, false]);
    expect(container.querySelector(".meridian-workflow-start-menu__flight")).toBeNull();
  });

  it("negative control: nothing is disabled before a press", async () => {
    // Without this the case above would be satisfied by a picker whose rows were
    // disabled from the first frame, which offers no control at all.
    const container = await mountMenu(
      portAnswering({ status: "served", value: { definitions: START_DEFINITIONS } }),
    );

    const starts = [
      ...container.querySelectorAll<HTMLButtonElement>(".meridian-workflow-start-menu__start"),
    ];
    expect(starts.map((start) => start.disabled)).toStrictEqual([false, false]);
    expect(screen.getByRole("button", { name: AUDIT_CONTROL })).toBeDefined();
  });
});
