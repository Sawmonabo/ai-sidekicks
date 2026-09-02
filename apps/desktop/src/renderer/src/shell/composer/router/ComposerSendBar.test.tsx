// What the send bar keeps, what it sends, and what it will not send twice.
//
// Every case drives the real bar over the real `SessionStore`, the real
// `DraftStore`, and a bridge whose `daemon.call` is the one thing under the test's
// control — a stand-in controller would let the bar read state the shipped
// composition cannot produce, which is exactly the class of defect these cover.

import { act, fireEvent, render, type RenderResult } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { SessionStore } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/workspace/index.js";
import { ProviderCommandEnumeration } from "../commands/provider-command-holder.js";
import { ComposerSendBar } from "./ComposerSendBar.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const CHANNEL_ID = "1b2c3d4e-5f60-4172-8384-ab5c6d7e8f90";

/** A bridge whose daemon call the case owns. Nothing else here reaches the wire. */
function stubBridge(call: (method: string, params: unknown) => Promise<unknown>): ConsoleBridge {
  return {
    sidekicks: { daemon: { call, subscribe: () => () => undefined } },
    growth: {},
    growthServedOperations: new Set(),
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
}

function openSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return sessionStore;
}

interface MountedBar {
  readonly result: RenderResult;
  readonly line: HTMLTextAreaElement;
}

function mountBar(options: {
  readonly bridge: ConsoleBridge;
  readonly draftStore: DraftStore;
  readonly sessionStore: SessionStore;
  readonly focusedPane?: ConsolePaneAddress | undefined;
  readonly commandEnumeration?: ProviderCommandEnumeration;
}): MountedBar {
  const result = render(
    <ComposerSendBar
      sessionStore={options.sessionStore}
      bridge={options.bridge}
      draftStore={options.draftStore}
      route={DEFAULT_ROUTE}
      focusedPane={options.focusedPane}
      // The host owns the holder; a bar mounted alone is one nobody opened, which is
      // the state every case here but the discovery one is asserting against.
      commandEnumeration={options.commandEnumeration ?? new ProviderCommandEnumeration()}
    />,
  );
  const line = result.container.querySelector("textarea");
  if (!(line instanceof HTMLTextAreaElement)) {
    throw new Error("the send bar rendered no directive line");
  }
  return { result, line };
}

describe("ComposerSendBar — the unsent body lives in the supplied draft store", () => {
  it("restores the text a remount would otherwise have thrown away", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const bridge = stubBridge(async () => undefined);

    const first = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.change(first.line, { target: { value: "half a thought" } });
    first.result.unmount();

    const second = mountBar({ bridge, draftStore, sessionStore });
    expect(second.line.value).toBe("half a thought");
  });

  it("swaps drafts on an address change rather than carrying text to the new target", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const bridge = stubBridge(async () => undefined);

    const onChannel = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.change(onChannel.line, { target: { value: "for the session" } });
    onChannel.result.unmount();

    // A different composer address in the same window: its own key, its own draft.
    const onNamedChannel = mountBar({
      bridge,
      draftStore,
      sessionStore,
      focusedPane: { kind: "timeline", entity: { kind: "channel", id: CHANNEL_ID } },
    });
    expect(onNamedChannel.line.value).toBe("");
    onNamedChannel.result.unmount();

    // …and the first address still holds what was written for it.
    expect(mountBar({ bridge, draftStore, sessionStore }).line.value).toBe("for the session");
  });

  it("clears the draft once the send has settled, and not before", async () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const settle = vi.fn(async () => undefined);

    const { line, result } = mountBar({
      bridge: stubBridge(settle),
      draftStore,
      sessionStore,
    });
    fireEvent.change(line, { target: { value: "ship it" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(line.value).toBe("");
    result.unmount();
    // The negative control for the persistence claim above: a settled send leaves
    // nothing for the next mount to restore.
    expect(mountBar({ bridge: stubBridge(settle), draftStore, sessionStore }).line.value).toBe("");
  });

  it("keeps the body under its key when the daemon refuses the send", async () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = openSessionStore();
    const { line, result } = mountBar({
      bridge: stubBridge(async () => {
        throw Object.assign(new Error("queue is full"), {
          refusal: { code: "ratelimit.exceeded", message: "queue is full" },
        });
      }),
      draftStore,
      sessionStore,
    });

    fireEvent.change(line, { target: { value: "worth keeping" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });

    expect(line.value).toBe("worth keeping");
    expect(result.container.textContent).toContain("queue is full");
  });
});

