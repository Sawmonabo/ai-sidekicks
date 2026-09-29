// The message line's shared scaffolding: the line and Send, one store, one bridge.
//
// Lives here because the suites mount the SAME pair against the same draft store, and
// the store is the point — the line renders a draft it does not own and Send sends it,
// so a helper written beside one suite would be a second answer to what "the
// composer's line" is in these cases. No product host mounts both; the pair is the
// composition the send cases need.

import { fireEvent, render, type RenderResult } from "@testing-library/react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { bridgeAnswering, type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { ComposerProps, PaneAddress } from "@renderer/console/seats/index.js";
import { ProviderCommandEnumeration } from "../../command-list/provider-command-enumeration.js";
import { SESSION_ID, STEER_APPLIED } from "../send-router.test-support.js";
import { DraftLine } from "./DraftLine.js";
import { SendButton } from "./SendButton.js";
import type { ComposerSendCalls } from "../send-dispatch.js";

export interface MountedDraftLine {
  readonly result: RenderResult;
  readonly line: HTMLTextAreaElement;
  /** The window store the bar escalates into, for a case that reads its banners. */
  readonly frameStore: WindowStore;
}

export function openSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: 0, entities: [] });
  return sessionStore;
}

/** The mounted Send, or a throw naming what was missing. */
export function sendButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(".meridian-composer__primary");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the composer rendered no Send button");
  }
  return button;
}

/** Press the mounted Send, the way a pointer does. */
export function pressSend(container: HTMLElement): void {
  fireEvent.click(sendButton(container));
}

export function mountDraftLine(options: {
  readonly calls: ComposerSendCalls;
  readonly draftStore: DraftStore;
  readonly sessionStore: SessionStore;
  readonly focusedPane?: PaneAddress | undefined;
  readonly commandEnumeration?: ProviderCommandEnumeration;
}): MountedDraftLine {
  const frameStore = new WindowStore();
  const result = render(
    <LineAndSend
      seat={{
        sessionStore: options.sessionStore,
        bridge: inertBridge(),
        draftStore: options.draftStore,
        frameStore,
        route: DEFAULT_ROUTE,
        focusedPane: options.focusedPane,
      }}
      calls={options.calls}
      // The host owns the holder; a bar mounted alone is one nobody opened, which is
      // the state every case here but the discovery one is asserting against.
      commandEnumeration={options.commandEnumeration ?? new ProviderCommandEnumeration()}
    />,
  );
  const line = result.container.querySelector("textarea");
  if (!(line instanceof HTMLTextAreaElement)) {
    throw new Error("the send bar rendered no directive line");
  }
  return { result, line, frameStore };
}

/** The message line alone, as the composer host mounts it: no Send, no calls. */
export function mountLine(options: {
  readonly draftStore: DraftStore;
  readonly sessionStore: SessionStore;
}): MountedDraftLine {
  const frameStore = new WindowStore();
  const result = render(
    <DraftLine
      sessionStore={options.sessionStore}
      bridge={inertBridge()}
      draftStore={options.draftStore}
      frameStore={frameStore}
      route={DEFAULT_ROUTE}
      focusedPane={undefined}
    />,
  );
  const line = result.container.querySelector("textarea");
  if (!(line instanceof HTMLTextAreaElement)) {
    throw new Error("the message line rendered no field");
  }
  return { result, line, frameStore };
}

/** The transport the bar's held state belongs to; every call goes through `calls` instead. */
function inertBridge(): PlatformBridge {
  return bridgeAnswering(async () => undefined).bridge;
}

/** The line beside Send, over one draft store. */
function LineAndSend(props: {
  readonly seat: ComposerProps;
  readonly calls: ComposerSendCalls;
  readonly commandEnumeration: ProviderCommandEnumeration;
}): React.JSX.Element {
  return (
    <>
      <DraftLine {...props.seat} />
      <SendButton
        {...props.seat}
        calls={props.calls}
        commandEnumeration={props.commandEnumeration}
      />
    </>
  );
}

export const FIRST_AGENT_ID = "agent-ada";
export const SECOND_AGENT_ID = "agent-grace";

/** An answering arm that serves a steer and nothing else. */
export async function answerSteer(call: RecordedDaemonCall): Promise<unknown> {
  return call.method === "run.intervene" ? STEER_APPLIED : undefined;
}

export const FIRST_RUN_ID = "2c3d4e5f-6071-4182-8293-a4b5c6d7e8f0";
export const SECOND_RUN_ID = "3d4e5f60-7182-4293-83a4-b5c6d7e8f001";
// The fixed form `neutralization-tripwire.ts` reads, which is what puts the card
// on screen at all. Both agents carry one, so re-addressing moves between two
// tripped targets rather than between a tripped one and no card.
export const TRIPWIRE_DETAIL = "driver.text_neutralization_failed origin=human_text";

/**
 * One mounted bar, and the things a case does to it.
 *
 * Declared rather than inferred because the shape crosses a module boundary: a
 * reader of a case should be able to see what the harness offers without opening it.
 */
export interface AddressableDraftLine {
  /** The mounted tree, for the cases that query it directly. */
  readonly result: RenderResult;
  /** Re-render the same bar focused at another agent, without remounting. */
  address(agentId: string): void;
  /** The directive line, or a throw naming what was missing. */
  line(): HTMLTextAreaElement;
  /** The window store the bar escalates into, for a case that reads its banners. */
  readonly frameStore: WindowStore;
}

/** A store holding two agents, each with a steerable run that has tripped. */
export function storeWithTwoTrippedAgents(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({
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
  });
  return sessionStore;
}

export function paneFor(agentId: string): PaneAddress {
  return { kind: "agents", entity: { kind: "agent", id: agentId } };
}

/** One mounted bar whose focused pane the case moves, without remounting it. */
export function mountAddressable(calls: ComposerSendCalls): AddressableDraftLine {
  const draftStore = new DraftStore({
    maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
  });
  const sessionStore = storeWithTwoTrippedAgents();
  const enumeration = new ProviderCommandEnumeration();
  const frameStore = new WindowStore();
  const bridge = inertBridge();
  const barFor = (agentId: string): React.JSX.Element => (
    <LineAndSend
      seat={{
        sessionStore,
        bridge,
        draftStore,
        frameStore,
        route: DEFAULT_ROUTE,
        focusedPane: paneFor(agentId),
      }}
      calls={calls}
      commandEnumeration={enumeration}
    />
  );
  const result = render(barFor(FIRST_AGENT_ID));
  return {
    result,
    frameStore,
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
  };
}
