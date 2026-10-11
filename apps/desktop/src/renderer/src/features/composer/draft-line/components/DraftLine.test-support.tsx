// The message line's shared scaffolding: the line and Send over one draft store and one bridge.
// The suites mount the same pair because the line renders a draft it does not own and Send
// sends it; no product host mounts both.

import { START_OF_LOG_POSITION } from "@ai-sidekicks/contracts/session/event-cursor";
import { act, fireEvent, render, type RenderResult } from "@testing-library/react";
import { type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import { DEFAULT_ROUTE } from "#renderer/routing/routes.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import { WindowStore } from "#renderer/store/window/store.js";
import { SessionStore } from "#renderer/store/session/store.js";
import type { ComposerProps } from "#renderer/registries/composer/registry.js";
import { RUN_LIFECYCLE_PROJECTORS } from "#renderer/store/session/events/run/lifecycle-projector.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { QUEUE_CREATED, SESSION_ID } from "../send/router.test-support.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { DraftLine } from "./DraftLine.js";
import { inertBridge } from "../../Composer.test-support.js";
import {
  composeSessionCreatedPayload,
  type ScenarioAgent,
} from "#fixtures/data/opening-entries.js";
import { composeScriptBeats, createRunEntryBuilders } from "#fixtures/data/script-entries.js";
import { SendButton } from "./SendButton.js";
import type { ComposerSendCalls } from "../send/dispatch.js";
import type { WorkflowStartOperations } from "../../command-list/workflow/start-from-line.js";
import { fixtureWorkflowStartOperations } from "../../command-list/workflow/start-from-line.test-support.js";

/** An initialized, empty session store for the default session. */
export function openSessionStore(): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ shape: "project", cursor: 0, entities: [] });
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
  const button = container.querySelector(".meridian-composer__send-icon");
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

/** The session's lead in `mountOverLead`. */
const LEAD: ScenarioAgent = {
  agentId: "4d5e6f70-8192-4a3b-9c4d-5e6f708192a3",
  name: "Ada",
  driverName: "claude",
  modelId: "opus",
};

/** The lead's run, which a case starts and settles. */
const LEAD_RUN_ID = "2c3d4e5f-6071-4182-8293-a4b5c6d7e8f0";

/** The run-transition builders, bound to the session. */
const run = createRunEntryBuilders(SESSION_ID);

/** The instant the lead's session opens, in epoch milliseconds. */
const OPENED_AT_MS: number = Date.UTC(2026, 0, 1, 11, 0);

/**
 * The lead's session as its log tells it: opened with the lead, then the lead's run born, started,
 * running, and settled. The first beat is played at mount; a case plays the rest.
 */
const LEAD_SESSION_BEATS = composeScriptBeats({
  sessionId: SESSION_ID,
  eventIdStem: "4e5f6071-8293-4a4b-9c5d-6e7f8091",
  startedAtMs: OPENED_AT_MS,
  entries: [
    {
      atMs: 0,
      kind: "session.created",
      payload: composeSessionCreatedPayload({
        sessionId: SESSION_ID,
        shape: "project",
        openedBy: "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f",
        lead: LEAD,
        createdAt: new Date(OPENED_AT_MS).toISOString(),
      }),
    },
    run.transition(LEAD_RUN_ID, {
      atMs: 100,
      runVersion: 1,
      newState: "queued",
      agentId: LEAD.agentId,
    }),
    run.transition(LEAD_RUN_ID, {
      atMs: 200,
      runVersion: 2,
      previousState: "queued",
      newState: "starting",
    }),
    run.transition(LEAD_RUN_ID, {
      atMs: 300,
      runVersion: 3,
      previousState: "starting",
      newState: "running",
    }),
    run.transition(LEAD_RUN_ID, {
      atMs: 400,
      runVersion: 4,
      previousState: "running",
      newState: "completed",
      completionKind: "turn",
    }),
  ],
}).map((beat) => beat.event as ProjectedSessionEvent);

/** How many of `LEAD_SESSION_BEATS` take the lead's run from nothing to `running`. */
const LEAD_RUN_START_END = 4;

/** One mounted line and Send over the lead's session, and what a case does to the lead's run. */
export interface LeadDraftLine {
  /** The mounted tree, for the cases that query it directly. */
  readonly result: RenderResult;
  /** The message line, or a throw naming what was missing. */
  line(): HTMLTextAreaElement;
  /** Play the lead's run from its birth to `running`: the composer is addressed at it. */
  startLeadRun(): void;
  /** Settle the lead's run: the composer is addressed at the session again. */
  settleLeadRun(): void;
}

/** An answering arm that queues a message and serves nothing else. */
export async function answerQueued(call: RecordedDaemonCall): Promise<unknown> {
  return call.method === "run.queueCreate" ? QUEUE_CREATED : undefined;
}

/**
 * One mounted line and Send over a session whose lead has no run yet, whose run the case starts
 * and settles without remounting the line.
 */
export function mountOverLead(calls: ComposerSendCalls): LeadDraftLine {
  const sessionStore = new SessionStore({
    sessionId: SESSION_ID,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  // The script numbers its beats from 0, so the store starts before the first.
  sessionStore.initialize({ shape: "project", cursor: START_OF_LOG_POSITION, entities: [] });
  sessionStore.applyBatch(LEAD_SESSION_BEATS.slice(0, 1));
  const result = render(
    <LineAndSend
      composerProps={{
        sessionStore,
        bridge: inertBridge(),
        draftStore: new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT }),
        frameStore: new WindowStore(),
        route: DEFAULT_ROUTE,
      }}
      calls={calls}
      workflowStartOperations={fixtureWorkflowStartOperations()}
    />,
    { wrapper: LiveAnnouncerProvider },
  );
  const play = (beats: readonly ProjectedSessionEvent[]): void => {
    act(() => {
      sessionStore.applyBatch(beats);
    });
  };
  return {
    result,
    line: (): HTMLTextAreaElement => {
      const line = result.container.querySelector("textarea");
      if (!(line instanceof HTMLTextAreaElement)) {
        throw new Error("the send bar rendered no draft line");
      }
      return line;
    },
    startLeadRun: () => {
      play(LEAD_SESSION_BEATS.slice(1, LEAD_RUN_START_END));
    },
    settleLeadRun: () => {
      play(LEAD_SESSION_BEATS.slice(LEAD_RUN_START_END));
    },
  };
}
