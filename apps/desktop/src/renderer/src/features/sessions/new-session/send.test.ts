// The coalesced send: two calls in order, and what each ending says. `send.ts`
// holds no state, so these cases drive the ladder through a draft that supplies the choices.
// What repeated presses do to one draft is `draft.test.ts`. The counted arm reads
// what reached the wire, since the fixture answers with the same id every time.

import { describe, expect, it } from "vitest";

import {
  countedDraftFor,
  draftFor,
  CREATED_SESSION_ID,
  NEW_SESSION_LEAD,
  PROJECT_REPO_MOUNT,
} from "./draft.test-support.js";

describe("NewSessionDraft — the send", () => {
  it("refuses an empty draft without touching the wire", async () => {
    const result = await draftFor({ scriptsCreate: true }).send();
    expect(result.outcome).toBe("refused");
    expect(result.refusal?.code).toBe("draft-empty");
    expect(result.completedCalls).toStrictEqual([]);
  });

  it("lands both calls when every leg is scripted, and attaches nothing", async () => {
    const counted = countedDraftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    counted.draft.setFirstTurn("Start on the parser.");
    const result = await counted.draft.send();

    // One act, two calls, named in the order made. There is no attach step, and the first
    // message is queued on the session the create returned.
    expect(result.outcome).toBe("sent");
    expect(result.sessionId).toBe(CREATED_SESSION_ID);
    expect(result.completedCalls).toStrictEqual(["session.create", "run.queueCreate"]);
    expect(result.refusal).toBeUndefined();
    expect(counted.calls.map((call) => call.method)).toStrictEqual(["session.create"]);
    expect(counted.firstTurns).toStrictEqual([
      { sessionId: CREATED_SESSION_ID, content: "Start on the parser." },
    ]);
  });

  it("creates a chat led by the named lead, or a session in the chosen project", async () => {
    const chat = countedDraftFor({ scriptsCreate: true });
    chat.draft.setFirstTurn("Start on the parser.");
    await chat.draft.send();
    expect(chat.calls[0]?.params).toMatchObject({
      binding: { kind: "chat" },
      lead: NEW_SESSION_LEAD,
    });

    const project = countedDraftFor({ scriptsCreate: true });
    project.draft.setRepoMount(PROJECT_REPO_MOUNT);
    await project.draft.send();
    expect(project.calls[0]?.params).toMatchObject({
      binding: {
        kind: "project",
        repoMountId: PROJECT_REPO_MOUNT.repoMountId,
        executionMode: PROJECT_REPO_MOUNT.executionMode,
      },
      lead: NEW_SESSION_LEAD,
    });
  });

  it("refuses the turn that could not be queued, without claiming it landed", async () => {
    const draft = draftFor({ scriptsCreate: true });
    draft.setFirstTurn("Start on the parser.");
    const result = await draft.send();

    expect(result.outcome).toBe("partial");
    expect(result.completedCalls).toStrictEqual(["session.create"]);
    expect(result.refusal?.code).toBe("first-turn-failed");
  });

  it("treats a blank first turn as none, and never trims what it sends", async () => {
    // Blankness decides two axes differently: a draft whose only content is whitespace is
    // empty and refuses before any wire call; beside another axis the turn is the missing leg.
    const onlyBlank = draftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    onlyBlank.setFirstTurn("   \n  ");
    expect((await onlyBlank.send()).refusal?.code).toBe("draft-empty");

    const draft = draftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    draft.setRepoMount(PROJECT_REPO_MOUNT);
    draft.setFirstTurn("   \n  ");
    const blank = await draft.send();
    expect(blank.refusal?.code).toBe("first-turn-missing");

    // Negative control for the trim rule: the text reaches the wire as authored, so indented
    // code keeps its shape.
    const indented = "    const parser = build();";
    const counted = countedDraftFor({ scriptsCreate: true, scriptsFirstTurn: true });
    counted.draft.setFirstTurn(indented);
    await counted.draft.send();
    expect(counted.firstTurns[0]?.content).toBe(indented);
  });

  it("keeps the draft when the create itself fails, and names no completed call", async () => {
    const draft = draftFor({ scriptsCreate: false });
    draft.setRepoMount(PROJECT_REPO_MOUNT);
    const result = await draft.send();

    expect(result.outcome).toBe("refused");
    expect(result.sessionId).toBeUndefined();
    expect(result.completedCalls).toStrictEqual([]);
    expect(result.refusal?.code).toBe("session-create-failed");
    // The draft survives a failed send: a person's choices are not lost to a wire being down.
    expect(draft.snapshot().isEmpty).toBe(false);
  });

  it("negative control: the daemon's own message never reaches the person", async () => {
    // Without this, the case above would pass over a refusal that pasted an IPC stack.
    const draft = draftFor({ scriptsCreate: false });
    draft.setRepoMount(PROJECT_REPO_MOUNT);
    const result = await draft.send();
    expect(result.refusal?.detail).not.toContain("scenario");
    expect(result.refusal?.detail).not.toContain("reply-unscripted");
  });
});
