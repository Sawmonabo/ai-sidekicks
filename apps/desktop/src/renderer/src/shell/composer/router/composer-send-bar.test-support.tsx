// The send bar's shared scaffolding: one bar, one store, one bridge.
//
// Lives here because five suites mount the SAME bar against the same draft store,
// and the store is the point — the bar renders a draft it does not own, so a helper
// written beside one suite would be a second answer to what "the composer's line"
// is in these cases.

import { render, type RenderResult } from "@testing-library/react";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { RecordedDaemonCall } from "../../../console/bridge/fixture-bridge.test-support.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { SessionStore } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { ProviderCommandEnumeration } from "../commands/provider-command-holder.js";
import { SESSION_ID, STEER_APPLIED } from "./send-router.test-support.js";
import { ComposerSendBar } from "./ComposerSendBar.js";

export function openSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialise({ cursor: 0, entities: [], participantJoinLog: ["participant-you"] });
  return sessionStore;
}

export interface MountedBar {
  readonly result: RenderResult;
  readonly line: HTMLTextAreaElement;
}

export function mountBar(options: {
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
export const TRIPWIRE_DETAIL = "driver.text_neutralization_failed origin=participant_text";

/** A store holding two agents, each with a steerable run that has tripped. */
export function storeWithTwoTrippedAgents(): SessionStore {
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

export function paneFor(agentId: string): ConsolePaneAddress {
  return { kind: "agent-console", entity: { kind: "agent", id: agentId } };
}

/**
 * One mounted bar, and the three things a case does to it.
 *
 * Declared rather than inferred because the shape crosses a module boundary: a
 * reader of a case should be able to see what the harness offers without opening it.
 */
export interface AddressableBar {
  /** The mounted tree, for the cases that query it directly. */
  readonly result: RenderResult;
  /** Re-render the same bar focused at another agent, without remounting. */
  address(agentId: string): void;
  /** The directive line, or a throw naming what was missing. */
  line(): HTMLTextAreaElement;
  /** The resend offer, or `null` where the bar is offering none. */
  resend(): HTMLButtonElement | null;
}

/** One mounted bar whose focused pane the case moves, without remounting it. */
export function mountAddressable(bridge: ConsoleBridge): AddressableBar {
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
