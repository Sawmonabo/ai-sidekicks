// The lease holding: three values, and the reason it is not two.
//
// The dangerous collapse is `null` and "not read yet" arriving at a row as one thing.
// `null` is the wire saying nobody holds the shared terminal, which is a state a
// person may act on; an unanswered read says nothing at all. A reader that returned
// "unheld" for both would invite somebody to take a shell another participant is
// holding, on the strength of the console's own failure to read.

import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import {
  TERMINAL_CONTROL_HOLDER_ORIGIN,
  terminalControlHolderRefusal,
  terminalControlHolding,
  type TerminalControlHolderReading,
} from "./terminal-control-holder.js";

const HELD: TerminalControlHolderReading = {
  kind: "answered",
  outcome: { status: "served", value: { controlHolder: "participant-tomas" } },
};

const FREE: TerminalControlHolderReading = {
  kind: "answered",
  outcome: { status: "served", value: { controlHolder: null } },
};

const REFUSED: TerminalControlHolderReading = {
  kind: "answered",
  outcome: growthUnavailable("terminalControlHolderRead"),
};

const UNREADABLE: TerminalControlHolderReading = {
  kind: "unreadable",
  refusal: {
    origin: TERMINAL_CONTROL_HOLDER_ORIGIN,
    code: "bridge.unreachable",
    detail: "The bridge went away.",
  },
};

describe("terminal control — what the read said", () => {
  it("names the holder where the wire named one", () => {
    expect(terminalControlHolding(HELD)).toStrictEqual({
      kind: "held",
      participantId: "participant-tomas",
    });
  });

  it("reads a null holder as a free lease, which is an answer", () => {
    // The registered member resolves to null both when nobody holds the lease and
    // when the holding node reads offline. Both are "no advertised holder", which is
    // what the surface draws.
    expect(terminalControlHolding(FREE)).toStrictEqual({ kind: "unheld" });
  });

  it("reads every unanswered arm as unread rather than as a free lease", () => {
    expect(terminalControlHolding(undefined)).toStrictEqual({ kind: "unread" });
    expect(terminalControlHolding(REFUSED)).toStrictEqual({ kind: "unread" });
    expect(terminalControlHolding(UNREADABLE)).toStrictEqual({ kind: "unread" });
  });
});

describe("terminal control — why the holder is not here", () => {
  it("carries the refusal from either unanswered arm", () => {
    expect(terminalControlHolderRefusal(REFUSED)?.code).toBe("wire-unregistered");
    expect(terminalControlHolderRefusal(UNREADABLE)?.code).toBe("bridge.unreachable");
  });

  it("negative control: a served read and a read in flight carry none", () => {
    expect(terminalControlHolderRefusal(HELD)).toBeUndefined();
    expect(terminalControlHolderRefusal(FREE)).toBeUndefined();
    expect(terminalControlHolderRefusal(undefined)).toBeUndefined();
  });
});
