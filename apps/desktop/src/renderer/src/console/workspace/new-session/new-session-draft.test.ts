// The draft object: what it holds, and the one session it is allowed to make.
//
// `new-session-draft.ts` asks for a draft that is local until it is sent, and for one
// draft object to make at most one session however many times Send is pressed. Both
// halves are asserted here; what the send itself puts on the wire, and what each
// ending says, is `new-session-send.test.ts` beside this one.
//
// EVERY COUNT IS OF CALLS THAT REACHED THE WIRE rather than of ids compared, and that
// is the fixture's doing: the engine answers `session.create` with the same scripted
// id every time, so a second session is indistinguishable from the first BY ITS
// RESULT. The count is the only reading that tells one session from two — and, one
// leg down, one attach from two.

import { describe, expect, it } from "vitest";

import {
  countedDraftFor,
  draftFor,
  sentMethod,
  CREATED_SESSION_ID,
  RUN_QUEUE_CREATE_METHOD,
  SESSION_CREATE_METHOD,
} from "./new-session-draft.test-support.js";

describe("NewSessionDraft — what it holds", () => {
  it("starts empty and says so", () => {
    const draft = draftFor({ scriptsCreate: true });
    expect(draft.snapshot().isEmpty).toBe(true);
  });

  it("replaces a second selection of the same definition rather than adding it twice", () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: undefined });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: "account-9" });
    expect(draft.snapshot().agents).toStrictEqual([
      { definitionId: "definition-1", providerAccountId: "account-9" },
    ]);
  });

  it("ignores a paying account for an agent that was never selected", () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.setPayingAccount("definition-unknown", "account-9");
    expect(draft.snapshot().agents).toStrictEqual([]);
    expect(draft.snapshot().isEmpty).toBe(true);
  });

  it("becomes non-empty on any one axis, and empty again when discarded", () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.setPosture("workspace-sandboxed");
    expect(draft.snapshot().isEmpty).toBe(false);
    draft.discard();
    expect(draft.snapshot().isEmpty).toBe(true);
  });

  it("publishes each mutation to its subscribers", () => {
    const draft = draftFor({ scriptsCreate: true });
    const revisions: number[] = [];
    const unsubscribe = draft.subscribe((state) => {
      revisions.push(state.revision);
    });
    draft.setRepoMount({ repoId: "repo-1", executionMode: "worktree" });
    draft.setPosture("trusted");
    unsubscribe();
    expect(revisions).toStrictEqual([1, 2]);
  });
});

describe("NewSessionDraft — one draft object, at most one session", () => {
  it("coalesces two synchronous presses into one create and one result", async () => {
    const { draft, calls } = countedDraftFor({ scriptsCreate: true });
    draft.setPosture("trusted");

    // Not awaited between the two: this is the double-click, where the second press
    // lands while the first send is still in flight.
    const [first, second] = await Promise.all([draft.send(), draft.send()]);

    expect(calls.map(sentMethod)).toStrictEqual([SESSION_CREATE_METHOD]);
    // The same settlement, not merely an equal one — the second caller joined the
    // running send rather than starting a second that happened to agree.
    expect(second).toBe(first);
    expect(first.outcome).toBe("partial");
    expect(first.sessionId).toBe(CREATED_SESSION_ID);
  });

  it("re-reports the existing session when the partial is retried", async () => {
    const { draft, calls } = countedDraftFor({ scriptsCreate: true });
    draft.setPosture("trusted");

    const first = await draft.send();
    // What a person does after reading the partial: change nothing, press again.
    // That is a retry of the send, not a request for a second session.
    const retried = await draft.send();

    expect(calls.map(sentMethod)).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(retried.sessionId).toBe(first.sessionId);
    expect(retried.completedCalls).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(retried.refusal?.code).toBe("first-turn-missing");
  });

  it("creates again for a fresh draft object, which is what closing gives", async () => {
    // The invariant is scoped to the OBJECT, so the next "+ New" — which builds a
    // new one — must still be able to make a session. A memory held anywhere wider
    // would have made the second draft unsendable.
    const first = countedDraftFor({ scriptsCreate: true });
    first.draft.setPosture("trusted");
    await first.draft.send();

    const second = countedDraftFor({ scriptsCreate: true });
    second.draft.setPosture("trusted");
    await second.draft.send();

    expect(second.calls.map(sentMethod)).toStrictEqual([SESSION_CREATE_METHOD]);
  });

  it("negative control: a single press still reaches the wire exactly once", async () => {
    // Without this, a build that had stopped calling `session.create` at all would
    // satisfy every count above — zero is not two.
    const { draft, calls } = countedDraftFor({ scriptsCreate: true });
    draft.setPosture("trusted");

    const result = await draft.send();

    expect(calls.map(sentMethod)).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(result.sessionId).toBe(CREATED_SESSION_ID);
  });

  it("resumes at the first unmade call rather than repeating the ones that landed", async () => {
    // The per-leg memory, which is the invariant one leg down from "one draft, one
    // session": a retry that re-attached would put two agents on the session for one
    // the person chose once, and one that re-queued would send their words twice.
    const draft = draftFor({ scriptsCreate: true, scriptsAttach: true, scriptsFirstTurn: true });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: undefined });
    const stopped = await draft.send();
    expect(stopped.refusal?.code).toBe("first-turn-missing");
    expect(stopped.completedCalls).toStrictEqual(["session.create", "agent.attach"]);

    // What a person does after reading that: type the message, press again.
    draft.setFirstTurn("Start on the parser.");
    const finished = await draft.send();

    expect(finished.outcome).toBe("sent");
    // Every leg named once. The create and the attach are named because they EXIST,
    // not because this press made them — the slot's job is to say what is there.
    expect(finished.completedCalls).toStrictEqual([
      "session.create",
      "agent.attach",
      "run.queueCreate",
    ]);
  });

  it("negative control: the second press re-attaches nothing the first one landed", async () => {
    // Without this the case above would pass over a build that re-issued the attach,
    // since a second attach the fixture also answers changes no result it asserts.
    const counted = countedDraftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    counted.draft.setPosture("trusted");
    await counted.draft.send();
    counted.draft.setFirstTurn("Start on the parser.");
    await counted.draft.send();

    expect(counted.calls.map(sentMethod)).toStrictEqual([
      SESSION_CREATE_METHOD,
      RUN_QUEUE_CREATE_METHOD,
    ]);
  });

  it("retries the create when the first attempt never landed one", async () => {
    // A create that FAILED left no session, so nothing is remembered and a retry is
    // a real second attempt — the memory keys on the call having landed, not on the
    // send having been pressed.
    const { draft, calls } = countedDraftFor({ scriptsCreate: false });
    draft.setPosture("trusted");

    const first = await draft.send();
    const retried = await draft.send();

    expect(first.refusal?.code).toBe("session-create-failed");
    expect(retried.refusal?.code).toBe("session-create-failed");
    expect(calls.map(sentMethod)).toStrictEqual([SESSION_CREATE_METHOD, SESSION_CREATE_METHOD]);
  });
});
