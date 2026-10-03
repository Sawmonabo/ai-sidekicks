// The draft object: the one session it may make however many times Send is pressed. What the
// send puts on the wire is `new-session-send.test.ts`.
//
// Every count is of calls that reached the wire, not of ids compared: the fixture answers
// `session.create` with the same scripted id every time, so a second session is
// indistinguishable from the first by its result.

import { describe, expect, it } from "vitest";

import {
  countedDraftFor,
  countedDraftOverUnreadableCreate,
  draftFor,
  CREATED_SESSION_ID,
  PROJECT_REPO_MOUNT,
} from "./new-session-draft.test-support.js";
// The method the send names, taken from the module that sends it, so the count is asserted
// against the string that reached the wire.
import { SESSION_CREATE_METHOD } from "./new-session-settlement.js";

describe("NewSessionDraft — one draft object, at most one session", () => {
  it("coalesces two synchronous presses into one create and one result", async () => {
    const { draft, calls } = countedDraftFor({ scriptsCreate: true });
    draft.setRepoMount(PROJECT_REPO_MOUNT);

    // Not awaited between the two: the double-click, where the second press lands while the
    // first send is in flight.
    const [first, second] = await Promise.all([draft.send(), draft.send()]);

    expect(calls.map((call) => call.method)).toStrictEqual([SESSION_CREATE_METHOD]);
    // The same settlement, not an equal one: the second caller joined the running send.
    expect(second).toBe(first);
    expect(first.outcome).toBe("partial");
    expect(first.sessionId).toBe(CREATED_SESSION_ID);
  });

  it("re-reports the existing session when the partial is retried", async () => {
    const { draft, calls } = countedDraftFor({ scriptsCreate: true });
    draft.setRepoMount(PROJECT_REPO_MOUNT);

    const first = await draft.send();
    // A person reads the partial, changes nothing and presses again: a retry, not a second
    // session.
    const retried = await draft.send();

    expect(calls.map((call) => call.method)).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(retried.sessionId).toBe(first.sessionId);
    expect(retried.completedCalls).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(retried.refusal?.code).toBe("first-turn-missing");
  });

  it("creates again for a fresh draft object, which is what closing gives", async () => {
    // The invariant is scoped to the object, so the next "+ New" builds a new draft that must
    // still be able to make a session.
    const first = countedDraftFor({ scriptsCreate: true });
    first.draft.setRepoMount(PROJECT_REPO_MOUNT);
    await first.draft.send();

    const second = countedDraftFor({ scriptsCreate: true });
    second.draft.setRepoMount(PROJECT_REPO_MOUNT);
    await second.draft.send();

    expect(second.calls.map((call) => call.method)).toStrictEqual([SESSION_CREATE_METHOD]);
  });

  it("resumes at the first unmade call rather than repeating the ones that landed", async () => {
    // The per-leg memory: a retry that re-queued would send the person's words twice.
    const draft = draftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    draft.setRepoMount(PROJECT_REPO_MOUNT);
    const stopped = await draft.send();
    expect(stopped.refusal?.code).toBe("first-turn-missing");
    expect(stopped.completedCalls).toStrictEqual(["session.create"]);

    // What a person does after reading that: type the message, press again.
    draft.setFirstTurn("Start on the parser.");
    const finished = await draft.send();

    expect(finished.outcome).toBe("sent");
    // Every leg named once; the create is named because it exists, not because this press
    // made it.
    expect(finished.completedCalls).toStrictEqual(["session.create", "run.queueCreate"]);
  });

  it("negative control: the second press re-issues nothing the first one landed", async () => {
    // Without this the case above would pass over a build that re-issued the create, since
    // the fixture answers a second create identically.
    const counted = countedDraftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    counted.draft.setRepoMount(PROJECT_REPO_MOUNT);
    await counted.draft.send();
    counted.draft.setFirstTurn("Start on the parser.");
    await counted.draft.send();

    expect(counted.calls.map((call) => call.method)).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(counted.firstTurns).toHaveLength(1);
  });

  it("retries the create when the first attempt never landed one", async () => {
    // A failed create left no session, so nothing is remembered; the memory keys on the call
    // having landed, not on the send having been pressed.
    const { draft, calls } = countedDraftFor({ scriptsCreate: false });
    draft.setRepoMount(PROJECT_REPO_MOUNT);

    const first = await draft.send();
    const retried = await draft.send();

    expect(first.refusal?.code).toBe("session-create-failed");
    expect(retried.refusal?.code).toBe("session-create-failed");
    expect(calls.map((call) => call.method)).toStrictEqual([
      SESSION_CREATE_METHOD,
      SESSION_CREATE_METHOD,
    ]);
    // The retry carries the same key, so a first attempt that lost only its answer is named
    // again, not made twice.
    const [firstKey, retriedKey] = calls.map(
      (call) => (call.params as { clientIdempotencyKey: string }).clientIdempotencyKey,
    );
    expect(retriedKey).toBe(firstKey);
  });
});

describe("NewSessionDraft — the create it cannot answer for", () => {
  it("settles a create whose reply cannot be read on its own arm, not as a refusal", async () => {
    // An unreadable reply shown as `session-create-failed` would invite a press that makes a
    // second session.
    const { draft } = countedDraftOverUnreadableCreate();
    draft.setFirstTurn("Start on the parser.");

    const result = await draft.send();

    expect(result.outcome).toBe("created-unreadable");
    expect(result.refusal?.code).toBe("session-create-unreadable");
    expect(result.sessionId).toBeUndefined();
    // Nothing is claimed as landed, and the sentence says what to do instead of pressing again.
    expect(result.completedCalls).toStrictEqual([]);
    expect(result.refusal?.detail).toContain("Check the sessions list");
  });

  it("negative control: no second `session.create` on any later press", async () => {
    // The fixture answers every create alike, so only the count of calls on the wire can show
    // a second session.
    const { draft, calls } = countedDraftOverUnreadableCreate();
    draft.setFirstTurn("Start on the parser.");

    const first = await draft.send();
    const second = await draft.send();
    const third = await draft.send();

    expect(calls.map((call) => call.method)).toStrictEqual([SESSION_CREATE_METHOD]);
    // Every later press answers the same settlement, so the sentence does not change under
    // the person reading it.
    expect(first.outcome).toBe("created-unreadable");
    expect(second.outcome).toBe("created-unreadable");
    expect(third.outcome).toBe("created-unreadable");
    expect(third.refusal?.code).toBe("session-create-unreadable");
  });

  it("refuses a later press even after the draft is emptied and re-composed", async () => {
    // The invariant is scoped to the object: an emptied and re-composed draft must not create
    // again.
    const { draft, calls } = countedDraftOverUnreadableCreate();
    draft.setFirstTurn("Start on the parser.");
    await draft.send();

    draft.discard();
    draft.setFirstTurn("Start again.");
    const afterDiscard = await draft.send();

    expect(calls.map((call) => call.method)).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(afterDiscard.outcome).toBe("created-unreadable");
  });
});