describe("ComposerSendBar — the store's restart disclosure, once", () => {
  it("says nothing until there is unsent text to say it about", () => {
    const draftStore = new DraftStore();
    const sessionStore = openSessionStore();
    const bridge = stubBridge(async () => undefined);

    const mounted = mountBar({ bridge, draftStore, sessionStore });
    // The default state of every composer in every window, and what the captured
    // pixels hold: an untouched line says nothing about text nobody has typed. On
    // the shipped tree this sentence was in the DOM here, on every composer.
    expect(mounted.result.container.querySelector(".meridian-composer__notice")).toBeNull();

    fireEvent.focus(mounted.line);
    expect(draftStore.restartNoticePending).toBe(false);
    // Armed, still silent: focus alone is not text at risk.
    expect(mounted.result.container.querySelector(".meridian-composer__notice")).toBeNull();

    fireEvent.change(mounted.line, { target: { value: "unsent words" } });
    expect(mounted.result.container.textContent).toContain(draftStore.restartNoticeText);
  });

  it("keeps it to one composer per window, and out of the ones it never armed", () => {
    const draftStore = new DraftStore();
    const sessionStore = openSessionStore();
    const bridge = stubBridge(async () => undefined);

    const first = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.focus(first.line);
    first.result.unmount();

    // Once per window, not once per mount: a second composer takes the disclosure on
    // nowhere, so typing into it says nothing.
    const second = mountBar({ bridge, draftStore, sessionStore });
    fireEvent.focus(second.line);
    fireEvent.change(second.line, { target: { value: "more unsent words" } });
    expect(second.result.container.querySelector(".meridian-composer__notice")).toBeNull();
  });

  it("negative control: a store that owes no disclosure renders none at all", () => {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const mounted = mountBar({
      bridge: stubBridge(async () => undefined),
      draftStore,
      sessionStore: openSessionStore(),
    });
    fireEvent.focus(mounted.line);
    fireEvent.change(mounted.line, { target: { value: "unsent words" } });
    expect(mounted.result.container.querySelector(".meridian-composer__notice")).toBeNull();
  });
});

describe("ComposerSendBar — a resend offer belongs to the target it was written for", () => {
  const FIRST_AGENT_ID = "agent-ada";
  const SECOND_AGENT_ID = "agent-grace";
  const FIRST_RUN_ID = "2c3d4e5f-6071-4182-8293-a4b5c6d7e8f0";
  const SECOND_RUN_ID = "3d4e5f60-7182-4293-83a4-b5c6d7e8f001";
  // The fixed form `neutralization-tripwire.ts` reads, which is what puts the card
  // on screen at all. Both agents carry one, so re-addressing moves between two
  // tripped targets rather than between a tripped one and no card.
  const TRIPWIRE_DETAIL = "driver.text_neutralization_failed origin=participant_text";

  /** A store holding two agents, each with a steerable run that has tripped. */
  function storeWithTwoTrippedAgents(): SessionStore {
    const sessionStore = new SessionStore({ sessionId: SESSION_ID });
    sessionStore.initialise({
      cursor: 0,
      entities: [
        { kind: "agent", id: FIRST_AGENT_ID, body: { name: "Ada", driverName: "claude" } },
        { kind: "agent", id: SECOND_AGENT_ID, body: { name: "Grace", driverName: "claude" } },
        {
          kind: "run",
          id: FIRST_RUN_ID,
          state: "paused",
          body: {
            agentId: FIRST_AGENT_ID,
            runVersion: 3,
            providerFailureDetail: TRIPWIRE_DETAIL,
          },
        },
        {
          kind: "run",
          id: SECOND_RUN_ID,
          state: "paused",
          body: {
            agentId: SECOND_AGENT_ID,
            runVersion: 5,
            providerFailureDetail: TRIPWIRE_DETAIL,
          },
        },
      ],
      participantJoinLog: ["participant-you"],
    });
    return sessionStore;
  }

  function paneFor(agentId: string): ConsolePaneAddress {
    return { kind: "agent-console", entity: { kind: "agent", id: agentId } };
  }

  /** One mounted bar whose focused pane the case moves, without remounting it. */
  function mountAddressable(bridge: ConsoleBridge) {
    const draftStore = new DraftStore({ restartNoticePending: false });
    const sessionStore = storeWithTwoTrippedAgents();
    const enumeration = new ProviderCommandEnumeration();
    const barFor = (agentId: string): React.JSX.Element => (
      <ComposerSendBar
        sessionStore={sessionStore}
        bridge={bridge}
        draftStore={draftStore}
        route={DEFAULT_ROUTE}
        focusedPane={paneFor(agentId)}
        commandEnumeration={enumeration}
      />
    );
    const result = render(barFor(FIRST_AGENT_ID));
    return {
      result,
      address: (agentId: string) => {
        result.rerender(barFor(agentId));
      },
      line: (): HTMLTextAreaElement => {
        const line = result.container.querySelector("textarea");
        if (!(line instanceof HTMLTextAreaElement)) {
          throw new Error("the send bar rendered no directive line");
        }
        return line;
      },
      resend: (): HTMLButtonElement | null => {
        const offer = result.container.querySelector(".meridian-composer__resend");
        return offer instanceof HTMLButtonElement ? offer : null;
      },
    };
  }

  it("withholds the offer under a target the body was not written for", async () => {
    // The defect: the last sent body outlived the address it was sent under, so the
    // second agent's tripwire card offered the first agent's words — and pressing
    // "Send again" sent them there. The card itself still renders; only the offer is
    // gone, which is what `ResendOffer` already does with no body.
    const calls: string[] = [];
    const bar = mountAddressable(
      stubBridge(async (_method, params) => {
        calls.push(JSON.stringify(params));
        return undefined;
      }),
    );

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });
    expect(bar.resend()).not.toBeNull();

    bar.address(SECOND_AGENT_ID);
    expect(bar.result.container.textContent).toContain("driver.text_neutralization_failed");
    expect(bar.resend()).toBeNull();
  });

  it("restores the offer on returning to the address that holds it", async () => {
    // The negative control for the case above: the guard withholds by ADDRESS rather
    // than by "any re-address clears it", so a body is not lost by looking away.
    const bar = mountAddressable(stubBridge(async () => undefined));

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });
    bar.address(SECOND_AGENT_ID);
    expect(bar.resend()).toBeNull();

    bar.address(FIRST_AGENT_ID);
    expect(bar.resend()).not.toBeNull();
  });

  it("resends that body to its own target, once", async () => {
    const sent: unknown[] = [];
    const bar = mountAddressable(
      stubBridge(async (_method, params) => {
        sent.push(params);
        return undefined;
      }),
    );

    fireEvent.change(bar.line(), { target: { value: "keep going on the parser" } });
    await act(async () => {
      fireEvent.keyDown(bar.line(), { key: "Enter" });
    });
    await act(async () => {
      bar.resend()?.click();
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      targetRunId: FIRST_RUN_ID,
      content: "keep going on the parser",
    });
  });
});

