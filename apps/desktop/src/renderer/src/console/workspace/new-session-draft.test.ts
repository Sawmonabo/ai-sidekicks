// The new-session draft, and the honest ending of a send it cannot finish.
//
// §4.8 asks for a draft that is local until it is sent, and for a send that names
// the calls that succeeded. Two of the three calls that send needs are registered
// nowhere in the contracts package, so the interesting case is not the happy path:
// it is that a send which creates a session and then cannot attach anything says
// so, names `session.create` as done, and leaves the draft on screen.
//
// The second interesting case follows from the first. That partial leaves the draft
// non-empty and Send pressable, so the class has to survive being pressed again —
// and the fixture engine answers `session.create` with the same scripted id every
// time, which means a second session is indistinguishable from the first BY ITS
// RESULT. These cases therefore count the calls that reached the wire rather than
// comparing ids: the count is the only reading that tells one session from two.

import { describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../bridge/index.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { NewSessionDraft } from "./new-session-draft.js";

const CREATED_SESSION_ID = "session-created-1";

/** The one method the draft sends, named here so a count reads as what it counts. */
const SESSION_CREATE_METHOD = "session.create";

function scenario(options: { readonly scriptsCreate: boolean }): ConsoleScenario {
  return {
    id: "draft-send",
    label: "Draft send",
    purpose: "Drives the new-session draft's one reachable wire call.",
    sessionId: "session-draft",
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T09:00:00.000Z",
    beats: [],
    replies: options.scriptsCreate
      ? [{ call: "session.create", result: { sessionId: CREATED_SESSION_ID } }]
      : [],
  };
}

function draftFor(options: { readonly scriptsCreate: boolean }): NewSessionDraft {
  return new NewSessionDraft({ bridge: createFixtureBridge({ scenario: scenario(options) }) });
}

/** A draft plus a tally of what reached the wire behind it. */
interface CountedDraft {
  readonly draft: NewSessionDraft;
  /** Every method name `daemon.call` was given, in order. */
  readonly calls: readonly string[];
}

/**
 * A draft over the real fixture bridge, with `daemon.call` counted on the way past.
 *
 * A wrapper around the fixture's own door rather than a stub of it: the draft's one
 * wire call has to go through the same `resolveScriptedReply` every other case here
 * exercises, or the count would be a count of a different implementation.
 */
function countedDraftFor(options: { readonly scriptsCreate: boolean }): CountedDraft {
  const fixture = createFixtureBridge({ scenario: scenario(options) });
  const calls: string[] = [];
  const bridge: ConsoleBridge = {
    ...fixture,
    sidekicks: {
      ...fixture.sidekicks,
      daemon: {
        ...fixture.sidekicks.daemon,
        call: (async (method: string, params: unknown) => {
          calls.push(method);
          return await (
            fixture.sidekicks.daemon.call as (method: string, params: unknown) => Promise<unknown>
          )(method, params);
        }) as ConsoleBridge["sidekicks"]["daemon"]["call"],
      },
    },
  };
  return { draft: new NewSessionDraft({ bridge }), calls };
}

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

describe("NewSessionDraft — the send", () => {
  it("refuses an empty draft without touching the wire", async () => {
    const result = await draftFor({ scriptsCreate: true }).send();
    expect(result.outcome).toBe("refused");
    expect(result.refusal?.code).toBe("draft-empty");
    expect(result.completedCalls).toStrictEqual([]);
  });

  it("creates the session, then says which calls it could not make", async () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.selectAgent({ definitionId: "definition-1", providerAccountId: undefined });
    const result = await draft.send();

    expect(result.outcome).toBe("partial");
    expect(result.sessionId).toBe(CREATED_SESSION_ID);
    // §4.8: the error slot names the calls that SUCCEEDED, because a person
    // deciding whether to retry needs to know a session already exists.
    expect(result.completedCalls).toStrictEqual(["session.create"]);
    expect(result.refusal?.code).toBe("wire-unregistered");
    expect(result.refusal?.detail).toContain("agent.attach");
    expect(result.refusal?.detail).toContain("run.queueCreate");
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

describe("NewSessionDraft — one draft object, at most one session", () => {
  it("coalesces two synchronous presses into one create and one result", async () => {
    const { draft, calls } = countedDraftFor({ scriptsCreate: true });
    draft.setPosture("trusted");

    // Not awaited between the two: this is the double-click, where the second press
    // lands while the first send is still in flight.
    const [first, second] = await Promise.all([draft.send(), draft.send()]);

    expect(calls).toStrictEqual([SESSION_CREATE_METHOD]);
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
    // What a person does after reading `wire-unregistered`: change nothing, press
    // again. That is a retry of the send, not a request for a second session.
    const retried = await draft.send();

    expect(calls).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(retried.sessionId).toBe(first.sessionId);
    expect(retried.completedCalls).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(retried.refusal?.code).toBe("wire-unregistered");
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

    expect(second.calls).toStrictEqual([SESSION_CREATE_METHOD]);
  });

  it("negative control: a single press still reaches the wire exactly once", async () => {
    // Without this, a build that had stopped calling `session.create` at all would
    // satisfy every count above — zero is not two.
    const { draft, calls } = countedDraftFor({ scriptsCreate: true });
    draft.setPosture("trusted");

    const result = await draft.send();

    expect(calls).toStrictEqual([SESSION_CREATE_METHOD]);
    expect(result.sessionId).toBe(CREATED_SESSION_ID);
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
    expect(calls).toStrictEqual([SESSION_CREATE_METHOD, SESSION_CREATE_METHOD]);
  });
});
