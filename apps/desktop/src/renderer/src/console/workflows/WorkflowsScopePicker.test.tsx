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
//
// AND A REFUSED DIRECTORY IS TWO ARMS, NOT ONE. A build with no wire is one fact about
// the node; a read that was put and FAILED is another, and the surface's header claims
// the daemon's own code and message reach the screen verbatim on the second. That claim
// is pinned rather than asserted: the rejecting port below wraps the release build's and
// replaces exactly the method under test, so what the cases read is what the seam
// composes — and the control drives the shape that used to render one arm for both.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { WORKFLOWS_SCENARIO } from "../bridge/scenarios/workflows.js";
import { WORKFLOWS_SESSION_ID } from "../bridge/scenarios/workflow-fixture-ids.js";
import { SessionStoreRegistry } from "../store/index.js";
import { WorkflowsScopePicker } from "./WorkflowsScopePicker.js";
import { settle } from "./workflows-probe.test-support.js";

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

function offeredSessionIds(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-choice-list__choice")].map(
    (choice) => choice.textContent ?? "",
  );
}

/** Whether the surface is saying, above its choices, that it is still reading. */
function readingNotices(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll(".meridian-nothing--not-loaded")].map(
    (notice) => notice.textContent ?? "",
  );
}

/** The dotted code a daemon envelope carries, which has to reach the screen. */
const DAEMON_REFUSAL_CODE = "session.list_unavailable";

/** What the daemon's own envelope says, which is what a person reads. */
const DAEMON_REFUSAL_MESSAGE = "The node is not accepting session reads right now.";

/** A real port whose directory read REJECTS, carrying a daemon envelope. */
function rejectingDirectoryPort(): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    sessionList: () =>
      Promise.reject({
        code: -32603,
        message: DAEMON_REFUSAL_MESSAGE,
        data: { type: DAEMON_REFUSAL_CODE },
      }),
  };
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

  it("says it is still reading while offering the sessions it can already name", async () => {
    // The defect: this window holds one session, the node holds six, and while the
    // directory read was in flight the picker rendered a choice list of exactly one
    // with nothing beside it — the prefix presented as the whole answer. A person
    // picks the only session offered and five more arrive a beat later.
    //
    // Unsettled deliberately: the assertion is about the frame BEFORE the read lands,
    // which is the frame a person can act in.
    const container = renderPicker(
      createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }).growth,
      registryHolding(OPEN_SESSION_ID),
    );

    expect(offeredSessionIds(container)).toStrictEqual([OPEN_SESSION_ID]);
    expect(readingNotices(container).join(" ")).toContain("Reading the sessions on this node");

    // And it stops saying so once the node has answered, which is the other half: a
    // notice that outlived its read would report a wait over a settled list.
    await settle();
    expect(readingNotices(container)).toStrictEqual([]);
    expect(offeredSessionIds(container)).toContain(WORKFLOWS_SESSION_ID);
  });

  it("negative control: a served directory offers its choices with no wait notice at all", async () => {
    // Without this, the case above passes for a picker that rendered the wait
    // unconditionally — which would report an unfinished read over the node's own
    // complete list, in every frame, forever.
    const container = renderPicker(
      createFixtureBridge({ scenario: WORKFLOWS_SCENARIO }).growth,
      emptyRegistry(),
    );

    await settle();

    expect(readingNotices(container)).toStrictEqual([]);
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

  it("puts the daemon's own code and message beside the choices, both verbatim", async () => {
    // The header's rule-9 claim, driven. The refusal the surface renders is composed by
    // the reading layer from a rejected read, so the code is the daemon's dotted one and
    // the message is the daemon's sentence — neither restated by the console, and both
    // standing BESIDE this surface's own note about its own list rather than replacing it.
    const container = renderPicker(rejectingDirectoryPort(), registryHolding(OPEN_SESSION_ID));

    await settle();

    expect(offeredSessionIds(container)).toStrictEqual([OPEN_SESSION_ID]);
    expect(refusalCodes(container)).toStrictEqual([DAEMON_REFUSAL_CODE]);
    expect(container.textContent).toContain(DAEMON_REFUSAL_MESSAGE);
    expect(container.textContent).toContain("The node's own list was not read");
  });

  it("negative control: the console never stamps its own code over the daemon's", async () => {
    // The shape this replaces. The directory read once settled through the growth
    // port's own builder, which fixes `call-rejected` and composes a sentence around
    // whatever the other side said — so this surface rendered one code for every daemon
    // failure while its siblings rendered the daemon's, one navigation later.
    const container = renderPicker(rejectingDirectoryPort(), registryHolding(OPEN_SESSION_ID));

    await settle();

    expect(refusalCodes(container)).not.toContain("call-rejected");
    expect(container.textContent).not.toContain("did not answer");
  });

  it("renders a FAILED read as the daemon's failure, not as a console that never asked", async () => {
    // The zero-length arm splits with the same rule. "The console has not asked the
    // node" is true of a build with no wire and false of a read that was put and
    // failed — and the old arm asserted it while printing the refusal that disproves it.
    const container = renderPicker(rejectingDirectoryPort(), emptyRegistry());

    await settle();

    expect(container.querySelector(".meridian-nothing--error")).not.toBeNull();
    expect(container.textContent).toContain(DAEMON_REFUSAL_CODE);
    expect(container.textContent).toContain(DAEMON_REFUSAL_MESSAGE);
    expect(container.textContent).not.toContain("has not asked the node");
  });
});