describe("ComposerSendBar — one send in flight", () => {
  it("dispatches once for two Enter presses inside one frame", async () => {
    // Both presses run before React re-renders, so both read `status === "idle"`.
    // The controller's synchronous latch is the only thing that can separate them,
    // and this case is the negative control for it: without the latch the stub is
    // called twice and two turns are queued from one intent.
    const settleCalls: string[] = [];
    let releaseFirstCall: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const draftStore = new DraftStore({ restartNoticePending: false });
    const { line } = mountBar({
      bridge: stubBridge(async (method) => {
        settleCalls.push(method);
        await pending;
        return undefined;
      }),
      draftStore,
      sessionStore: openSessionStore(),
    });

    fireEvent.change(line, { target: { value: "once, please" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
      fireEvent.keyDown(line, { key: "Enter" });
    });
    expect(settleCalls).toStrictEqual(["run.queueCreate"]);

    await act(async () => {
      releaseFirstCall();
      await pending;
    });
    expect(settleCalls).toStrictEqual(["run.queueCreate"]);
  });

  it("ignores a press while the call is pending, silently and with no second call", async () => {
    const settleCalls: string[] = [];
    let releaseFirstCall: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const draftStore = new DraftStore({ restartNoticePending: false });
    const { line, result } = mountBar({
      bridge: stubBridge(async (method) => {
        settleCalls.push(method);
        await pending;
        return undefined;
      }),
      draftStore,
      sessionStore: openSessionStore(),
    });

    fireEvent.change(line, { target: { value: "still going" } });
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });
    expect(line.readOnly).toBe(true);

    // A separate frame, so the surface has re-rendered into `sending` — the press
    // is refused by the rendered state rather than by the latch, and refused
    // SILENTLY: nothing was rejected, the person was only early.
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
    });
    expect(settleCalls).toHaveLength(1);
    expect(result.container.querySelector(".meridian-refusal--inline")).toBeNull();

    await act(async () => {
      releaseFirstCall();
      await pending;
    });
    expect(settleCalls).toHaveLength(1);
    expect(line.readOnly).toBe(false);
  });

  it("accepts the next send once the first has settled", async () => {
    // The negative control for the latch itself: it releases in `finally`, so a
    // wedged latch would make the composer send exactly once per window.
    const settleCalls: string[] = [];
    const draftStore = new DraftStore({ restartNoticePending: false });
    const { line } = mountBar({
      bridge: stubBridge(async (method) => {
        settleCalls.push(method);
        return undefined;
      }),
      draftStore,
      sessionStore: openSessionStore(),
    });

    for (const body of ["first", "second"]) {
      fireEvent.change(line, { target: { value: body } });
      await act(async () => {
        fireEvent.keyDown(line, { key: "Enter" });
      });
    }
    expect(settleCalls).toHaveLength(2);
  });
});
