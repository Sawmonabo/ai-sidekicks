// The accessibility tier for the history line above the transcript's first row. The line sits in
// the scroll container beside the rows, and a feed may own nothing but articles, so the line must
// stay outside the feed in each of its states: `Load earlier`, `Loading…` and the failed read's
// `Try again`. A keyboard press keeps its focus while the read runs, and the read is said.

import { beforeEach, describe, expect, it } from "vitest";

import { changeLayout } from "../../helpers/animation-frame.js";
import { mountEarlierHistoryFeed } from "../../helpers/transcript/earlier-history-feed.js";
import { describeViolations, runTierAxe } from "../axe-run.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";

beforeEach(() => {
  installMeridianTokens(document);
});

describe("accessibility — the transcript's history line", () => {
  it("passes the tier's rules offering earlier history, reading it and after the read failed", async () => {
    const { container, log, landRead, spoken } = await mountEarlierHistoryFeed();
    expect(describeViolations(await runTierAxe(container))).toEqual([]);

    const loadEarlier = container.querySelector<HTMLButtonElement>(
      ".meridian-transcript-viewport__load-earlier",
    );
    await changeLayout(() => {
      loadEarlier?.focus();
      loadEarlier?.click();
    });
    expect(loadEarlier?.textContent).toBe("Loading…");
    expect(document.activeElement).toBe(loadEarlier);
    expect(spoken()).toContain("Loading…");
    expect(describeViolations(await runTierAxe(container))).toEqual([]);

    log.refuseNextRead();
    await landRead();
    expect(container.textContent).toContain("Couldn't load earlier messages");
    expect(describeViolations(await runTierAxe(container))).toEqual([]);
  });
});
