// The fan-out, held to the two Nevers the design track states over it.

import { createFixtureBridge } from "../../../bridge/index.js";
import {
  unscriptedScenario,
  withDaemonCall,
} from "../../../bridge/fixture/fixture-bridge.test-support.js";
import { type SidebarBulkItem } from "../../../seats/index.js";
import { runBulkAct } from "./bulk-runner.js";
import { BulkSelectionModel } from "./bulk-selection.js";

const QUEUE_ITEM_ONE = "9f2c4a10-0000-4000-8000-000000000001";
const QUEUE_ITEM_TWO = "9f2c4a10-0000-4000-8000-000000000002";
const QUEUE_ITEM_THREE = "9f2c4a10-0000-4000-8000-000000000003";
const WORKTREE_ID = "9f2c4a10-0000-4000-8000-000000000020";
const SESSION_ID = "9f2c4a10-0000-4000-8000-0000000000aa";
const INVITE_ID = "9f2c4a10-0000-4000-8000-0000000000bb";

function queuedItem(itemId: string, label: string): SidebarBulkItem {
  return { sectionId: "runs", act: "cancel-queue-item", itemId, label };
}

/** A bridge whose `daemon.call` this suite answers, per method and per request. */
function bridgeAnswering(
  answer: (method: string, params: unknown) => Promise<unknown>,
): ReturnType<typeof withDaemonCall> {
  return withDaemonCall(
    createFixtureBridge({ scenario: unscriptedScenario("sidebar-bulk") }),
    async (call) => await answer(call.method, call.params),
  );
}

