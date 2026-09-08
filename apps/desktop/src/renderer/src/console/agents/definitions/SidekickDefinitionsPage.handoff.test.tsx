// Attaching from a saved row: what the press offers, and what the page says about it.
//
// THE PAGE MAKES A PROMISE AND HAS TO KEEP IT LEGIBLE. Pressing "Attach from here"
// sends nothing and navigates nowhere — it offers this definition to the session this
// window is working in, and the session's own attach form picks it up. A row that
// showed no sign of having done that would look like a control that did nothing, and
// a row that went on showing it after the form had claimed the offer would be
// reporting a promise the console had already kept.
//
// AND WITHOUT A SESSION THERE IS NO ACT. An agent joins a session; a window that has
// opened none has nothing to attach into. The control is ABSENT rather than disabled,
// and the column says why once rather than every row saying it.
//
// AN OFFER IS FOR ONE SESSION, AND THE ROW HAS TO AGREE WITH THE CLAIM ABOUT WHICH.
// The handoff honours an offer only for the session it names, so a page that matched
// on the definition alone would hide this window's own action and report the offer as
// waiting in a session it was never made for — reachable by offering for one session,
// moving the window to another, and reopening this page before the first session's
// attach form has claimed it. The cases below drive exactly that.
//
// The page's other properties are its two sibling suites; the registry, the announcer,
// and the presses come from the support module all three share.

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../bridge/index.js";
import { attachHandoffFor } from "../attach/attach-handoff/attach-handoff.js";
import {
  RegistryStub,
  buttonNamed,
  definition,
  press,
  renderPage,
  savedRegionOf,
  served,
  settle,
} from "./sidekick-definitions-page.test-support.js";

/** The session a window that has one is working in. */
const SESSION_ID = "session-9";

/** A second session, which the window is NOT working in. */
const OTHER_SESSION_ID = "session-4";

/** A registry answering with one row, and the bridge that serves it. */
function registryBridge(): ConsoleBridge {
  return new RegistryStub({ lists: [served([definition()])] }).bridge();
}

describe("the sidekicks page — offering a definition to this window's session", () => {
  it("offers the row's definition to the session, by its id and not its name", async () => {
    const bridge = registryBridge();
    const { container } = renderPage(bridge, SESSION_ID);
    await settle();

    await press(buttonNamed(container, "Attach Reviewer from here"));

    expect(attachHandoffFor(bridge).standingOffer).toEqual({
      sessionId: SESSION_ID,
      definitionId: "definition-1",
      definitionName: "Reviewer",
    });
  });

  it("says where the offer is waiting, and replaces the action with a way back", async () => {
    const bridge = registryBridge();
    const { container } = renderPage(bridge, SESSION_ID);
    await settle();

    await press(buttonNamed(container, "Attach Reviewer from here"));

    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").toContain("Waiting in");
    expect(saved.textContent ?? "").toContain(SESSION_ID);
    expect(buttonNamed(container, "Stop attaching Reviewer")).not.toBeUndefined();
    expect(saved.querySelector('[aria-label="Attach Reviewer from here"]')).toBeNull();
  });

  it("takes the offer back on the second press", async () => {
    const bridge = registryBridge();
    const { container } = renderPage(bridge, SESSION_ID);
    await settle();

    await press(buttonNamed(container, "Attach Reviewer from here"));
    await press(buttonNamed(container, "Stop attaching Reviewer"));

    expect(attachHandoffFor(bridge).standingOffer).toBeUndefined();
    expect(buttonNamed(container, "Attach Reviewer from here")).not.toBeUndefined();
  });

  it("stops reading as a standing promise once the session's form has claimed it", async () => {
    const bridge = registryBridge();
    const { container } = renderPage(bridge, SESSION_ID);
    await settle();
    await press(buttonNamed(container, "Attach Reviewer from here"));

    // What the session's attach form does when it opens, driven through the handoff
    // itself rather than through this page's own control: the property is that the row
    // hears about a change it did not make. A page that read the offer once would go
    // on promising an attach that had already happened.
    //
    // A SYNCHRONOUS `act` because the claim is synchronous: it publishes on the
    // emitter inside this call, and the wrapper is here to flush the render that
    // publication schedules rather than to wait for anything.
    act(() => {
      attachHandoffFor(bridge).claim(SESSION_ID);
    });

    expect(savedRegionOf(container).textContent ?? "").not.toContain("Waiting in");
    expect(buttonNamed(container, "Attach Reviewer from here")).not.toBeUndefined();
  });

  it("negative control: a window with no session open offers no attach action at all", async () => {
    // Absent, never disabled: a disabled control asserts the act exists and is
    // momentarily unavailable, and with no session there is no act to offer.
    const { container } = renderPage(registryBridge());
    await settle();

    const saved = savedRegionOf(container);
    expect(saved.querySelector('[aria-label="Attach Reviewer from here"]')).toBeNull();
    expect(saved.querySelector("[disabled]")).toBeNull();
  });

  it("says once why the action is missing, rather than once per row", async () => {
    const { container } = renderPage(
      new RegistryStub({
        lists: [
          served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
        ],
      }).bridge(),
    );
    await settle();

    expect(container.querySelectorAll(".meridian-sidekicks__attach-note").length).toBe(1);
  });

  it("negative control: a window that has a session is told nothing about not having one", async () => {
    const { container } = renderPage(registryBridge(), SESSION_ID);
    await settle();

    expect(container.querySelector(".meridian-sidekicks__attach-note")).toBeNull();
  });
});

