// The library view's state machine, driven without a DOM. The page test shows what a person
// sees; the property here is about two calls in flight. It shares the page's registry stub.

import { describe, expect, it } from "vitest";

import { AGENT_LIBRARY_REFUSAL_ORIGIN, AgentLibraryView } from "./view.js";
import { RegistryStub, definition } from "./AgentLibrary.test-support.js";

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
    await stub.settle();

    void view.confirmDeletion(REVIEWER.definitionId);
    await stub.settle();
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
    await stub.settle();

    void view.confirmDeletion(REVIEWER.definitionId);
    await stub.settle();
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
    await stub.settle();

    await view.confirmDeletion(REVIEWER.definitionId);
    await stub.settle();
    await view.confirmDeletion(AUDITOR.definitionId);
    await stub.settle();

    expect(stub.deletedIds).toStrictEqual([REVIEWER.definitionId, AUDITOR.definitionId]);
    expect(view.snapshot().refusalByDefinitionId.size).toBe(0);
  });
});

describe("the agent registry view — a delete the daemon rejects", () => {
  it("draws the daemon's refusal on the row and gives the lock back", async () => {
    // A held lock would disable every delete control; an escaped rejection would show nothing.
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
    await stub.settle();

    await view.confirmDeletion(REVIEWER.definitionId);

    expect(view.snapshot().deletingId).toBeUndefined();
    expect(view.snapshot().refusalByDefinitionId.get(REVIEWER.definitionId)?.detail).toBe(
      "the daemon refused the delete",
    );
    await view.confirmDeletion(AUDITOR.definitionId);
    expect(attempts).toStrictEqual([REVIEWER.definitionId, AUDITOR.definitionId]);
    expect(view.snapshot().reading).toStrictEqual({
      kind: "rows",
      rows: expect.arrayContaining([
        expect.objectContaining({ definitionId: REVIEWER.definitionId }),
      ]),
    });
  });
});
