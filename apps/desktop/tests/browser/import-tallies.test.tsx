// A settled import's line drawn in Chromium: already here receding, the unreadable tally in the
// attention amber and the failed tally in the failure red, while the imported counts keep the
// line's own muted ink, the negative control for a line drawn in one hue as a whole.

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type {
  ProviderImportId,
  ProviderImportProgress,
} from "@ai-sidekicks/contracts/provider/import";
import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import type { ProviderImportModel } from "#renderer/features/settings/pages/providers/import/hooks/useProviderImport.js";
import { ImportProgressLine } from "#renderer/features/settings/pages/providers/import/panel/ImportProgressLine.js";

import "#renderer/features/settings/pages/providers/import/panel/ProviderImportPanel.css";
import { computedTokenColor } from "#test/helpers/token-color.js";

afterEach(() => {
  cleanup();
});

/** A settled import that failed one conversation and could not read two files. */
function settledModel(): ProviderImportModel {
  const settled: ProviderImportProgress = {
    kind: "settled",
    provider: "claude",
    importId: "provider-import-1" as ProviderImportId,
    settlement: {
      outcome: "finished",
      imported: 125,
      total: 128,
      alreadyHere: 34,
      failures: [{ source: "one.jsonl", reason: "truncated" }],
      unreadableFiles: ["two.jsonl", "three.jsonl"],
      attachedProjects: [],
    },
  };
  return {
    provider: "claude",
    progress: { status: "closed", newest: settled, replayed: settled },
    startRefusal: undefined,
    stopRefusal: undefined,
    isReading: false,
    isUnderway: false,
    isStopping: false,
    startPressOrdinal: 0,
    isShowingReplay: true,
    start: () => undefined,
    stop: () => undefined,
    reopen: () => undefined,
  };
}

it("draws already here faint, the unreadable tally amber and the failed tally red", () => {
  installMeridianTokens(document);
  const { container } = render(<ImportProgressLine model={settledModel()} />, {
    wrapper: LiveAnnouncerProvider,
  });
  const spans = [...container.querySelectorAll("span")];
  const colorOf = (text: string): string => {
    const span = spans.find((element) => element.textContent === text);
    if (span === undefined) {
      throw new Error(`the line drew no "${text}"`);
    }
    return getComputedStyle(span).color;
  };

  expect(colorOf(" · 34 already here")).toBe(computedTokenColor("text-faint"));
  expect(colorOf(" · 2 files could not be read")).toBe(computedTokenColor("amber-text"));
  expect(colorOf(" · 1 failed.")).toBe(computedTokenColor("red-text"));
  expect(colorOf("125")).toBe(computedTokenColor("text-muted"));
});
