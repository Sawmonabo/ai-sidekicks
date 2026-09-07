// The browser family's row in the composer's `+` menu.
//
// `Spec-023 §Console Design (Meridian)` 12.1 names three open paths that do not begin
// in the deck's own pane gallery, and this is the one a person reaches from the
// composer: attach the page a browser pane is showing to the conversation they are
// writing in. The other two — detaching the view, and revealing a page's local file —
// are the pane's own controls, and the timeline's path-link affordance is a third that
// belongs to the family that renders timeline rows.
//
// WHAT MAKES THIS ONE ENTRY AND NOT A CONTROL. The composer is a sibling view family,
// so this cannot be a component the browser hands it. It is a descriptor registered
// into `seats/composer-attach-menu.ts`, and the composer renders whatever rows it
// finds — which is the same shape the pane registry and the surface registry take.
//
// AND IT IS DELIBERATELY NOT ON THE FAMILY DOOR. Publishing it there would offer an
// import to exactly one reader that may not take it: a door line exists for a
// production consumer, the only consumer this descriptor has is the composer, and a
// sibling view family reaching through this door fails the isolation rule. The
// registration below is the whole handoff.
//
// FAIL-CLOSED ON THE ONE THING THE RENDERER CAN CHECK. The entry needs a pane to
// attach for, and whether one is focused is a fact about this window rather than an
// authority: it is read from the context and refused by name when it is missing. Every
// other reason an attach can fail is the daemon's, and those come back as the wire's
// own refusal rather than as a control this window hid.

import type { ComposerAttachMenuEntry, ComposerAttachOutcome } from "../../seats/index.js";
import { normalizeWireRejection, refuse } from "../../core/index.js";
import type { BrowserPaneRejectionFallback } from "./pane-refusals.js";

/** The subsystem name the entry's own refusals carry. */
const ATTACH_ENTRY_REFUSAL_ORIGIN = "browser-attach-entry";

/** What an attach that never answered says, where the rejection carries no code. */
const ATTACH_CALL_FALLBACK: BrowserPaneRejectionFallback = {
  code: "pane-attach-failed",
  detail: "The page could not be attached, because the call into the browser never answered.",
};

/**
 * Attach the focused browser pane's page to the conversation.
 *
 * Exported as one value rather than a factory: it holds no state, it reads everything
 * it needs off the context it is handed, and a factory would invite a second entry
 * with different defaults for a menu that admits exactly one row per id.
 */
export const browserAttachMenuEntry: ComposerAttachMenuEntry = {
  id: "browser.attach-page",
  owner: "browser",
  label: "Attach page",
  glyph: "browser",
  detail: "Attach the page the focused browser pane is showing to this conversation.",
  attach: async (context): Promise<ComposerAttachOutcome> => {
    // SOME pane is focused, which is all the context can report: `focusedPaneId` is a
    // handle and carries no kind, so this entry cannot tell a browser pane from a
    // timeline one and does not try. A dispatch against the wrong kind is refused by
    // the daemon, whose page registry is the authority on which panes hold pages.
    const paneId = context.focusedPaneId;
    if (paneId === undefined) {
      return {
        status: "refused",
        refusal: refuse(
          ATTACH_ENTRY_REFUSAL_ORIGIN,
          "no-focused-pane",
          "There is no focused pane to attach a page from. Open a browser pane and select it first.",
        ),
      };
    }
    try {
      const outcome = await context.bridge.growth.browserPaneAttach({ paneId });
      if (outcome.status === "unavailable") {
        return { status: "refused", refusal: outcome };
      }
      return { status: "attached" };
    } catch (failure) {
      return {
        status: "refused",
        refusal: normalizeWireRejection(ATTACH_ENTRY_REFUSAL_ORIGIN, failure, ATTACH_CALL_FALLBACK),
      };
    }
  },
};
