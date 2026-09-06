// Which kind of nothing the sessions destination draws, per reason it has none.
//
// Four arms and four different claims about the node, so the cases drive all four and
// the two REFUSED ones are what this file exists for: a read nobody put and a read
// that failed used to render as the same block, under a sentence saying the console
// had not asked. That is true of exactly one of them, and false of the other in the
// way that matters most — a closed channel reported as an idle console.
//
// EVERY REFUSAL HERE COMES FROM A REAL SEAM. The unbuilt-wire one is the growth port's
// own, minted by the builder the live bridge calls; the failed one is what
// `settleGrowthRead` answers for a rejected read, which is the value the hook actually
// publishes. A refusal written out as a literal here would assert this component's
// behaviour against a shape nothing produces.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { SettledReadRefusal } from "../bridge/index.js";
import { growthUnavailable } from "../bridge/growth-port/growth-port.js";
import { settleGrowthRead } from "../bridge/readings/read-settlement.js";
import type { SessionDirectoryState } from "../seats/index.js";
import { SessionsAbsence } from "./SessionsAbsence.js";

/** The dotted code a daemon envelope carries, which has to reach the screen. */
const DAEMON_REFUSAL_CODE = "session.list_unavailable";

/** What the daemon's own envelope says, which is what a person reads. */
const DAEMON_REFUSAL_MESSAGE = "The node is not accepting session reads right now.";

/** The refusal a read that FAILED settles to, through the seam that settles it. */
async function failedDirectoryRefusal(): Promise<SettledReadRefusal> {
  const settlement = await settleGrowthRead<never>(
    Promise.reject({
      code: -32603,
      message: DAEMON_REFUSAL_MESSAGE,
      data: { type: DAEMON_REFUSAL_CODE },
    }),
  );
  return settlement;
}

/** The refusal a build with no wire for the read answers with. */
function unbuiltWireDirectoryRefusal(): SettledReadRefusal {
  return growthUnavailable("sessionList");
}

function renderAbsence(directory: SessionDirectoryState): void {
  render(<SessionsAbsence directory={directory} action={<button type="button">Start</button>} />);
}

describe("SessionsAbsence — one absence per reason there is none", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the daemon's own code and sentence when the read failed", async () => {
    renderAbsence({ status: "unavailable", refusal: await failedDirectoryRefusal() });

    // Both verbatim: rule 9 fixes what reaches the screen from a refusal at the code
    // and the message, and neither is paraphrased on the way.
    expect(screen.getByText(DAEMON_REFUSAL_CODE)).toBeTruthy();
    expect(screen.getByText(DAEMON_REFUSAL_MESSAGE)).toBeTruthy();
  });

  it("negative control: a failed read never claims the console did not ask", async () => {
    // The defect this replaces, driven rather than described. The failed arm used to
    // render the `not-checked` block, whose sentence asserts that the console has not
    // asked the daemon — a claim contradicted by the refusal printed beside it.
    renderAbsence({ status: "unavailable", refusal: await failedDirectoryRefusal() });

    expect(screen.queryByText(/has not asked the daemon/u)).toBeNull();
    expect(screen.queryByText(/No session is open in this window\./u)).toBeNull();
  });

  it("says the console did not ask when no wire is registered for the read", () => {
    // The arm the sentence is TRUE of, and the release build's own path: the live
    // bridge refuses `sessionList` by name, so nothing was asked and nothing may be
    // reported about what the node holds.
    renderAbsence({ status: "unavailable", refusal: unbuiltWireDirectoryRefusal() });

    expect(screen.getByText("No session is open in this window.")).toBeTruthy();
    expect(screen.getByText(/has not asked the daemon/u)).toBeTruthy();
  });

  it("says the node answered and has none when the read was served empty", () => {
    renderAbsence({ status: "served", sessions: [] });

    expect(screen.getByText("There are no sessions on this node yet.")).toBeTruthy();
  });

  it("says nothing about the node while the read is in flight", () => {
    renderAbsence({ status: "reading" });

    expect(screen.getByText("Reading the sessions on this node.")).toBeTruthy();
    expect(screen.queryByText(/no sessions on this node/u)).toBeNull();
  });
});
