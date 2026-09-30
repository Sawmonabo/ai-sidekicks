// What the session header renders before any read has answered: the session's id, and the shape
// it holds while the session opens. Titles are in `SessionHeader.readings.test.tsx`.

import { describe, expect, it } from "vitest";

import { SessionHeader } from "./SessionHeader.js";
import { SESSION_ID, renderSessionHeader, storeWith } from "./SessionHeader.test-support.js";

describe("SessionHeader — the session's identity", () => {
  it("renders the id wire-verbatim rather than a title nothing carries", () => {
    const bar = renderSessionHeader(
      <SessionHeader sessionId={SESSION_ID} sessionStore={storeWith()} />,
    );
    expect(bar.querySelector(".meridian-session-header__identity")?.textContent).toContain(
      SESSION_ID,
    );
  });

  it("says the session is opening, and holds the header's height while it does", () => {
    const bar = renderSessionHeader(
      <SessionHeader sessionId={SESSION_ID} sessionStore={undefined} />,
    );
    expect(bar.textContent).toContain("This session is opening.");
    // The placeholder holds the header's height so nothing below it moves.
    expect(bar.querySelectorAll(".meridian-session-header__placeholder")).toHaveLength(1);
    // It is hidden from assistive technology: it is a shape, not a reading.
    expect(
      bar.querySelector(".meridian-session-header__placeholder")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("negative control: an open session draws no placeholder at all", () => {
    // The case above would also pass over a header that kept the placeholder forever.
    const bar = renderSessionHeader(
      <SessionHeader sessionId={SESSION_ID} sessionStore={storeWith()} />,
    );
    expect(bar.querySelectorAll(".meridian-session-header__placeholder")).toHaveLength(0);
    expect(bar.textContent).not.toContain("This session is opening.");
  });

  it("renders an absence rather than an identity on a route that names no session", () => {
    const bar = renderSessionHeader(
      <SessionHeader sessionId={undefined} sessionStore={undefined} />,
    );
    expect(bar.querySelector(".meridian-session-header__identity")?.textContent).toContain(
      "No session",
    );
  });
});
