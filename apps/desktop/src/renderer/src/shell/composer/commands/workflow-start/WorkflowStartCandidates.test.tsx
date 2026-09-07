// That the candidates are enumerated WHILE the name is typed, in the real composer.
//
// `Spec-017 §Chat-start surface (SA-38)` asks for an autocomplete that "enumerates
// candidates via `workflow.definitionList`". The accelerator read that enumeration
// only after Enter, to resolve a name somebody had to know already — so a person who
// did not know it was told the name they guessed does not exist and offered nothing
// instead. These cases drive the shipped composer: the real seat, the real discovery
// popover, and the real fixture bridge with this one growth operation scripted.
//
// The negative control is the one that makes the rest mean anything: a line that is
// not this command's asks the wire nothing, so the read is driven by the typed
// argument rather than fired on every open.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { fixtureBridgeWithGrowth } from "../../../../console/bridge/fixture/fixture-bridge.test-support.js";
import { COMPOSER_SCENARIO } from "../../../../console/bridge/scenarios/composer.js";
import { crossMacrotaskBoundary } from "../../../../console/core/macrotask-boundary.test-support.js";
import {
  mountComposer,
  typeIntoLine,
  type MountedComposer,
} from "../provider-command-discovery.test-support.js";
import {
  fixtureGrowthPort,
  recordedWorkflowCalls,
  type WorkflowDefinitionPage,
  type WorkflowFixtureOptions,
  type WorkflowPortCalls,
} from "./workflow-start.test-support.js";

/** The composer mounted over a bridge whose definition enumeration this case scripts. */
async function mountOverDefinitions(
  options: WorkflowFixtureOptions,
): Promise<{ readonly mounted: MountedComposer; readonly calls: WorkflowPortCalls }> {
  const calls = recordedWorkflowCalls();
  const port = fixtureGrowthPort({ ...options, calls });
  const mounted = await mountComposer({
    // Every other namespace is the fixture's own, so the composer this mounts is the
    // one a window builds rather than a stand-in holding four methods.
    bridge: fixtureBridgeWithGrowth(COMPOSER_SCENARIO, {
      workflowDefinitionList: port.workflowDefinitionList,
    }),
    focusedPane: undefined,
  });
  return { mounted, calls };
}

/** The names the candidate list is offering. */
function candidateNames(mounted: MountedComposer): readonly string[] {
  return [...mounted.container.querySelectorAll(".meridian-workflow-start__candidate-name")].map(
    (element) => element.textContent ?? "",
  );
}

/** Two pages, so the case about the cursor is about a real second page. */
const TWO_PAGES: readonly WorkflowDefinitionPage[] = [
  { definitions: [{ name: "nightly" }] },
  { definitions: [{ name: "release" }] },
];

describe("the `/workflow start` argument completion", () => {
  it("enumerates the definitions while the name is still being typed", async () => {
    const { mounted, calls } = await mountOverDefinitions({
      definitions: [{ name: "nightly" }, { name: "release" }],
    });

    await typeIntoLine(mounted.line, "/workflow start ");

    expect(calls.listed).toHaveLength(1);
    expect(calls.listed[0]?.sessionId).toBe(COMPOSER_SCENARIO.sessionId);
    expect(candidateNames(mounted)).toStrictEqual(["nightly", "release"]);
  });

  it("negative control: a line that is not this command's asks the wire nothing", async () => {
    const { mounted, calls } = await mountOverDefinitions({
      definitions: [{ name: "nightly" }],
    });

    // A directive line that opens the same popover, and names another command.
    await typeIntoLine(mounted.line, "/frame.goToSettings");

    expect(calls.listed).toHaveLength(0);
    expect(candidateNames(mounted)).toStrictEqual([]);
  });

  it("narrows what it offers as more of the name arrives, without asking again", async () => {
    const { mounted, calls } = await mountOverDefinitions({
      definitions: [{ name: "nightly" }, { name: "release" }],
    });
    await typeIntoLine(mounted.line, "/workflow start ");

    await typeIntoLine(mounted.line, "/workflow start rel");

    expect(candidateNames(mounted)).toStrictEqual(["release"]);
    // Nothing polls and nothing re-reads per keystroke: the filtering is arithmetic
    // over the list already in hand.
    expect(calls.listed).toHaveLength(1);
  });

  it("offers a definition that only the second page carries", async () => {
    // The other half of the paging fix, seen from the surface: a candidate past the
    // first page is offered rather than silently absent.
    const { mounted, calls } = await mountOverDefinitions({ pages: TWO_PAGES });

    await typeIntoLine(mounted.line, "/workflow start ");

    expect(calls.listed.map((request) => request.cursor)).toStrictEqual([undefined, "page-1"]);
    expect(candidateNames(mounted)).toStrictEqual(["nightly", "release"]);
  });

  it("completes the line with the definition a person picks", async () => {
    const { mounted } = await mountOverDefinitions({ definitions: [{ name: "nightly" }] });
    await typeIntoLine(mounted.line, "/workflow start ni");
    const [candidate] = mounted.container.querySelectorAll<HTMLButtonElement>(
      ".meridian-workflow-start__candidate-name",
    );
    if (candidate === undefined) {
      throw new Error("the surface offered no candidate to pick");
    }

    await act(async () => {
      fireEvent.click(candidate);
      await crossMacrotaskBoundary();
    });

    // This console's own command, this console's own grammar, and a line the send
    // path accepts — which is what makes completing it different from a provider
    // entry, whose text that path refuses outright.
    expect(mounted.line.value).toBe("/workflow start nightly");
  });

  it("says the search did not finish rather than claiming nothing matches", async () => {
    // An enumeration the page cap cut short answers no question about what is
    // missing, so the definitive empty claim is withheld under it.
    const { mounted } = await mountOverDefinitions({
      pages: [{ definitions: [{ name: "nightly" }] }],
      endless: true,
    });

    await typeIntoLine(mounted.line, "/workflow start zzz-nothing-is-named-this");

    expect(mounted.container.textContent).not.toContain(
      "No workflow this session can start matches",
    );
  });

  it("names the empty result once the walk did finish", async () => {
    const { mounted } = await mountOverDefinitions({ definitions: [{ name: "nightly" }] });

    await typeIntoLine(mounted.line, "/workflow start zzz-nothing-is-named-this");

    expect(mounted.container.textContent).toContain("No workflow this session can start matches");
  });
});
