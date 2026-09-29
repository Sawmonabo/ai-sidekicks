// The title the session header renders, once a session carries one.
//
// The title is handed to the header as data, so these cases drive it directly and assert the
// header renders it VERBATIM: a surface that renders its absences correctly and its answers
// approximately is the worse of the two bugs, because a wrong title is not visibly wrong.

import { describe, expect, it } from "vitest";

import { SessionHeader } from "./SessionHeader.js";
import { SESSION_ID, renderSessionHeader, storeWith } from "./SessionHeader.test-support.js";

/** How the session names itself, where it does. */
const DISPLAY_TITLE = "Ship the ledger";

describe("the session header — the session it is naming", () => {
  it("renders a display title and says on the element that it is metadata", () => {
    const bar = renderSessionHeader(
      <SessionHeader sessionId={SESSION_ID} sessionStore={storeWith()} title={DISPLAY_TITLE} />,
    );
    const title = bar.querySelector(".meridian-session-header__session-title");

    expect(title?.textContent).toBe(DISPLAY_TITLE);
    // No registered session shape carries a name field, so a reader who wonders where
    // this came from gets the honest answer from the element itself.
    expect(title?.getAttribute("title")).toBe("Session metadata title");
    // And the id is still there: the title is an addition to the identity, never a
    // replacement for the one unambiguous name the session has.
    expect(bar.querySelector(".meridian-session-header__identity")?.textContent).toContain(
      SESSION_ID,
    );
  });

  it("negative control: a session with no title renders none rather than a placeholder", () => {
    // Without this the case above would pass over a header that drew a "not named" badge
    // for every untitled session — which is most of them, and which would report a
    // missing answer where the answer is that this session has no name.
    const bar = renderSessionHeader(
      <SessionHeader sessionId={SESSION_ID} sessionStore={storeWith()} />,
    );

    expect(bar.querySelector(".meridian-session-header__session-title")).toBeNull();
    expect(bar.textContent).not.toContain(DISPLAY_TITLE);
  });
});
