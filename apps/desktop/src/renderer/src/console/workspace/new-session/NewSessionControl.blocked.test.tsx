// Send while the destination is not putting acts.
//
// Split from the two suites next door, which are about the acts being reachable and
// about which composition a settlement lands in. Every case here is about the one
// state in which the composed draft must NOT reach the wire: the shell cannot be
// written to, so `session.create` is a call this window has no business putting.
//
// TWO HALVES, AND THE SECOND IS THE ONE THAT WAS MISSING. Disabling the button is the
// affordance; refusing at the dispatch site is the guard. They are not the same claim,
// because a block can land in the frame between the render that enabled Send and the
// press that reaches its handler — so the second describe drives a control that was
// rendered UNBLOCKED and whose destination has since said no.

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { NewSessionBlockedAct } from "../../seats/index.js";
import {
  bridgeFor,
  blockedActSaying,
  openDraftWithPosture,
  press,
  renderControlOn,
} from "./NewSessionControl.test-support.js";

/** The sentence a stopped supervisor puts on every act this destination offers. */
const STOPPED_SHELL_SENTENCE =
  "The local runtime has been stopped. Everything on screen is the last state this window was sent; starting it again is a shell action, never a call.";

describe("the composed new-session draft — while the destination is not putting acts", () => {
  afterEach(cleanup);

  it("closes Send and carries the destination's own cause", async () => {
    // The defect: this control took the bridge and nothing else, so it stayed live
    // through a stopped supervisor while the start, join and import controls beside it
    // were all disabled with the cause named — the one affordance still inviting a
    // write the window could not put.
    renderControlOn(
      bridgeFor({ scriptsCreate: true }),
      () => undefined,
      () => undefined,
      blockedActSaying(STOPPED_SHELL_SENTENCE),
    );
    await openDraftWithPosture();

    const send = screen.getByRole("button", { name: "Send" });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(send.getAttribute("title")).toBe(STOPPED_SHELL_SENTENCE);
  });

  it("still opens a draft, because composing one puts nothing on any wire", async () => {
    // The block closes the SEND and not the composition: a draft mints no daemon row,
    // and refusing to let somebody write one while the runtime is away would take the
    // offline half of this control away for nothing.
    renderControlOn(
      bridgeFor({ scriptsCreate: true }),
      () => undefined,
      () => undefined,
      blockedActSaying(STOPPED_SHELL_SENTENCE),
    );

    await press("+ New");

    expect(screen.getByRole("group", { name: "How its agents may work" })).toBeDefined();
  });

  it("negative control: a send dispatched on a control rendered UNBLOCKED puts nothing", async () => {
    // The dispatch-time half. The reading answers `undefined` for the render that drew
    // the button and the block for every read after it, which is exactly the frame a
    // press can land in — and a guard that consulted only the render snapshot would
    // send `session.create` into a runtime this window cannot reach.
    let blocked = false;
    const lateBlock: NewSessionBlockedAct = {
      sentence: undefined,
      readSentence: () => (blocked ? STOPPED_SHELL_SENTENCE : undefined),
    };
    const container = renderControlOn(
      bridgeFor({ scriptsCreate: true }),
      () => undefined,
      () => undefined,
      lateBlock,
    );

    await openDraftWithPosture();
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    blocked = true;
    await press("Send");

    // Nothing reached the wire, so there is no settlement to render and no sentence to
    // say: the cause is already on screen beside the control, and a sending flag set
    // here would have left a spinner nothing settles.
    expect(container.textContent).not.toContain("first-turn-missing");
    expect(container.textContent).not.toContain("Already sent");
    // And the draft is untouched — still composed, still sendable the moment the
    // runtime is back.
    expect(container.querySelector(".meridian-new-session")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });
});
