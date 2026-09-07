// The seat a settings page mounts, and what stands in for a body nobody has written.
//
// FOUR CASES OVER ONE BRANCH, and each is the other's negative control: a renderer
// that reserved unconditionally would swallow a body on the day it lands, one that
// rendered the body unconditionally would crash on a seat that has none, one that
// printed the seat's contract would put a governance identifier on a participant's
// screen, and one that produced nothing at all would satisfy every `not.toContain`
// there is.
//
// The context is the narrowest thing that satisfies the page contract. Nothing here
// reads a wire — the branch under test is `body === undefined` — so a bridge would be
// a dependency the claim does not have.

import { describe, expect, it } from "vitest";

import { renderOwnerSlotPage, type OwnerSlotPage } from "./owner-slot-page.js";
import type { SettingsPageContext } from "./settings-page-registry.js";
import { UNREPORTED_SHELL_STATE } from "../store/index.js";

describe("a settings page whose body another plan authors", () => {
  const CONTEXT = {
    bridge: undefined as never,
    openSection: () => undefined,
    retainedSessionId: undefined,
    retainedSessionStore: undefined,
    shellState: UNREPORTED_SHELL_STATE,
    selection: undefined,
  } satisfies SettingsPageContext;

  const RESERVED: OwnerSlotPage = {
    slot: {
      contract: {
        owningTask: "Plan-999 (the registry test's own seat)",
        mountObligation: "the page frame and the page context",
        deleteShellIn: "the task that fills this slot",
      },
      body: undefined,
    },
    reservationTitle: "The example page has not been built here yet.",
    reservationDetail: "It will hold what the owning plan authors. Nothing has been asked for it.",
  };

  const FILLED: OwnerSlotPage = {
    ...RESERVED,
    slot: { contract: RESERVED.slot.contract, body: () => "the body rendered" },
  };

  it("renders the reservation while nobody has filled the seat", () => {
    const rendered = renderOwnerSlotPage(RESERVED, CONTEXT);
    expect(rendered).not.toBeNull();
    expect(rendered).toBeDefined();
    expect(JSON.stringify(rendered)).toContain("has not been built here yet");
  });

  it("negative control: a filled seat renders its body instead", () => {
    // Without this, the case above would pass over a renderer that ignored the seat
    // and reserved unconditionally — which is the renderer that will silently
    // swallow the body on the day it lands.
    expect(renderOwnerSlotPage(FILLED, CONTEXT)).toBe("the body rendered");
  });

  it("puts none of the seat's contract on screen", () => {
    // A slot contract is developer-facing and reaches no screen. The rule is
    // repository-wide: governance identifiers live in comments, never in a string
    // a participant reads.
    const rendered = JSON.stringify(renderOwnerSlotPage(RESERVED, CONTEXT));
    expect(rendered).not.toContain(RESERVED.slot.contract.owningTask);
    expect(rendered).not.toContain(RESERVED.slot.contract.deleteShellIn);
    expect(rendered).not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("negative control: the reservation does render text that could have carried it", () => {
    // Without this, the case above would pass over a renderer that produced nothing
    // at all, which is indistinguishable to `toContain` from one that stayed quiet.
    expect(JSON.stringify(renderOwnerSlotPage(RESERVED, CONTEXT)).length).toBeGreaterThan(80);
  });
});
