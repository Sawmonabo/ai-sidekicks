// The coalesced send: three calls in order, and what each ending says.
//
// `new-session-send.ts` holds no state, so these cases drive the whole ladder through
// a draft that supplies the choices — the send that lands all three calls, the send
// that stops at each leg, and the two blankness rules. What repeated presses do to
// one draft object is `new-session-draft.test.ts` beside this one.
//
// The counted arm reads what reached the wire rather than comparing ids: the engine
// answers with the same scripted id every time, so a result alone cannot tell one
// call from two.

import { describe, expect, it } from "vitest";

import { countedDraftFor, draftFor, CREATED_SESSION_ID } from "./new-session-draft.test-support.js";
import {
  NEW_SESSION_DRAFT_REFUSAL_ORIGIN,
  RUN_QUEUE_CREATE_METHOD,
  refuseSendThatRejected,
} from "./new-session-settlement.js";

describe("NewSessionDraft — the send", () => {
  it("refuses an empty draft without touching the wire", async () => {
    const result = await draftFor({ scriptsCreate: true }).send();
    expect(result.outcome).toBe("refused");
    expect(result.refusal?.code).toBe("draft-empty");
    expect(result.completedCalls).toStrictEqual([]);
  });

  it("lands all three calls when every leg is scripted", async () => {
    const draft = draftFor({ scriptsCreate: true, scriptsAttach: true, scriptsFirstTurn: true });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: "account-9" });
    draft.setFirstTurn("Start on the parser.");
    const result = await draft.send();

    // The whole point of the coalesced send, and the state no earlier build could
    // reach: one act, three calls, named in the order they were made.
    expect(result.outcome).toBe("sent");
    expect(result.sessionId).toBe(CREATED_SESSION_ID);
    expect(result.completedCalls).toStrictEqual([
      "session.create",
      "agent.attach",
      "run.queueCreate",
    ]);
    expect(result.refusal).toBeUndefined();
  });

  it("stops at the attach the scenario scripts nothing for, and says the turn was not made", async () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: undefined });
    draft.setFirstTurn("Start on the parser.");
    const result = await draft.send();

    expect(result.outcome).toBe("partial");
    expect(result.sessionId).toBe(CREATED_SESSION_ID);
    // The error slot names the calls that SUCCEEDED, because a person deciding whether
    // to retry needs to know a session already exists.
    expect(result.completedCalls).toStrictEqual(["session.create"]);
    expect(result.refusal?.code).toBe("agent-attach-failed");
    // The send is ordered, so the turn behind the stopped leg was not attempted.
    expect(result.refusal?.detail).toContain("no first turn was queued");
  });

  it("names the missing first turn when the person typed none", async () => {
    // Zero agents is zero attaches, so the only call left is the turn — and its
    // absence is the person's own choice rather than a fact about the build, which is
    // why it is its own code.
    const draft = draftFor({ scriptsCreate: true });
    draft.setPosture("trusted");
    const result = await draft.send();

    expect(result.outcome).toBe("partial");
    expect(result.completedCalls).toStrictEqual(["session.create"]);
    expect(result.refusal?.code).toBe("first-turn-missing");
    // And it does not name a call this send was never going to make.
    expect(result.refusal?.detail).not.toContain("agent.attach");
  });

  it("refuses the turn the daemon would not queue, without claiming it landed", async () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.setFirstTurn("Start on the parser.");
    const result = await draft.send();

    expect(result.outcome).toBe("partial");
    expect(result.completedCalls).toStrictEqual(["session.create"]);
    expect(result.refusal?.code).toBe("first-turn-failed");
  });

  it("treats a blank first turn as none, and never trims what it sends", async () => {
    // Blankness is tested on both axes it decides, and they answer differently. A
    // draft whose ONLY content is whitespace is empty, so the send refuses before any
    // wire call — a person who typed spaces has composed nothing. Beside another axis
    // the draft is real and the turn is the leg that is missing.
    const onlyBlank = draftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    onlyBlank.setFirstTurn("   \n  ");
    expect((await onlyBlank.send()).refusal?.code).toBe("draft-empty");

    const draft = draftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    draft.setPosture("trusted");
    draft.setFirstTurn("   \n  ");
    const blank = await draft.send();
    expect(blank.refusal?.code).toBe("first-turn-missing");

    // The negative control for the trim rule: the text reaches the wire as the person
    // authored it, so indented code keeps its shape. A module that trimmed would send
    // a different message and this case could not tell.
    const indented = "    const parser = build();";
    const counted = countedDraftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    counted.draft.setFirstTurn(indented);
    await counted.draft.send();
    const queued = counted.calls.find((call) => call.method === RUN_QUEUE_CREATE_METHOD);
    expect(
      (queued?.params as { readonly payload: { readonly content: string } }).payload.content,
    ).toBe(indented);
  });

  it("keeps the draft when the create itself fails, and names no completed call", async () => {
    const draft = draftFor({ scriptsCreate: false });
    draft.setPosture("readonly-sandboxed");
    const result = await draft.send();

    expect(result.outcome).toBe("refused");
    expect(result.sessionId).toBeUndefined();
    expect(result.completedCalls).toStrictEqual([]);
    expect(result.refusal?.code).toBe("session-create-failed");
    // The draft survives a failed send: a person's choices are not thrown away
    // because a wire was down.
    expect(draft.snapshot().isEmpty).toBe(false);
  });

  it("negative control: the daemon's own message never reaches the person", async () => {
    // Without this, the case above would pass over a refusal that pasted an IPC
    // stack into console copy.
    const draft = draftFor({ scriptsCreate: false });
    draft.setPosture("trusted");
    const result = await draft.send();
    expect(result.refusal?.detail).not.toContain("scenario");
    expect(result.refusal?.detail).not.toContain("reply-unscripted");
  });
});

describe("NewSessionDraft — what a send that REJECTED reports", () => {
  // The arm this answers is defensive and, in this build, unreachable through the
  // bridge: `callDaemon` returns a typed reply for a rejected call, an absent door
  // and a schema failure alike, so no fixture bridge can make `send()` reject. What
  // shipped in its place was `undefined`, which cleared the result and left Send
  // pressable with nothing on screen, nothing announced, and nothing recorded — a
  // control that answers a press by doing nothing. So the SENTENCE is asserted here,
  // where it is built, rather than through a path a test would have to fake.

  it("carries a code of the draft's own vocabulary rather than clearing the press", () => {
    const reported = refuseSendThatRejected();

    expect(reported.outcome).toBe("refused");
    expect(reported.refusal?.code).toBe("send-failed");
    expect(reported.refusal?.origin).toBe(NEW_SESSION_DRAFT_REFUSAL_ORIGIN);
  });

  it("negative control: it claims nothing was created", () => {
    // Without this the case above would pass over a report that named the fault and
    // still carried a session id, which is a person told to retry a create that may
    // already have landed.
    const reported = refuseSendThatRejected();

    expect(reported.sessionId).toBeUndefined();
    expect(reported.completedCalls).toStrictEqual([]);
  });
});
