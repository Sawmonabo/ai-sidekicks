// What the session header renders before any read has answered: the session's own id,
// and the shape it holds while the session opens.
//
// The readings the header puts are `CastBar.readings.test.tsx`; what it must NOT say
// when nothing answered is `CastBar.absence.test.tsx`.

import { describe, expect, it } from "vitest";

import { CastBar } from "./CastBar.js";
import { SESSION_ID, renderBar, storeWith } from "./CastBar.test-support.js";

describe("CastBar — the session's identity", () => {
  it("renders the id wire-verbatim rather than a title nothing carries", () => {
    const bar = renderBar(<CastBar sessionId={SESSION_ID} sessionStore={storeWith()} />);
    expect(bar.querySelector(".meridian-cast-bar__identity")?.textContent).toContain(SESSION_ID);
  });

  it("says the session is opening, and holds the header's height while it does", () => {
    const bar = renderBar(<CastBar sessionId={SESSION_ID} sessionStore={undefined} />);
    expect(bar.textContent).toContain("This session is opening.");
    // The placeholder is the height the readings will be, so nothing below the header
    // moves at the instant a person is reaching for something.
    expect(bar.querySelectorAll(".meridian-cast-bar__placeholder")).toHaveLength(1);
    // And it says nothing: a screenshot of a session mid-open cannot be read as a
    // session that has been measured.
    expect(bar.querySelector(".meridian-cast-bar__placeholder")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("negative control: an open session draws no placeholder at all", () => {
    // Without this the case above would pass over a header that drew the placeholder
    // for the life of the session, which is a shape standing in for a reading that has
    // already landed beside it.
    const bar = renderBar(<CastBar sessionId={SESSION_ID} sessionStore={storeWith()} />);
    expect(bar.querySelectorAll(".meridian-cast-bar__placeholder")).toHaveLength(0);
    expect(bar.textContent).not.toContain("This session is opening.");
  });

  it("renders an absence rather than an identity on a route that names no session", () => {
    const bar = renderBar(<CastBar sessionId={undefined} sessionStore={undefined} />);
    expect(bar.querySelector(".meridian-cast-bar__identity")?.textContent).toContain("No session");
  });
});
