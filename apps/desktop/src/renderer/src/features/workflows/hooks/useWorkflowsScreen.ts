import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";
import type {
  WorkflowRunAttentionListResponse,
  WorkflowRunsPauseState,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { PROVIDER_LABELS } from "#renderer/lib/provider-labels.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { ScreenContext } from "#renderer/registries/screens/context.js";
import { sessionRoute, workflowRunsRoute, workflowsRunId } from "#renderer/routing/readers.js";
import { openSessionPane } from "#renderer/store/window/open-session-pane.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { PushDrivenReadState } from "#renderer/store/reads/push-driven.js";
import { useRunFilters, type RunFiltersHold } from "../runs/hooks/useRunFilters.js";
import type { RunListAnswer, RunListAsk } from "../runs/list-pages.js";
import type { WorkflowNoticeFeedState } from "../notice-feed.js";
import type { WorkflowRunComparison } from "../runs/comparison.js";
import {
  createAttentionRead,
  createDefinitionListRead,
  createProviderAccountRead,
  createRunCountRead,
  createRunListRead,
  type WorkflowReadSources,
} from "../reading.js";
import type { WorkflowCommandTarget } from "../command-target.js";
import { useWorkflowCommandTarget } from "./useWorkflowCommandTarget.js";
import { useWorkflowCall, type WorkflowCallState } from "./useWorkflowCall.js";
import { useWorkflowNoticeFeed } from "./useWorkflowNoticeFeed.js";
import { useWorkflowRead } from "./useWorkflowRead.js";

/**
 * What `Next waiting` stands on: the attention read in flight, the read refused, or the next run
 * waiting on a person other than the open one with how many such runs there are.
 */
export type NextWaiting =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "failed"; readonly refusal: Refusal }
  | { readonly kind: "loaded"; readonly workflowRunId: string | undefined; readonly count: number };

/** Everything the workflows screen draws, and the acts its strip and its links take. */
export interface WorkflowsScreenHold {
  readonly sources: WorkflowReadSources;
  /** The run whose page is open, or `undefined` on the list. */
  readonly openRunId: string | undefined;
  readonly feedState: WorkflowNoticeFeedState;
  /** What the runs table asks for now; the answer drawn may still be for an earlier ask. */
  readonly listAsk: RunListAsk;
  readonly listState: PushDrivenReadState<RunListAnswer>;
  /** How many runs there are under no filter, which the tab's count reads. */
  readonly runCountState: PushDrivenReadState<number>;
  readonly readListAgain: () => void;
  /** Read one more page of older runs into the table. */
  readonly loadEarlierRuns: () => void;
  readonly attentionState: PushDrivenReadState<WorkflowRunAttentionListResponse>;
  readonly readAttentionAgain: () => void;
  readonly definitions: readonly WorkflowDefinitionSummary[];
  /**
   * Why the saved workflows or the accounts could not be read, where one could not: the filter
   * then offers no workflow and a cost names its account by id.
   */
  readonly namingRefusal: Refusal | undefined;
  readonly filters: RunFiltersHold;
  readonly accountLabel: (providerAccountId: string) => string | undefined;
  /** An account as a spent line names it, `the Codex account Work`, while the accounts are read. */
  readonly accountNameFor: (providerAccountId: string) => string | undefined;
  /** A saved workflow's current name, while the saved workflows are read and list it. */
  readonly definitionNameFor: (definitionId: string) => string | undefined;
  readonly nextWaiting: NextWaiting;
  readonly pauseAct: WorkflowCallState<WorkflowRunsPauseState>;
  readonly setPaused: (paused: boolean) => void;
  /**
   * How many runs a person answered since this screen opened, each once, on their pages or on a
   * session's question card.
   */
  readonly answeredCount: number;
  readonly isRunMissing: boolean;
  readonly openRun: (workflowRunId: string) => void;
  /** Leave the open run's page for the runs list. */
  readonly backToList: () => void;
  readonly openSession: (sessionId: string) => void;
  /** Open a session with the message a cursor names in view, or at its foot without one. */
  readonly openMessage: (sessionId: string, messageAnchorCursor: string | undefined) => void;
  /** Open the builder over a saved workflow in a session's pane layout. */
  readonly openWorkflow: (sessionId: string, definitionId: string) => void;
  /**
   * Open Review in the run's session on what the run changed between two of its snapshot points.
   * The points ride the pane's address, so a saved layout restores the same comparison.
   */
  readonly openReview: (comparison: WorkflowRunComparison) => void;
  readonly onRunMissing: () => void;
  readonly onAnswered: () => void;
}

/**
 * The workflows screen's state: the one notice feed, the runs list under the person's filters,
 * the count of every run, the attention list, the saved workflows and accounts the screen names,
 * the start hold, and what this sitting has answered. The feed, the runs list and the count live
 * as long as the screen does, so the strip and the list stay drawn while one run's page is open
 * and moving between tabs never reads the list from nothing. The stream, the attention list, the
 * saved workflows and the accounts are opened only while the Runs tab draws them. `nextWaitingAct`
 * is the keyed `Next waiting` act the screen offers while mounted.
 */