describe("the sidekicks page — an offer standing for a session this window is not in", () => {
  /**
   * A window whose handoff already holds an offer for {@link OTHER_SESSION_ID}.
   *
   * Placed on the handoff directly rather than by rendering the page twice, which is
   * this suite's established shape for the other end of the same seam: what is being
   * driven is a window that MOVED, and the offer is the only thing that survives the
   * move.
   */
  async function pageOverAnOfferMadeElsewhere(): Promise<{
    readonly bridge: ConsoleBridge;
    readonly container: HTMLElement;
  }> {
    const bridge = registryBridge();
    attachHandoffFor(bridge).offer({
      sessionId: OTHER_SESSION_ID,
      definitionId: "definition-1",
      definitionName: "Reviewer",
    });
    const { container } = renderPage(bridge, SESSION_ID);
    await settle();
    return { bridge, container };
  }

  it("names the session the offer was actually made for, not the one the window is in", async () => {
    const { container } = await pageOverAnOfferMadeElsewhere();

    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").toContain("Waiting in");
    expect(saved.textContent ?? "").toContain(OTHER_SESSION_ID);
    expect(saved.textContent ?? "").not.toContain(`Waiting in ${SESSION_ID}`);
  });

  it("still offers this window's own session, because the offer is not its offer", async () => {
    const { container } = await pageOverAnOfferMadeElsewhere();

    // The row keeps the way back, because the offer is real and withdrawable from
    // here — and it keeps its own action, because one press would make this session's
    // offer instead.
    expect(buttonNamed(container, "Stop attaching Reviewer")).not.toBeUndefined();
    expect(
      savedRegionOf(container).querySelector(
        `[aria-label="Attach Reviewer from here, moving the offer waiting in ${OTHER_SESSION_ID}"]`,
      ),
    ).not.toBeNull();
  });

  it("says out loud that pressing it would displace the standing offer", async () => {
    const { container } = await pageOverAnOfferMadeElsewhere();

    // Both registers, because DOM order puts the note after the control: the prose for
    // a person reading the card, the accessible name for one who reaches the control by
    // tab and would otherwise meet the consequence after the press.
    expect(savedRegionOf(container).textContent ?? "").toContain(
      "this window holds one offer at a time",
    );
    expect(
      buttonNamed(
        container,
        `Attach Reviewer from here, moving the offer waiting in ${OTHER_SESSION_ID}`,
      ),
    ).not.toBeUndefined();
  });

  it("supersedes the standing offer with this window's session on the press", async () => {
    const { bridge, container } = await pageOverAnOfferMadeElsewhere();

    await press(
      buttonNamed(
        container,
        `Attach Reviewer from here, moving the offer waiting in ${OTHER_SESSION_ID}`,
      ),
    );

    expect(attachHandoffFor(bridge).standingOffer).toEqual({
      sessionId: SESSION_ID,
      definitionId: "definition-1",
      definitionName: "Reviewer",
    });
    expect(savedRegionOf(container).textContent ?? "").toContain(SESSION_ID);
    expect(savedRegionOf(container).textContent ?? "").not.toContain(
      "this window holds one offer at a time",
    );
  });

  it("negative control: an offer for another definition claims no row at all", async () => {
    const bridge = registryBridge();
    attachHandoffFor(bridge).offer({
      sessionId: SESSION_ID,
      definitionId: "definition-elsewhere",
      definitionName: "Auditor",
    });
    const { container } = renderPage(bridge, SESSION_ID);
    await settle();

    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").not.toContain("Waiting in");
    expect(buttonNamed(container, "Attach Reviewer from here")).not.toBeUndefined();
  });

  it("keeps the way back on a row whose window has no session of its own", async () => {
    // The offer is still real, so withdrawing it is still an act — and there is no
    // session to offer it to from here, so nothing says a press would move it.
    const bridge = registryBridge();
    attachHandoffFor(bridge).offer({
      sessionId: OTHER_SESSION_ID,
      definitionId: "definition-1",
      definitionName: "Reviewer",
    });
    const { container } = renderPage(bridge);
    await settle();

    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").toContain(OTHER_SESSION_ID);
    expect(buttonNamed(container, "Stop attaching Reviewer")).not.toBeUndefined();
    expect(saved.querySelector('[aria-label^="Attach Reviewer from here"]')).toBeNull();
    expect(saved.textContent ?? "").not.toContain("this window holds one offer at a time");
  });
});
