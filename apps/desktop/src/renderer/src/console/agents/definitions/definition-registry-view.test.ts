// The carrier behind the agent definitions page, driven without a DOM.
//
// The page's own file asserts what a person sees; this one asserts the state machine
// underneath, because the property that matters here is about two calls in flight and
// a rendered surface can only show the second half of it. The registry stub, the
// records, and the flush are the page's own — one home per role, and a view test
// that hand-rolled a second registry would be asserting against calls no window makes.

import { describe, expect, it } from "vitest";

import { AGENT_REGISTRY_REFUSAL_ORIGIN, AgentRegistryView } from "./definition-registry-view.js";
import { RegistryStub, definition, settle } from "./agent-definitions-page.test-support.js";

const REVIEWER = definition();
const AUDITOR = definition({ definitionId: "definition-2", name: "Auditor" });

/** A view over a registry holding both records, with every delete held open. */
function viewOverHeldDeletes(): {
  readonly view: AgentRegistryView;
  readonly stub: RegistryStub;
} {
  const stub = new RegistryStub({
    lists: [[REVIEWER, AUDITOR], [AUDITOR]],
    holdsDeletes: true,
  });
  return { view: new AgentRegistryView(stub.bridge, stub.calls), stub };
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
    expect(refusal?.origin).toBe(AGENT_REGISTRY_REFUSAL_ORIGIN);
    expect(refusal?.detail).toContain("Another sidekick is being deleted");
    // The running delete is untouched: it still owns the lock and its row still
    // renders as the one going.
    expect(view.snapshot().deletingId).toBe(REVIEWER.definitionId);
  });

  it("still re-reads for the delete that was running when the second was refused", async () => {
    // The defect this replaces. Under a generation counter the second confirm
    // superseded the first, so the first's settlement was discarded, its re-read
    // never ran, and the record the registry really did remove stayed on the screen
    // for the life of the page — explained only by the OTHER row's refusal.
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

  it("says a different sentence when the row already going is pressed again", async () => {
    // Same code, different next move: their own record is already on its way out,
    // and telling them another one is in the way would be false.
    const { view, stub } = viewOverHeldDeletes();
    view.start();
    await settle();

    void view.confirmDeletion(REVIEWER.definitionId);
    await settle();
    await view.confirmDeletion(REVIEWER.definitionId);

    expect(stub.deletedIds).toStrictEqual([REVIEWER.definitionId]);
    expect(view.snapshot().refusalByDefinitionId.get(REVIEWER.definitionId)?.detail).toContain(
      "This sidekick is already being deleted",
    );
  });

  it("negative control: with nothing running, a second row's delete IS performed", async () => {
    // Without this, the cases above would pass over a carrier that refused every
    // delete after the first for the life of the page — which would leave a person
    // unable to delete anything else without reloading the window.
    const stub = new RegistryStub({
      lists: [[REVIEWER, AUDITOR], [AUDITOR], []],
    });
    const view = new AgentRegistryView(stub.bridge, stub.calls);
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
    // A held lock would leave every delete control disabled for the life of the page,
    // and a caught rejection would show the person nothing went wrong.
    const stub = new RegistryStub({ lists: [[REVIEWER, AUDITOR]] });
    const attempts: string[] = [];
    const view = new AgentRegistryView(stub.bridge, {
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
