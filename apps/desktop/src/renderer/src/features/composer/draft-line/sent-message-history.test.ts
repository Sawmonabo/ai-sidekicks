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
    expect(history.isRecalling).toBe(true);
    expect(history.recallNewer()).toBe("second");
    // The person's own text, not the message walked past.
    expect(history.recallNewer()).toBe("half-written");
    expect(history.isRecalling).toBe(false);
  });

  it("bounds the list, so a long session does not grow one without end", () => {
    const history = new SentMessageHistory();
    for (let index = 0; index <= COMPOSER_HISTORY_RECALL_CAP; index += 1) {
      history.recordSent(`message ${String(index)}`);
    }
    expect(history.recallableCount).toBe(COMPOSER_HISTORY_RECALL_CAP);
  });
});

describe("histories are per address, so a walk never crosses a rebinding", () => {
  it("evicts the least recently addressed past the retained-address cap", () => {
    const histories = new SentMessageHistories();
    for (let index = 0; index <= COMPOSER_RETAINED_ADDRESS_CAP; index += 1) {
      histories.forAddress(`address ${String(index)}`).recordSent(`message ${String(index)}`);
    }

    expect(histories.retainedAddressCount).toBe(COMPOSER_RETAINED_ADDRESS_CAP);
    // Dropping the most recent instead would pass a size assertion, so the order is checked.
    expect(histories.forAddress("address 0").recallOlder("")).toBeUndefined();
    expect(
      histories.forAddress(`address ${String(COMPOSER_RETAINED_ADDRESS_CAP)}`).recallOlder(""),
    ).toBe(`message ${String(COMPOSER_RETAINED_ADDRESS_CAP)}`);
  });
});
