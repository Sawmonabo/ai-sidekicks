// The picker offers what it has, and says what it could not read.
//
// Every case drives the REAL growth port — the fixture's for a directory that answers,
// the live bridge's refusing one for a directory that cannot — and the real session
// registry, because the defect this suite pins is a union of two sources and a
// stand-in for either would have agreed with whatever the component did with it.
//
// THE REFUSING PORT IS THE RELEASE BUILD, not a corner. `createRefusingGrowthPort`
// refuses `sessionList` by name because no wire answers it yet, so the refused arm
// below is what an operator meets today on every build that is not the fixture.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { WORKFLOWS_SCENARIO } from "../bridge/scenarios/workflows.js";
import { WORKFLOWS_SESSION_ID } from "../bridge/scenarios/workflow-fixture-ids.js";
import { SessionStoreRegistry } from "../store/index.js";
import { WorkflowsScopePicker } from "./WorkflowsScopePicker.js";

const OPEN_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

/** A registry with nothing open and a reader that answers nothing. */
function emptyRegistry(): SessionStoreRegistry {
  return new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
}

/**
 * A registry holding one open session, opened rather than written.
 *
 * `open` is the registry's own seam and is idempotent, so this is the same entry the
 * window would hold — a test that set the map directly would pass over a registry that
 * had stopped recording what it opens.
 */
function registryHolding(sessionId: string): SessionStoreRegistry {
  const registry = emptyRegistry();
  registry.open(sessionId);
  return registry;
}

function renderPicker(growth: GrowthPort, registry: SessionStoreRegistry): HTMLElement {
  return render(
    <WorkflowsScopePicker growth={growth} registry={registry} onChoose={() => undefined} />,
  ).container;
}

/** Let the directory read settle, so an assertion is about an answer and not a wait. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function offeredSessionIds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-choice-list__choice")].map(
    (choice) => choice.textContent ?? "",
  );
}

function refusalCodes(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-refusal .meridian-figure--wire")].map(
    (code) => code.textContent ?? "",
  );
}

describe("the workflows scope picker — a refused directory beside a usable choice", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the sessions this window holds and renders the refusal beside them", async () => {
    // The defect: with the node directory refused and one session open, the union still
    // returned that session, the zero-length refusal branch was skipped, and the picker
    // presented the one session as though it were the complete node list.
    const container = renderPicker(createRefusingGrowthPort(), registryHolding(OPEN_SESSION_ID));

    await settle();

    expect(offeredSessionIds(container)).toStrictEqual([OPEN_SESSION_ID]);
    expect(refusalCodes(container)).toStrictEqual(["wire-unregistered"]);
    // The console's own sentence about its own list, beside the daemon's rather than
    // instead of it: neither the code nor the message says which sessions were offered.
    expect(container.textContent).toContain("The node's own list was not read");
  });

  it("negative control: a served directory offers its sessions with no refusal at all", async () => {
    // Without this, the case above passes for a picker that rendered the refusal
    // unconditionally — which would report a failed read over a list the node answered.
    const container = renderPicker(
      createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }).growth,
      emptyRegistry(),
    );

    await settle();

    expect(refusalCodes(container)).toStrictEqual([]);
    expect(offeredSessionIds(container)).toContain(WORKFLOWS_SESSION_ID);
  });

  it("negative control: a refused directory with nothing open still says nobody asked", async () => {
    // The zero-length arm is a different claim and keeps it: no choice can be offered,
    // so the surface reports that the node was never asked rather than offering a list
    // with a refusal attached to it.
    const container = renderPicker(createRefusingGrowthPort(), emptyRegistry());

    await settle();

    expect(offeredSessionIds(container)).toStrictEqual([]);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });
});
