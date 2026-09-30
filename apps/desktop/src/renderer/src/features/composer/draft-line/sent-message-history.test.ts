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

  it("declines when there is nothing further to reach, so the arrow stays the caret's", () => {
    const history = new SentMessageHistory();
    expect(history.recallOlder("draft")).toBeUndefined();
    expect(history.recallNewer()).toBeUndefined();

    history.recordSent("only one");
    expect(history.recallOlder("draft")).toBe("only one");
    // A second step past the end must decline, not wrap and replace the draft.
    expect(history.recallOlder("draft")).toBeUndefined();
  });

  it("bounds the list, so a long session does not grow one without end", () => {
    const history = new SentMessageHistory();
    for (let index = 0; index <= COMPOSER_HISTORY_RECALL_CAP; index += 1) {
      history.recordSent(`message ${String(index)}`);
    }
    expect(history.recallableCount).toBe(COMPOSER_HISTORY_RECALL_CAP);
  });

  it("ends the walk when a message is sent, so a later step cannot re-send it", () => {
    const history = new SentMessageHistory();
    history.recordSent("older");
    history.recallOlder("draft");
    history.recordSent("newer");

    expect(history.isRecalling).toBe(false);
    expect(history.recallNewer()).toBeUndefined();
  });

  it("ignores a blank send, which is not a message anyone can recall", () => {
    const history = new SentMessageHistory();
    history.recordSent("   ");
    expect(history.recallableCount).toBe(0);
  });

  it("recalls the message verbatim, so walking back and sending again sends the same bytes", () => {
    // A trimmed copy would drop the indentation the router preserved on send.
    const history = new SentMessageHistory();
    const indented = "  if (ready) {\n    ship();\n  }\n\n";
    history.recordSent(indented);

    expect(history.recallOlder("")).toBe(indented);
  });
});

describe("histories are per address, so a walk never crosses a rebinding", () => {
  it("keeps each address's sent messages to itself", () => {
    const histories = new SentMessageHistories();
    histories.forAddress("first").recordSent("written for the first");

    // One history for the whole bar would hand the second address the first one's text.
    expect(histories.forAddress("second").recallOlder("")).toBeUndefined();
    expect(histories.forAddress("first").recallOlder("")).toBe("written for the first");
  });

  it("puts the cursor at rest for an address that has just become current", () => {
    const histories = new SentMessageHistories();
    histories.forAddress("first").recordSent("written for the first");
    expect(histories.forAddress("first").recallOlder("half-written")).toBe("written for the first");

    histories.forAddress("second");
    const returned = histories.forAddress("first");

    // Coming back cannot land mid-walk, so the stashed draft is not restorable.
    expect(returned.isRecalling).toBe(false);
    expect(returned.recallNewer()).toBeUndefined();
    expect(returned.recallOlder("")).toBe("written for the first");
  });

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

  it("re-addressing an address it already holds does not disturb its walk", () => {
    // Asked on every render; a re-ask that reset the cursor would block ArrowUp past the newest.
    const histories = new SentMessageHistories();
    histories.forAddress("first").recordSent("older");
    histories.forAddress("first").recordSent("newer");
    expect(histories.forAddress("first").recallOlder("")).toBe("newer");
    expect(histories.forAddress("first").recallOlder("")).toBe("older");
  });
});
