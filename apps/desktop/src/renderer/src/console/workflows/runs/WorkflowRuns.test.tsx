// The runs section, and the read under it.
//
// Every case drives a REAL growth port — the fixture's for a scenario that answers,
// the live bridge's refusing one for a wire nobody has registered, and the fixture's
// again for a scenario that scripts a DAEMON refusal. A stand-in port would have
// agreed with whatever this component did, and two of the three arms below exist
// precisely because a port can answer in a way a naive consumer never handles.
//
// The hook has no test of its own: it is this component's only read and this
// component is its only caller, so a second suite would drive the same seam through
// a probe that renders nothing a person sees.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port.js";
import type { ConsoleScenario } from "../../bridge/scenario.js";
import { WORKFLOWS_SCENARIO } from "../../bridge/scenarios/workflows.js";
import { WORKFLOWS_SESSION_ID } from "../../bridge/scenarios/workflow-fixture-ids.js";
import {
  WORKFLOWS_PARKED_RUN,
  WORKFLOWS_SCENARIO_RUNS,
} from "../../bridge/scenarios/workflow-fixture-runs.js";
import { FLAGSHIP_SCENARIO } from "../../bridge/scenarios/flagship.js";
import { LiveAnnouncerProvider } from "../../primitives/index.js";
import { READ_SETTLEMENT_REFUSAL_ORIGIN } from "../../bridge/read-settlement.js";
import { WorkflowRuns } from "./WorkflowRuns.js";

/** The fixture port for one scenario, which is what a fixture console runs on. */
function growthFor(scenario: ConsoleScenario): GrowthPort {
  return createFixtureBridge({ scenario }).growth;
}

/**
 * The workflows scenario with its run enumeration refusing instead of answering.
 *
 * Derived from the real scenario rather than hand-built, so the refusal is the ONE
 * difference: the seam throws a scripted daemon refusal verbatim rather than folding
 * it into the outcome union, and a consumer that attached only a fulfillment handler
 * would leave that rejection unhandled and read forever.
 */
function scenarioRefusingTheEnumeration(): ConsoleScenario {
  return {
    ...WORKFLOWS_SCENARIO,
    replies: WORKFLOWS_SCENARIO.replies.map((reply) =>
      reply.call === "workflow.runList"
        ? {
            call: "workflow.runList",
            refusal: { code: "workflow.run_list_denied", message: "This session is not yours." },
          }
        : reply,
    ),
  };
}

/**
 * The workflows scenario as an older daemon would answer it: runs, and nothing about
 * the definitions they came from.
 *
 * The run table itself IS that answer — it holds each run's own members and neither
 * definition fact — so this substitutes it rather than stripping the served entries,
 * which keeps the fixture's one run table the only run table either case reads.
 */
function scenarioWithoutDefinitionFacts(): ConsoleScenario {
  return {
    ...WORKFLOWS_SCENARIO,
    replies: WORKFLOWS_SCENARIO.replies.map((reply) =>
      reply.call === "workflow.runList"
        ? { call: "workflow.runList", result: { runs: WORKFLOWS_SCENARIO_RUNS } }
        : reply,
    ),
  };
}

function renderRuns(
  growth: GrowthPort,
  sessionId: string = WORKFLOWS_SESSION_ID,
): { readonly container: HTMLElement; readonly rerender: () => void } {
  const element = (
    <LiveAnnouncerProvider>
      <WorkflowRuns growth={growth} sessionId={sessionId} />
    </LiveAnnouncerProvider>
  );
  const { container, rerender } = render(element);
  return {
    container,
    rerender: () => {
      rerender(element);
    },
  };
}

/** Let the enumeration settle, so an assertion is about an answer and not a wait. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function rowLabels(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-run-row__name")].map(
    (name) => name.textContent ?? "",
  );
}

/** Every run row's own identity, which the meta line carries whatever the label says. */
function rowRunIds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-run-row__meta")].map(
    (meta) => meta.querySelector(".meridian-figure--wire")?.textContent ?? "",
  );
}

function politeAnnouncement(container: HTMLElement): string {
  const region = container.querySelector<HTMLElement>('[data-live-region="polite"]');
  if (region === null) {
    throw new Error("no polite live region was mounted");
  }
  return region.textContent ?? "";
}

