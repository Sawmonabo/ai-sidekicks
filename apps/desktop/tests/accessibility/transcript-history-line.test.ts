// The accessibility tier for the history line above the transcript's first row. The line sits in
// the scroll container beside the rows, and a feed may own nothing but articles, so the line must
// stay outside the feed in each of its states: `Load earlier`, and the failed read's `Try again`.

import { beforeEach, describe, expect, it } from "vitest";

import { changeLayout } from "../helpers/animation-frame.js";
import { mountEarlierHistoryFeed } from "../helpers/earlier-history-feed.js";
import { describeViolations, runTierAxe } from "./axe-run.js";
import { installMeridianTokens } from "#renderer/app/token-installation.js";

beforeEach(() => {
  installMeridianTokens(document);
});

describe("accessibility — the transcript's history line", () => {
  it("passes the tier's rules offering earlier history and after a read of it failed", async () => {
    const { container, log, landRead } = await mountEarlierHistoryFeed();
    expect(describeViolations(await runTierAxe(container))).toEqual([]);

    await changeLayout(() => {
      container
        .querySelector<HTMLButtonElement>(".meridian-transcript-viewport__load-earlier")
        ?.click();
    });
    log.refuseNextRead();
    await landRead();
    expect(container.textContent).toContain("Couldn't load earlier messages");
    expect(describeViolations(await runTierAxe(container))).toEqual([]);
  });
});
