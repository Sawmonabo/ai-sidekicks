// The message line's shared scaffolding: the line and Send over one draft store and one bridge.
// The suites mount the same pair because the line renders a draft it does not own and Send
// sends it; no product host mounts both.

import { fireEvent, render, type RenderResult } from "@testing-library/react";
import { type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import { DEFAULT_ROUTE } from "#renderer/routing/routes.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { SessionStore } from "#renderer/store/session/store.js";
import type { ComposerProps } from "#renderer/registries/composer/registry.js";
import type { PaneAddress } from "#renderer/routing/panes/address.js";
import { SESSION_ID, STEER_APPLIED } from "../send/router.test-support.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { DraftLine } from "./DraftLine.js";
import { agentPane, inertBridge } from "../../Composer.test-support.js";
import { SendButton } from "./SendButton.js";
import type { ComposerSendCalls } from "../send/dispatch.js";
import type { WorkflowStartOperations } from "../../command-list/workflow/start-from-line.js";
import { fixtureWorkflowStartOperations } from "../../command-list/workflow/start-from-line.test-support.js";

/** An initialized, empty session store for the default session. */
export function openSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ cursor: 0, entities: [] });
  return sessionStore;
}

/** Press the mounted Send, the way a pointer does. */
export function pressSend(container: HTMLElement): void {
  fireEvent.click(sendButton(container));
}

/** Mount the line beside Send over the given stores and calls. */
export function mountDraftLine(options: {
  readonly calls: ComposerSendCalls;
  readonly draftStore: DraftStore;
  readonly sessionStore: SessionStore;
  readonly focusedPane?: PaneAddress | undefined;
  /** The workflow calls a typed `/workflow run <name>` makes; an empty catalog by default. */
  readonly workflowStartOperations?: WorkflowStartOperations;
}): MountedDraftLine {
  const frameStore = new WindowStore();
  const result = render(
    <LineAndSend
      composerProps={{
        sessionStore: options.sessionStore,
        bridge: inertBridge(),
        draftStore: options.draftStore,
        frameStore,
        route: DEFAULT_ROUTE,
        focusedPane: options.focusedPane,
      }}
      calls={options.calls}
      workflowStartOperations={options.workflowStartOperations ?? fixtureWorkflowStartOperations()}
    />,
    // A refused send speaks through the announcer, which throws outside its provider.
    { wrapper: LiveAnnouncerProvider },
  );
  const line = result.container.querySelector("textarea");
  if (!(line instanceof HTMLTextAreaElement)) {
    throw new Error("the send bar rendered no draft line");
  }
  return { result, line, frameStore };
}

/** One mounted line and Send, with the stores a case reads. */
interface MountedDraftLine {
  readonly result: RenderResult;
  readonly line: HTMLTextAreaElement;
  /** The window store the bar escalates into, for a case that reads its banners. */
  readonly frameStore: WindowStore;
}

/** The mounted Send, or a throw naming what was missing. */
function sendButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector(".meridian-composer__primary");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("the composer rendered no Send button");
  }
  return button;
}

/** The line beside Send, over one draft store. */
function LineAndSend(props: {
  readonly composerProps: ComposerProps;
  readonly calls: ComposerSendCalls;
  readonly workflowStartOperations: WorkflowStartOperations;
}): React.JSX.Element {
  return (
    <>
      <DraftLine {...props.composerProps} />
      <SendButton
        {...props.composerProps}
        calls={props.calls}
        workflowStartOperations={props.workflowStartOperations}
      />
    </>
  );
}

/** The first agent in `storeWithTwoTrippedAgents`. */
export const FIRST_AGENT_ID = "agent-ada";
/** The second agent in `storeWithTwoTrippedAgents`. */
export const SECOND_AGENT_ID = "agent-grace";

/** An answering arm that serves a steer and nothing else. */
export async function answerSteer(call: RecordedDaemonCall): Promise<unknown> {
  return call.method === "run.intervene" ? STEER_APPLIED : undefined;
}

/** The first agent's steerable run. */
const FIRST_RUN_ID = "2c3d4e5f-6071-4182-8293-a4b5c6d7e8f0";
/** The second agent's steerable run. */
export const SECOND_RUN_ID = "3d4e5f60-7182-4293-83a4-b5c6d7e8f001";
/**
 * The fixed form `text-neutralization.ts` reads, which puts the card on screen. Both agents
 * carry it, so re-addressing moves between two tripped targets.
 */
export const TRIPWIRE_DETAIL = "driver.text_neutralization_failed origin=human_text";

/** One mounted bar and the things a case does to it. */
export interface AddressableDraftLine {
  /** The mounted tree, for the cases that query it directly. */
  readonly result: RenderResult;
  /** Re-render the same bar focused at another agent, without remounting. */
  address(agentId: string): void;
  /** The message line, or a throw naming what was missing. */
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

/** One mounted bar whose focused pane the case moves, without remounting it. */
export function mountAddressable(calls: ComposerSendCalls): AddressableDraftLine {
  const draftStore = new DraftStore({
    maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
  });
  const sessionStore = storeWithTwoTrippedAgents();
  const frameStore = new WindowStore();
  const bridge = inertBridge();
  const workflowStartOperations = fixtureWorkflowStartOperations();
  const barFor = (agentId: string): React.JSX.Element => (
    <LineAndSend
      composerProps={{
        sessionStore,
        bridge,
        draftStore,
        frameStore,
        route: DEFAULT_ROUTE,
        focusedPane: agentPane(agentId),
      }}
      calls={calls}
      workflowStartOperations={workflowStartOperations}
    />
  );
  const result = render(barFor(FIRST_AGENT_ID), { wrapper: LiveAnnouncerProvider });
  return {
    result,
    frameStore,
    address: (agentId: string) => {
      result.rerender(barFor(agentId));
    },
    line: (): HTMLTextAreaElement => {
      const line = result.container.querySelector("textarea");
      if (!(line instanceof HTMLTextAreaElement)) {
        throw new Error("the send bar rendered no draft line");
      }
      return line;
    },
  };
}