export function useWorkflowsScreen(
  context: ScreenContext,
  nextWaitingAct: WorkflowCommandTarget,
): WorkflowsScreenHold {
  const { bridge, frameStore, uiStateStore, route } = context;
  const clock = useClock();
  const isOnRunsTab = route.kind === "workflows" && route.tab === "runs";
  const { feed, state: feedState } = useWorkflowNoticeFeed(bridge, clock, isOnRunsTab);
  const sources = useMemo(() => ({ bridge, clock, feed }), [bridge, clock, feed]);
  const filters = useRunFilters(uiStateStore);
  // How many pages `Load earlier` asked for, under the filters it was pressed on: a change of
  // filters, the person's or the kept record arriving, starts the table again at one page.
  const [pagesAsked, setPagesAsked] = useState({ filters: filters.filters, pageCount: 1 });
  const pageCount = pagesAsked.filters === filters.filters ? pagesAsked.pageCount : 1;
  const listAsk = useMemo(
    () => ({ filters: filters.filters, pageCount }),
    [filters.filters, pageCount],
  );

  // One list read for the screen's life, asking what this ref holds when it reads: a new ask
  // refreshes it in place, so the rows already drawn stay until the new answer replaces them.
  const listAskRef = useRef(listAsk);
  const { read: listRead, state: listState } = useWorkflowRead(bridge, sources, undefined, () =>
    createRunListRead(sources, () => listAskRef.current),
  );
  useEffect(() => {
    if (listAskRef.current === listAsk) {
      return;
    }
    listAskRef.current = listAsk;
    listRead?.refresh("user-request");
  }, [listAsk, listRead]);
  // The count of every run, apart from the filtered list, so the tab's count never moves under
  // the filters.
  const { state: runCountState } = useWorkflowRead(bridge, sources, undefined, () =>
    createRunCountRead(sources),
  );
  // Read only while the Runs tab draws them; the key moving opens or drops each one.
  const runsTabKey = isOnRunsTab ? RUNS_TAB_KEY : undefined;
  const { read: attentionRead, state: attentionState } = useWorkflowRead(
    bridge,
    sources,
    runsTabKey,
    () => (isOnRunsTab ? createAttentionRead(sources) : undefined),
  );
  const { state: definitionsState } = useWorkflowRead(bridge, sources, runsTabKey, () =>
    isOnRunsTab ? createDefinitionListRead(sources) : undefined,
  );
  const { state: accountsState } = useWorkflowRead(bridge, sources, runsTabKey, () =>
    isOnRunsTab ? createProviderAccountRead(bridge, clock) : undefined,
  );

  const openRunId = workflowsRunId(route);
  // `That run is not here.` stands on the list the missing run's address fell back to, and goes
  // as soon as the screen moves anywhere else: a run opened by any route, or another tab.
  const [missingRun, setMissingRun] = useState(false);
  const routePlace = `${String(isOnRunsTab)}/${openRunId ?? ""}`;
  const [shownPlace, setShownPlace] = useState(routePlace);
  if (shownPlace !== routePlace) {
    setShownPlace(routePlace);
    if (missingRun && (openRunId !== undefined || !isOnRunsTab)) {
      setMissingRun(false);
    }
  }
  const [answeredRunIds, setAnsweredRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const countAnswered = useCallback((workflowRunId: string) => {
    setAnsweredRunIds((runIds) =>
      runIds.has(workflowRunId) ? runIds : new Set([...runIds, workflowRunId]),
    );
  }, []);
  // An answer given anywhere, the session's question card included, reaches the stream as its
  // step's one frame carrying the answer; the stream replays nothing, so each is this sitting's.
  useEffect(
    () =>
      feed.onRunSignal((signal) => {
        if (signal.scope === "run" && signal.isAnswered === true) {
          countAnswered(signal.workflowRunId);
        }
      }),
    [feed, countAnswered],
  );

  const accountFor = useCallback(
    (providerAccountId: string) =>
      accountsState.kind === "loaded"
        ? accountsState.value.accounts.find((account) => account.accountId === providerAccountId)
        : undefined,
    [accountsState],
  );
  const accountLabel = useCallback(
    (providerAccountId: string) => accountFor(providerAccountId)?.displayLabel,
    [accountFor],
  );
  const accountNameFor = useCallback(
    (providerAccountId: string) => {
      const account = accountFor(providerAccountId);
      return account === undefined
        ? undefined
        : `the ${PROVIDER_LABELS[account.provider]} account ${account.displayLabel}`;
    },
    [accountFor],
  );
  const definitions = useMemo(
    () => (definitionsState.kind === "loaded" ? definitionsState.value.definitions : []),
    [definitionsState],
  );
  const definitionNameFor = useCallback(
    (definitionId: string) =>
      definitions.find((definition) => definition.id === definitionId)?.name,
    [definitions],
  );
  const openRun = useCallback(
    (workflowRunId: string) => {
      frameStore.navigate(workflowRunsRoute(workflowRunId));
    },
    [frameStore],
  );
  const backToList = useCallback(() => {
    frameStore.navigate(workflowRunsRoute(undefined));
  }, [frameStore]);
  const openSession = useCallback(
    (sessionId: string) => {
      frameStore.navigate({ kind: "session", sessionId });
    },
    [frameStore],
  );
  const openMessage = useCallback(
    (sessionId: string, messageAnchorCursor: string | undefined) => {
      frameStore.navigate(sessionRoute(sessionId, messageAnchorCursor));
    },
    [frameStore],
  );
  const openWorkflow = useCallback(
    (sessionId: string, definitionId: string) => {
      openSessionPane(frameStore, {
        sessionId,
        address: {
          kind: "workflow-builder",
          entity: { kind: "workflow-definition", id: definitionId },
        },
      });
    },
    [frameStore],
  );
  const openReview = useCallback(
    (comparison: WorkflowRunComparison) => {
      // A Review pane already open over the run is focused and re-pointed.
      openSessionPane(frameStore, {
        sessionId: comparison.sessionId,
        address: {
          kind: "diff",
          entity: {
            kind: "workflow-run",
            id: comparison.workflowRunId,
            from: comparison.from,
            to: comparison.to,
          },
        },
      });
    },
    [frameStore],
  );
  const onRunMissing = useCallback(() => {
    setMissingRun(true);
    frameStore.navigate(workflowRunsRoute(undefined));
  }, [frameStore]);
  // A run counts once however many of its steps were answered; the open page is the run answered.
  const onAnswered = useCallback(() => {
    if (openRunId !== undefined) {
      countAnswered(openRunId);
    }
  }, [openRunId, countAnswered]);
  const pause = useWorkflowCall((paused: boolean) =>
    callDaemon(bridge, "workflow.runsPauseSet", { paused }),
  );

  const nextWaiting = nextWaitingOf(attentionState, openRunId);
  useWorkflowCommandTarget(nextWaitingAct, () => {
    if (!isOnRunsTab) {
      return RUNS_TAB_NOT_OPEN_REFUSAL;
    }
    switch (nextWaiting.kind) {
      case "not-loaded":
        return ATTENTION_NOT_LOADED_REFUSAL;
      case "failed":
        return nextWaiting.refusal;
      case "loaded":
        if (nextWaiting.workflowRunId === undefined) {
          return NOTHING_WAITING_REFUSAL;
        }
        openRun(nextWaiting.workflowRunId);
        return undefined;
    }
  });
  return {
    sources,
    openRunId,
    feedState,
    listAsk,
    listState,
    runCountState,
    readListAgain: () => {
      listRead?.refresh("user-request");
    },
    loadEarlierRuns: () => {
      setPagesAsked({ filters: filters.filters, pageCount: pageCount + 1 });
    },
    attentionState,
    readAttentionAgain: () => {
      attentionRead?.refresh("user-request");
    },
    definitions,
    namingRefusal:
      definitionsState.kind === "failed"
        ? definitionsState.refusal
        : accountsState.kind === "failed"
          ? accountsState.refusal
          : undefined,
    filters,
    accountLabel,
    accountNameFor,
    definitionNameFor,
    nextWaiting,
    pauseAct: pause.state,
    setPaused: pause.take,
    answeredCount: answeredRunIds.size,
    isRunMissing: missingRun && openRunId === undefined,
    openRun,
    backToList,
    openSession,
    openMessage,
    openWorkflow,
    openReview,
    onRunMissing,
    onAnswered,
  };
}

/** The key the reads only the Runs tab draws are held under while it is open. */
const RUNS_TAB_KEY = "runs-tab";

/** What `Next waiting` says when no run waits on a person. */
const NOTHING_WAITING_REFUSAL = refuse("workflows", "workflows.nothing_waiting", "Nothing waiting");

/** What `Next waiting` says away from the Runs tab, where what is waiting is not read. */
const RUNS_TAB_NOT_OPEN_REFUSAL = refuse(
  "workflows",
  "workflows.runs_not_open",
  "The Runs tab is not open. Open it and try again.",
);

/** What `Next waiting` says while what is waiting is still being read. */
const ATTENTION_NOT_LOADED_REFUSAL = refuse(
  "workflows",
  "workflows.attention_not_loaded",
  "What is waiting on you is still loading. Try again in a moment.",
);

/** The runs waiting on a person, top of the attention list down, less the one already open. */
function nextWaitingOf(
  attentionState: PushDrivenReadState<WorkflowRunAttentionListResponse>,
  openRunId: string | undefined,
): NextWaiting {
  if (attentionState.kind !== "loaded") {
    return attentionState;
  }
  const waitingOnPerson = attentionState.value.entries.flatMap((entry) =>
    entry.kind === "run" && entry.workflowRunId !== openRunId ? [entry.workflowRunId] : [],
  );
  return { kind: "loaded", workflowRunId: waitingOnPerson[0], count: waitingOnPerson.length };
}
