// A refusal card mounts already holding its words, so it speaks them through the app's announcer:
// the code's words, then the message, and never the action beside them.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "../LiveAnnouncer/LiveAnnouncerProvider.js";
import { liveRegionText } from "#test/helpers/live-region.js";
import { RefusalCard } from "./RefusalCard.js";

describe("RefusalCard — what a screen reader is told", () => {
  it("says the code's words and the message on the assertive lane, not the action", () => {
    const { container } = render(
      <RefusalCard
        code="agent.resolution_refused"
        reason="account_unavailable"
        detail="The account this sidekick runs on is not on this machine."
        action={<button type="button">Try again</button>}
      />,
      { wrapper: LiveAnnouncerProvider },
    );

    expect(liveRegionText(container, "assertive")).toBe(
      "Sidekick resolution refused · Account unavailable. " +
        "The account this sidekick runs on is not on this machine.",
    );
  });
});
