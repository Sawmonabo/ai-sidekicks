// An in-flight attachment card drawn in Chromium: the words between its figures, `declared` before
// the sender's media type and `of` between the byte counts, are drawn muted, and the figures they
// sit between keep the line's ink, the negative control for a card drawn muted as a whole.

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { AttachmentCard } from "#renderer/features/composer/attachments/components/AttachmentCard.js";
import { sendingEntry } from "#renderer/features/composer/attachments/ingest-entry.test-support.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

afterEach(() => {
  cleanup();
});

/** The color `token` resolves to, as the browser reports a computed color. */
function tokenColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(--meridian-${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

it("draws declared and of muted between figures in the line's ink", () => {
  installMeridianTokens(document);
  const now = Date.now();
  const { container } = render(
    <AttachmentCard
      reading={{
        kind: "ingesting",
        entry: sendingEntry("ingesting", {
          declaredName: "quarterly-report.pdf",
          byteLength: 5_000_000,
          receivedBytes: 1_234_567,
          declaredMediaType: "application/pdf",
          lastProgressAtMilliseconds: now,
        }),
      }}
      nowMilliseconds={now}
    />,
    { wrapper: LiveAnnouncerProvider },
  );
  const spans = [...container.querySelectorAll("span")];
  const word = (text: string): Element => {
    const span = spans.find((element) => element.textContent === text);
    if (span === undefined) {
      throw new Error(`the card drew no "${text}"`);
    }
    return span;
  };
  const bytes = container.querySelector(".meridian-attachment__bytes");
  if (bytes?.firstElementChild === null || bytes?.firstElementChild === undefined) {
    throw new Error("the card drew no byte counts");
  }

  expect(getComputedStyle(word("declared")).color).toBe(tokenColor("text-muted"));
  expect(getComputedStyle(word("of")).color).toBe(tokenColor("text-muted"));
  expect(getComputedStyle(bytes.firstElementChild).color).not.toBe(tokenColor("text-muted"));
});