describe("the runs the session holds", () => {
  it("draws every run the enumeration served, attention first", async () => {
    const { container } = renderRuns(growthFor(WORKFLOWS_SCENARIO));
    await settle();

    expect(rowLabels(container)).toHaveLength(4);
    // The parked run leads, which is the projection's band order reaching a person
    // rather than the order the scenario happens to state its table in. Asserted on
    // the row's own identity rather than its label, because the label is now the
    // definition's name — which is the point of the case below.
    expect(rowRunIds(container)[0]).toBe(WORKFLOWS_PARKED_RUN.workflowRunId);
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("names each run by the definition it was started from", async () => {
    // The enumeration carries the definition facts a single run read cannot: without
    // them every row fell back to an opaque run id, which is the identity a person
    // pastes into a search and not the thing they are looking for.
    const { container } = renderRuns(growthFor(WORKFLOWS_SCENARIO));
    await settle();

    expect(rowLabels(container)).toStrictEqual([
      "Ship pipeline",
      "Ship pipeline",
      "Release checks",
      "Incident triage",
    ]);
  });

  it("marks the run pinned to a version its definition has moved past", async () => {
    // The frozen pin is an inequality between the run's pinned version and the
    // definition's newest, and neither the run read nor any other registered read
    // supplies the second — so before the enumeration carried it this label could
    // never render, for any run, in any build.
    const { container } = renderRuns(growthFor(WORKFLOWS_SCENARIO));
    await settle();

    const frozen = [...container.querySelectorAll(".meridian-run-row")].filter((row) =>
      row.textContent?.includes("Frozen on an older version"),
    );
    expect(frozen).toHaveLength(1);
    expect(container.querySelector(".meridian-run-list__summary")?.textContent).toContain(
      "Frozen pins",
    );
  });

  it("negative control: entries without the definition facts fall back to ids and no mark", async () => {
    // The three positive claims above rest on the join being real. Strip the two
    // members from every served entry and the surface must go back to what it drew
    // before: opaque ids, and a frozen state reported as unknown rather than guessed.
    const { container } = renderRuns(growthFor(scenarioWithoutDefinitionFacts()));
    await settle();

    expect(rowLabels(container)).toStrictEqual(rowRunIds(container));
    expect(container.textContent).not.toContain("Frozen on an older version");
    expect(container.querySelector(".meridian-run-list__summary")?.textContent).not.toContain(
      "Frozen pins",
    );
  });

  it("negative control: a scenario that states no runs draws the empty absence", async () => {
    // Served-and-empty is a real answer and reads differently from every failure
    // below it: the list says there are none rather than that nothing was asked.
    const { container } = renderRuns(growthFor(FLAGSHIP_SCENARIO), FLAGSHIP_SCENARIO.sessionId);
    await settle();

    expect(rowLabels(container)).toHaveLength(0);
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });

  it("renders the port's refusal and no list where the wire is unregistered", async () => {
    // The live bridge's arm: nobody asked, because the enumeration is registered
    // nowhere. An empty list here would assert that this session holds no runs.
    const { container } = renderRuns(createRefusingGrowthPort());
    await settle();

    const refusal = container.querySelector(".meridian-refusal");

    expect(refusal?.textContent ?? "").toContain("wire-unregistered");
    expect(container.querySelector(".meridian-run-list")).toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("renders a scripted daemon refusal rather than reading forever", async () => {
    // The rejection arm. The seam throws the daemon's envelope verbatim, so a
    // consumer with no rejection handler leaves the promise unhandled and the
    // surface pinned in its loading state — which is what this case fails on.
    const { container } = renderRuns(growthFor(scenarioRefusingTheEnumeration()));
    await settle();

    const refusal = container.querySelector(".meridian-refusal");

    expect(refusal?.textContent ?? "").toContain("workflow.run_list_denied");
    expect(refusal?.textContent ?? "").toContain("This session is not yours.");
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });

  it("names a rejection carrying no daemon envelope under the settlement's own code", async () => {
    // The other side of the case above, and the control on it: a read that broke
    // before it produced an answer is not the daemon refusing, and the shared
    // settlement says so under a code of its own rather than attributing a fault to
    // an author who never answered.
    const served = growthFor(WORKFLOWS_SCENARIO);
    const breaking: GrowthPort = {
      ...served,
      workflowRunList: () => Promise.reject(new Error("the bridge closed mid-read")),
    };
    const { container } = renderRuns(breaking);
    await settle();

    const refusal = container.querySelector(".meridian-refusal");

    expect(refusal?.textContent ?? "").toContain(`${READ_SETTLEMENT_REFUSAL_ORIGIN}-call-failed`);
    expect(refusal?.textContent ?? "").toContain("the bridge closed mid-read");
  });

  it("asks once per mount, and a re-render asks nothing more", async () => {
    // Wrapped rather than replaced: the real fixture port answers every call and
    // this only counts the one. A read that re-ran on every render would be a
    // polling loop nobody scheduled.
    const served = growthFor(WORKFLOWS_SCENARIO);
    let readCount = 0;
    const counting: GrowthPort = {
      ...served,
      workflowRunList: async (request) => {
        readCount += 1;
        return served.workflowRunList(request);
      },
    };
    const { rerender } = renderRuns(counting);
    await settle();
    rerender();
    await settle();

    expect(readCount).toBe(1);
  });
});

describe("what the runs section says out loud", () => {
  it("announces the settlement once, with what it read", async () => {
    const { container, rerender } = renderRuns(growthFor(WORKFLOWS_SCENARIO));
    await settle();

    expect(politeAnnouncement(container)).toBe("Runs in this session: 4.");

    rerender();
    await settle();

    // Negative control: the same settlement re-rendered says nothing further. A
    // repeat would talk over the surface it just described.
    expect(politeAnnouncement(container)).toBe("Runs in this session: 4.");
  });

  it("announces the refusal's own sentence when the read refuses", async () => {
    const { container } = renderRuns(createRefusingGrowthPort());
    await settle();

    expect(politeAnnouncement(container)).toContain("Not checked");
  });
});
