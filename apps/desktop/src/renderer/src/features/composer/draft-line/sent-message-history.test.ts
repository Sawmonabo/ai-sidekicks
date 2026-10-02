// A recall walk never eats a draft.

import { describe, expect, it } from "vitest";

import { COMPOSER_HISTORY_RECALL_CAP, COMPOSER_RETAINED_ADDRESS_CAP } from "../composer-bounds.js";
import { SentMessageHistories, SentMessageHistory } from "./sent-message-history.js";

describe("recall walks sent messages and gives the draft back", () => {
  it("stashes the unsent draft on the first step and restores it on the way down", () => {
    const history = new SentMessageHistory();
    history.recordSent("first");
    history.recordSent("second");

    expect(history.recallOlder("half-written")).toBe("second");
    expect(history.recallOlder("half-written")).toBe("first");
    expect(history.recallNewer()).toBe("second");
    // The person's own text, not the message walked past, and the walk is over.
    expect(history.recallNewer()).toBe("half-written");
    expect(history.recallNewer()).toBeUndefined();
  });

  it("bounds the list, so a long session does not grow one without end", () => {
    const history = new SentMessageHistory();
    for (let index = 0; index <= COMPOSER_HISTORY_RECALL_CAP; index += 1) {
      history.recordSent(`message ${String(index)}`);
    }
    for (let step = 1; step < COMPOSER_HISTORY_RECALL_CAP; step += 1) {
      history.recallOlder("");
    }
    // The oldest retained message is the second one sent; the first was dropped.
    expect(history.recallOlder("")).toBe("message 1");
    expect(history.recallOlder("")).toBeUndefined();
  });
});

describe("histories are per address, so a walk never crosses a rebinding", () => {
  it("evicts the least recently addressed past the retained-address cap", () => {
    const histories = new SentMessageHistories();
    for (let index = 0; index <= COMPOSER_RETAINED_ADDRESS_CAP; index += 1) {
      histories.forAddress(`address ${String(index)}`).recordSent(`message ${String(index)}`);
    }

    // The least recent address is the one dropped, not the most recent.
    expect(histories.forAddress("address 0").recallOlder("")).toBeUndefined();
    expect(
      histories.forAddress(`address ${String(COMPOSER_RETAINED_ADDRESS_CAP)}`).recallOlder(""),
    ).toBe(`message ${String(COMPOSER_RETAINED_ADDRESS_CAP)}`);
  });
});
