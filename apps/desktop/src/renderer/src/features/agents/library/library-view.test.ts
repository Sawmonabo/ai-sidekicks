// The library view's state machine, driven without a DOM. The page test shows what a person
// sees; the property here is about two calls in flight. It shares the page's registry stub.

import { describe, expect, it } from "vitest";

import { AGENT_LIBRARY_REFUSAL_ORIGIN, AgentLibraryView } from "./library-view.js";
import { RegistryStub, definition, settle } from "./agent-library.test-support.js";

const REVIEWER = definition();
const AUDITOR = definition({ definitionId: "definition-2", name: "Auditor" });

/** A view over a registry holding both records, with every delete held open. */
function viewOverHeldDeletes(): {
  readonly view: AgentLibraryView;
  readonly stub: RegistryStub;
} {
  const stub = new RegistryStub({
    lists: [[REVIEWER, AUDITOR], [AUDITOR]],
    holdsDeletes: true,
  });
  return { view: new AgentLibraryView(stub.clock, stub.calls), stub };
}

describe("the agent registry view — one delete at a time", () => {
  it("asks the registry once, and tells the second row what is in the way", async () => {
    const { view, stub } = viewOverHeldDeletes();
    view.start();
    await settle();

    void view.confirmDeletion(REVIEWER.definitionId);
    await settle();
    await view.confirmDeletion(AUDITOR.definitionId);

    expect(stub.deletedIds).toStrictEqual([REVIEWER.definitionId]);
    const refusal = view.snapshot().refusalByDefinitionId.get(AUDITOR.definitionId);
    expect(refusal?.code).toBe("delete-already-running");
    expect(refusal?.origin).toBe(AGENT_LIBRARY_REFUSAL_ORIGIN);
    expect(refusal?.detail).toContain("Another sidekick is being deleted");
    // The running delete still owns the lock.
    expect(view.snapshot().deletingId).toBe(REVIEWER.definitionId);
  });

  it("still re-reads for the delete that was running when the second was refused", async () => {
    // If a second confirm superseded the first, the first's re-read would never run and the
    // removed record would stay on screen.
    const { view, stub } = viewOverHeldDeletes();
    view.start();
    await settle();

    void view.confirmDeletion(REVIEWER.definitionId);
    await settle();
    await view.confirmDeletion(AUDITOR.definitionId);
    await stub.releaseDeletes();

    expect(stub.listCallCount).toBe(2);
    const { reading } = view.snapshot();
    expect(reading.kind).toBe("rows");
    expect(
      reading.kind === "rows" ? reading.rows.map((row) => row.definitionId) : [],
    ).toStrictEqual([AUDITOR.definitionId]);
    expect(view.snapshot().deletingId).toBeUndefined();
  });

  it("negative control: with nothing running, a second row's delete IS performed", async () => {
    // Guards against a view that refuses every delete after the first.
    const stub = new RegistryStub({
      lists: [[REVIEWER, AUDITOR], [AUDITOR], []],
    });
    const view = new AgentLibraryView(stub.clock, stub.calls);
    view.start();
    await settle();

    await view.confirmDeletion(REVIEWER.definitionId);
    await settle();
    await view.confirmDeletion(AUDITOR.definitionId);
    await settle();

    expect(stub.deletedIds).toStrictEqual([REVIEWER.definitionId, AUDITOR.definitionId]);
    expect(view.snapshot().refusalByDefinitionId.size).toBe(0);
  });
});

describe("the agent registry view — a delete the daemon rejects", () => {
  it("surfaces the rejection and gives the lock back so the next delete is performed", async () => {
    // A held lock would disable every delete control; a caught rejection would hide the failure.
    const stub = new RegistryStub({ lists: [[REVIEWER, AUDITOR]] });
    const attempts: string[] = [];
    const view = new AgentLibraryView(stub.clock, {
      listDefinitions: stub.calls.listDefinitions,
      deleteDefinition: async (request) => {
        attempts.push(request.definitionId);
        throw new Error("the daemon refused the delete");
      },
    });
    view.start();
    await settle();

    await expect(view.confirmDeletion(REVIEWER.definitionId)).rejects.toThrow(
      "the daemon refused the delete",
    );

    expect(view.snapshot().deletingId).toBeUndefined();
    await expect(view.confirmDeletion(AUDITOR.definitionId)).rejects.toThrow(
      "the daemon refused the delete",
    );
    expect(attempts).toStrictEqual([REVIEWER.definitionId, AUDITOR.definitionId]);
    expect(view.snapshot().refusalByDefinitionId.size).toBe(0);
  });
});
