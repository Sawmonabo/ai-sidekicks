// What the auxiliary picker says when it can offer nothing, and why it says it.
//
// The picker holds two sources — the node's directory and this window's open sessions
// — and their union is what it offers. With an empty window and a refused directory
// there is nothing to offer at all, and the block it draws then is a claim about the
// node: either the console did not ask, or it asked and the asking failed. Those are
// different facts and used to render as one, under a sentence asserting the first
// while the second's own refusal was appended to it.
//
// THE PORT IS REAL IN EVERY CASE. The refusing one is the release build's, and the
// rejecting one wraps it and replaces exactly the method under test — the fail-closed
// channel a promise carries whether the contract uses it or not. Nothing here writes a
// refusal by hand: what is asserted is what the seam produces.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GrowthPort } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port/growth-port.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import { SessionStoreRegistry } from "../store/index.js";
import { ContextPicker } from "./ContextPicker.js";

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

/** A registry holding nothing, so the picker's other source offers nothing either. */
function emptyRegistry(): SessionStoreRegistry {
  return new SessionStoreRegistry({ read: () => Promise.resolve(undefined) });
}

async function renderPicker(growth: GrowthPort): Promise<void> {
  render(
    <ContextPicker
      route="timeline"
      registry={emptyRegistry()}
      growth={growth}
      onChoose={() => {
        throw new Error("nothing is offerable, so nothing can be chosen");
      }}
    />,
  );
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/**
 * The `not-checked` badge's own sentence, or `undefined` where no badge is on screen.
 *
 * The inline shape carries its second line as the label's `title` rather than as text,
 * so a text query would report the sentence absent on the arm that renders it — which
 * would make the control below pass for the wrong reason.
 */
function notAskedSentence(): string | undefined {
  return (
    document.querySelector(".meridian-nothing__badge-label")?.getAttribute("title") ?? undefined
  );
}

describe("ContextPicker — the absence names which kind of nothing it is", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the daemon's own code and sentence when the directory read failed", async () => {
    await renderPicker(rejectingDirectoryPort());

    expect(screen.getByText(DAEMON_REFUSAL_CODE)).toBeTruthy();
    expect(screen.getByText(DAEMON_REFUSAL_MESSAGE)).toBeTruthy();
  });

  it("negative control: a failed read never claims the console did not ask", async () => {
    // The conflation this replaces: the failed arm rendered the `not-checked` badge,
    // whose sentence says the console has not asked the node — with the refusal
    // proving that it had appended to the same string.
    await renderPicker(rejectingDirectoryPort());

    expect(notAskedSentence()).toBeUndefined();
  });

  it("says the console did not ask when no wire is registered for the read", async () => {
    // The release build's own path, and the one the sentence is true of. The sentence
    // is read off the badge's `title`, which is where the inline shape carries a
    // second line — the honest limit of that shape rather than a missing render.
    await renderPicker(createRefusingGrowthPort());

    expect(screen.getByText("This window has no session open.")).toBeTruthy();
    expect(notAskedSentence()).toContain("has not asked the node");
  });
});
