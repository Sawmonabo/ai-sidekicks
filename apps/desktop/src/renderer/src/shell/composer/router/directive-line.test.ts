// The directive line's two claims: what it says, and that a walk never eats a draft.

import { describe, expect, it } from "vitest";

import { COMPOSER_HISTORY_RECALL_CAP, COMPOSER_RETAINED_ADDRESS_CAP } from "../composer-bounds.js";
import type { ComposerChannelTarget, ComposerRunTarget } from "../chips/chip-models.js";
import {
  AddressedDirectiveHistories,
  DirectiveHistory,
  caretAtEnd,
  caretAtStart,
  composeDirectivePlaceholder,
  directivePathLabel,
} from "./directive-line.js";

const CHANNEL_TARGET: ComposerChannelTarget = {
  path: "channel-message",
  sessionId: "session",
  channelId: undefined,
  workspaceId: undefined,
  channelLabel: "main",
};

const RUN_TARGET: ComposerRunTarget = {
  path: "provider-bound",
  sessionId: "9d0e1f2a-3b4c-4d5e-8f90-1a2b3c4d5e6f",
  // An opaque id rather than a friendly word, so the control below is real: a
  // placeholder that leaked the handle would have to leak THIS, and a fixture id
  // that read like English would have made the assertion pass on the copy itself.
  agentId: "01J8ZQ4KX2N7V3T5W9",
  agentName: "Ada",
  driverName: "claude",
  targetRunId: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
  expectedRunVersion: 1,
  runState: "running",
  providerFailureDetail: undefined,
};

describe("the placeholder names the target and never an internal handle", () => {
  it("names the channel and the agent it is addressed to", () => {
    expect(composeDirectivePlaceholder(CHANNEL_TARGET)).toBe("Message main");
    expect(composeDirectivePlaceholder(RUN_TARGET)).toBe("Steer Ada's running turn");
  });

  it("describes an unnamed target rather than printing its id", () => {
    const unnamed = composeDirectivePlaceholder({ ...RUN_TARGET, agentName: undefined });
    expect(unnamed).toBe("Steer the agent's running turn");
    // The negative control: the id is in the target and must not reach the copy.
    expect(unnamed).not.toContain(RUN_TARGET.agentId);
  });
});

describe("the path label follows the resolution, not the target", () => {
  it("labels the two send arms and nothing else", () => {
    expect(
      directivePathLabel({
        outcome: "new-turn",
        request: { sessionId: "s", payload: {} } as never,
      }),
    ).toBe("new turn");
    expect(directivePathLabel({ outcome: "steer", request: {} as never })).toBe("steer");
  });

  it("labels nothing when the text resolves to no send", () => {
    // A run-addressed refusal would still be "steer" if the label read the TARGET,
    // which is the drift this control exists to catch.
    expect(
      directivePathLabel({
        outcome: "refused",
        refusal: { origin: "composer", code: "run-version-unread", detail: "not read" },
      }),
    ).toBeUndefined();
    expect(
      directivePathLabel({ outcome: "client-command", commandName: "compact" }),
    ).toBeUndefined();
  });
});

describe("recall walks sent messages and gives the draft back", () => {
  it("stashes the unsent draft on the first step and restores it on the way down", () => {
    const history = new DirectiveHistory();
    history.recordSent("first");
    history.recordSent("second");

    expect(history.recallOlder("half-written")).toBe("second");
    expect(history.recallOlder("half-written")).toBe("first");
    expect(history.isRecalling).toBe(true);
    expect(history.recallNewer()).toBe("second");
    // The claim that matters: the person's own text, not the message walked past.
    expect(history.recallNewer()).toBe("half-written");
    expect(history.isRecalling).toBe(false);
  });

  it("declines when there is nothing further to reach, so the arrow stays the caret's", () => {
    const history = new DirectiveHistory();
    expect(history.recallOlder("draft")).toBeUndefined();
    expect(history.recallNewer()).toBeUndefined();

    history.recordSent("only one");
    expect(history.recallOlder("draft")).toBe("only one");
    // The negative control: a second step past the end must decline rather than
    // wrapping round, which would silently replace the draft with the same message.
    expect(history.recallOlder("draft")).toBeUndefined();
  });

  it("bounds the list, so a long session does not grow one without end", () => {
    const history = new DirectiveHistory();
    for (let index = 0; index <= COMPOSER_HISTORY_RECALL_CAP; index += 1) {
      history.recordSent(`message ${String(index)}`);
    }
    expect(history.recallableCount).toBe(COMPOSER_HISTORY_RECALL_CAP);
  });

  it("ends the walk when a message is sent, so a later step cannot re-send it", () => {
    const history = new DirectiveHistory();
    history.recordSent("older");
    history.recallOlder("draft");
    history.recordSent("newer");

    expect(history.isRecalling).toBe(false);
    expect(history.recallNewer()).toBeUndefined();
  });

  it("ignores a blank send, which is not a message anyone can recall", () => {
    const history = new DirectiveHistory();
    history.recordSent("   ");
    expect(history.recallableCount).toBe(0);
  });

  it("recalls the message verbatim, so walking back and sending again sends the same bytes", () => {
    // The list used to store a trimmed copy, which put the router's own defect one
    // ArrowUp away: the send went out with the indentation and the recall gave it
    // back without.
    const history = new DirectiveHistory();
    const indented = "  if (ready) {\n    ship();\n  }\n\n";
    history.recordSent(indented);

    expect(history.recallOlder("")).toBe(indented);
  });
});

