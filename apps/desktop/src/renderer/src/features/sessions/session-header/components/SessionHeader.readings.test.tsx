// The title the session header renders once a session carries one. It is handed in as data, and
// asserted verbatim, since a wrong title is not visibly wrong.

import { describe, expect, it } from "vitest";

import { SessionHeader } from "./SessionHeader.js";
import { SESSION_ID, renderSessionHeader, storeWith } from "./SessionHeader.test-support.js";

/** How the session names itself, where it does. */
const DISPLAY_TITLE = "Ship the transcript";

describe("the session header — the session it is naming", () => {
  it("renders the session's name", () => {
    const bar = renderSessionHeader(
      <SessionHeader sessionId={SESSION_ID} sessionStore={storeWith()} title={DISPLAY_TITLE} />,
    );
    const title = bar.querySelector(".meridian-session-header__session-title");

    expect(title?.textContent).toBe(DISPLAY_TITLE);
    // The id stays: the title adds to the identity and never replaces it.
    expect(bar.querySelector(".meridian-session-header__identity")?.textContent).toContain(
      SESSION_ID,
    );
  });

  it("negative control: a session with no title renders none rather than a placeholder", () => {
    // The case above would also pass over a header that drew a "not named" badge, reporting a
    // missing answer where the answer is that the session has no name.
    const bar = renderSessionHeader(
      <SessionHeader sessionId={SESSION_ID} sessionStore={storeWith()} />,
    );

    expect(bar.querySelector(".meridian-session-header__session-title")).toBeNull();
    expect(bar.textContent).not.toContain(DISPLAY_TITLE);
  });
});