describe("running one bulk act", () => {
  it("settles every row on its own reply, and never on one rolled-up answer", async () => {
    // The design track's own case: "a failed item renders its own refusal and never
    // hides the others' success". Two rows succeed, the middle one is refused by the
    // daemon, and all three outcomes are on the model afterwards.
    const model = new BulkSelectionModel();
    const items = [
      queuedItem(QUEUE_ITEM_ONE, "first"),
      queuedItem(QUEUE_ITEM_TWO, "second"),
      queuedItem(QUEUE_ITEM_THREE, "third"),
    ];
    for (const item of items) {
      model.toggle(item);
    }
    const { bridge } = bridgeAnswering(async (method, params) => {
      const queueItemId = (params as { readonly queueItemId: string }).queueItemId;
      if (queueItemId === QUEUE_ITEM_TWO) {
        throw new Error("the item has already been admitted");
      }
      return await Promise.resolve({ queueItemId, state: "canceled" });
    });

    await runBulkAct({ model, bridge, sessionId: SESSION_ID, act: "cancel-queue-item" });

    expect(model.outcomeFor(items[0] as SidebarBulkItem)).toStrictEqual({ state: "done" });
    expect(model.outcomeFor(items[2] as SidebarBulkItem)).toStrictEqual({ state: "done" });
    expect(model.outcomeFor(items[1] as SidebarBulkItem)?.state).toBe("refused");
  });

  it("negative control: a run whose every reply is served refuses nothing", async () => {
    // Without this, a runner that filed a refusal for every row would pass the case
    // above — two `done` rows are what makes the one refusal a per-item outcome.
    const model = new BulkSelectionModel();
    const item = queuedItem(QUEUE_ITEM_ONE, "first");
    model.toggle(item);
    const { bridge } = bridgeAnswering(
      async (_method, params) =>
        await Promise.resolve({
          queueItemId: (params as { readonly queueItemId: string }).queueItemId,
          state: "canceled",
        }),
    );

    await runBulkAct({ model, bridge, sessionId: SESSION_ID, act: "cancel-queue-item" });

    expect(model.outcomeFor(item)).toStrictEqual({ state: "done" });
  });

  it("marks the whole set in flight before the first reply can land", async () => {
    // "Never runs a bulk operation sequentially and silently": the person sees the
    // whole selection move at once, rather than one row at a time with the rest
    // looking untouched.
    const model = new BulkSelectionModel();
    const items = [queuedItem(QUEUE_ITEM_ONE, "first"), queuedItem(QUEUE_ITEM_TWO, "second")];
    for (const item of items) {
      model.toggle(item);
    }
    let statesAtFirstCall: readonly (string | undefined)[] = [];
    const { bridge } = bridgeAnswering(async (_method, params) => {
      if (statesAtFirstCall.length === 0) {
        statesAtFirstCall = items.map((item) => model.outcomeFor(item)?.state);
      }
      return await Promise.resolve({
        queueItemId: (params as { readonly queueItemId: string }).queueItemId,
        state: "canceled",
      });
    });

    await runBulkAct({ model, bridge, sessionId: SESSION_ID, act: "cancel-queue-item" });

    expect(statesAtFirstCall).toStrictEqual(["running", "running"]);
  });

  it("sends one call per row, on the method that row's act names", async () => {
    const model = new BulkSelectionModel();
    model.toggle(queuedItem(QUEUE_ITEM_ONE, "first"));
    model.toggle(queuedItem(QUEUE_ITEM_TWO, "second"));
    const { bridge, calls } = bridgeAnswering(
      async (_method, params) =>
        await Promise.resolve({
          queueItemId: (params as { readonly queueItemId: string }).queueItemId,
          state: "canceled",
        }),
    );

    await runBulkAct({ model, bridge, sessionId: SESSION_ID, act: "cancel-queue-item" });

    expect(calls.map((call) => call.method)).toStrictEqual(["run.queueCancel", "run.queueCancel"]);
  });

  it("touches no row of another act", async () => {
    const model = new BulkSelectionModel();
    const invite: SidebarBulkItem = {
      sectionId: "members",
      act: "revoke-invite",
      itemId: INVITE_ID,
      label: "ada@example.test",
    };
    model.toggle(queuedItem(QUEUE_ITEM_ONE, "first"));
    model.toggle(invite);
    const { bridge, calls } = bridgeAnswering(
      async (_method, params) =>
        await Promise.resolve({
          queueItemId: (params as { readonly queueItemId: string }).queueItemId,
          state: "canceled",
        }),
    );

    await runBulkAct({ model, bridge, sessionId: SESSION_ID, act: "cancel-queue-item" });

    expect(calls).toHaveLength(1);
    expect(model.isSelected(invite)).toBe(true);
  });

  it("sends the session beside the invite, and the worktree alone", async () => {
    // The three acts do not share a request shape, which is why the act table builds
    // each one rather than a single id being handed to a method name.
    const model = new BulkSelectionModel();
    model.toggle({
      sectionId: "members",
      act: "revoke-invite",
      itemId: INVITE_ID,
      label: "ada@example.test",
    });
    model.toggle({
      sectionId: "repos",
      act: "retire-worktree",
      itemId: WORKTREE_ID,
      label: "implementer",
    });
    const { bridge, calls } = bridgeAnswering(async (method) =>
      method === "invite.revoke"
        ? await Promise.resolve({ inviteId: INVITE_ID, state: "revoked" })
        : await Promise.resolve({ worktreeId: WORKTREE_ID, state: "retired" }),
    );

    await runBulkAct({ model, bridge, sessionId: SESSION_ID, act: "revoke-invite" });
    await runBulkAct({ model, bridge, sessionId: SESSION_ID, act: "retire-worktree" });

    expect(calls).toStrictEqual([
      { method: "invite.revoke", params: { sessionId: SESSION_ID, inviteId: INVITE_ID } },
      { method: "repo.worktreeRetire", params: { worktreeId: WORKTREE_ID } },
    ]);
  });

  it("sends nothing at all when the act has no selected rows", async () => {
    const model = new BulkSelectionModel();
    const { bridge, calls } = bridgeAnswering(async () => await Promise.resolve({}));

    await runBulkAct({ model, bridge, sessionId: SESSION_ID, act: "retire-worktree" });

    expect(calls).toStrictEqual([]);
  });
});