describe("the edge offsets are what let an arrow recall at all", () => {
  it("recognises a collapsed caret at each edge", () => {
    expect(caretAtStart({ selectionStart: 0, selectionEnd: 0, textLength: 9 })).toBe(true);
    expect(caretAtEnd({ selectionStart: 9, selectionEnd: 9, textLength: 9 })).toBe(true);
  });

  it("declines a selection and a caret in the middle", () => {
    // A person selecting from the start is not at the start edge in the sense that
    // matters: ArrowUp there extends or collapses their selection.
    expect(caretAtStart({ selectionStart: 0, selectionEnd: 4, textLength: 9 })).toBe(false);
    expect(caretAtEnd({ selectionStart: 4, selectionEnd: 4, textLength: 9 })).toBe(false);
  });
});

describe("histories are per address, so a walk never crosses a rebinding", () => {
  it("keeps each address's sent messages to itself", () => {
    const histories = new AddressedDirectiveHistories();
    histories.forAddress("first").recordSent("written for the first");

    // The defect this closes: one history for the mounted bar handed the second
    // address the first one's participant-authored text on ArrowUp.
    expect(histories.forAddress("second").recallOlder("")).toBeUndefined();
    expect(histories.forAddress("first").recallOlder("")).toBe("written for the first");
  });

  it("puts the cursor at rest for an address that has just become current", () => {
    const histories = new AddressedDirectiveHistories();
    histories.forAddress("first").recordSent("written for the first");
    expect(histories.forAddress("first").recallOlder("half-written")).toBe("written for the first");

    histories.forAddress("second");
    const returned = histories.forAddress("first");

    // Walking is a gesture within one line: coming back cannot land mid-walk, so the
    // stashed draft is not restorable and the walk starts again from the newest.
    expect(returned.isRecalling).toBe(false);
    expect(returned.recallNewer()).toBeUndefined();
    expect(returned.recallOlder("")).toBe("written for the first");
  });

  it("evicts the least recently addressed past the retained-address cap", () => {
    const histories = new AddressedDirectiveHistories();
    for (let index = 0; index <= COMPOSER_RETAINED_ADDRESS_CAP; index += 1) {
      histories.forAddress(`address ${String(index)}`).recordSent(`message ${String(index)}`);
    }

    expect(histories.retainedAddressCount).toBe(COMPOSER_RETAINED_ADDRESS_CAP);
    // The oldest address is gone; the newest is intact. The negative control for the
    // eviction ORDER: dropping the most recent instead would pass a size assertion.
    expect(histories.forAddress("address 0").recallOlder("")).toBeUndefined();
    expect(
      histories.forAddress(`address ${String(COMPOSER_RETAINED_ADDRESS_CAP)}`).recallOlder(""),
    ).toBe(`message ${String(COMPOSER_RETAINED_ADDRESS_CAP)}`);
  });

  it("re-addressing an address it already holds does not disturb its walk", () => {
    // Asked on every render, so it has to be idempotent: a re-ask that reset the
    // cursor would make ArrowUp unable to reach past the newest message.
    const histories = new AddressedDirectiveHistories();
    histories.forAddress("first").recordSent("older");
    histories.forAddress("first").recordSent("newer");
    expect(histories.forAddress("first").recallOlder("")).toBe("newer");
    expect(histories.forAddress("first").recallOlder("")).toBe("older");
  });
});
