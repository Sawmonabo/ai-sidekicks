// The Runs tab's list: the attention section, the four filters, the note that the list is live
// while the workflow stream is open, `Delete runs older than…` and the runs table. A filter set
// matching nothing is not an empty list: the table gives way to a note in the filters' own words
// with `Clear filters`, and `No runs yet` stands only when there is no run and no filter on. The
// table reads a page at a time, `Load earlier` at its foot reading the next, and a change of
// filters keeps the rows drawn until the new answer replaces them. A page `Load earlier` could
// not read keeps the rows above it, with its error and `Try again` below them.

import type { WorkflowDefinitionSummary } from "@ai-sidekicks/contracts/workflow/definition/methods";
import type {
  WorkflowRunAttentionEntry,
  WorkflowRunAttentionListResponse,
  WorkflowRunSummary,
} from "@ai-sidekicks/contracts/workflow/run/records";

import { LoadingNotice } from "@renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { useSettlementAnnouncement } from "@renderer/hooks/useSettlementAnnouncement.js";
import type { Clock } from "@renderer/lib/clock.js";
import type { Refusal } from "@renderer/lib/refusal/refusal.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import type { PushDrivenReadState } from "@renderer/store/reads/push-driven-read.js";
import { DeleteOlderRuns } from "./components/DeleteOlderRuns.js";
import { RunAttentionSection } from "./components/RunAttentionSection.js";
import { RunFilterBar } from "./components/RunFilterBar.js";
import { RunsTable } from "./components/RunsTable.js";
import type { RunFiltersHold } from "./hooks/useRunFilters.js";
import { useRunTimesNow } from "../hooks/useRunTimesNow.js";
import { isGoing } from "../run-controls.js";
import { NO_RUN_FILTERS, hasRunFilters, noRunMatchSentence } from "./run-filters.js";
import type { RunListAnswer, RunListAsk } from "./run-list-pages.js";
import { runCountWords } from "../workflow-words.js";
import { ActionButton } from "../components/ActionButton.js";

/** What the Runs tab's list is drawn from, and where it leads. */
export interface RunsTabProps {
  /** What the table asks for now; the answer drawn may still be for an earlier ask. */
  readonly listAsk: RunListAsk;
  readonly listState: PushDrivenReadState<RunListAnswer>;
  readonly readListAgain: () => void;
  readonly onLoadEarlier: () => void;
  readonly attentionState: PushDrivenReadState<WorkflowRunAttentionListResponse>;
  readonly readAttentionAgain: () => void;
  readonly definitions: readonly WorkflowDefinitionSummary[];
  /** Why the saved workflows or the accounts the table names could not be read. */
  readonly namingRefusal: Refusal | undefined;
  readonly filters: RunFiltersHold;
  readonly accountLabel: (providerAccountId: string) => string | undefined;
  readonly bridge: PlatformBridge;
  readonly onOpenRun: (workflowRunId: string) => void;
  /** How many runs a person answered since this screen opened. */
  readonly answeredCount: number;
  /** A run address named a run the daemon does not have. */
  readonly isRunMissing: boolean;
  /** The workflow stream is open, so every row moves as its run does. */
  readonly isLive: boolean;
}

/** The Runs tab's list of runs, with what stands above it. */
export function RunsTab(props: RunsTabProps): React.JSX.Element {
  const { filters, listState, attentionState } = props;
  const clock = useClock();
  useSettlementAnnouncement(runsSettlementSentence(listState));
  const attentionEntries =
    attentionState.kind === "loaded" ? attentionState.value.entries : NO_ATTENTION_ENTRIES;
  const runs = listState.kind === "loaded" ? listState.value.response.runs : NO_RUNS;
  const nowMs = useRunTimesNow({
    drawn: [runs, attentionEntries],
    isTicking: runs.some((run) => isGoing(run.status)),
    namesDays: runs.length > 0 || attentionEntries.length > 0,
    isPartOfDayShown:
      attentionState.kind === "loaded" && attentionEntries.length === 0 && props.answeredCount > 0,
  });
  return (
    <div className="meridian-workflows-runs">
      {props.isRunMissing ? (
        <p className="meridian-workflows-runs__missing" role="status">
          That run is not here.
        </p>
      ) : null}
      <RunAttentionSection
        state={attentionState}
        readAgain={props.readAttentionAgain}
        accountLabel={props.accountLabel}
        onOpenRun={props.onOpenRun}
        nowMs={nowMs}
        clock={clock}
        answeredCount={props.answeredCount}
      />
      <div className="meridian-workflows-runs__toolbar">
        <RunFilterBar
          filters={filters.filters}
          definitions={props.definitions}
          onChange={filters.setFilters}
        />
        <span className="meridian-workflows-runs__toolbar-end">
          {props.isLive ? (
            <span className="meridian-workflows-runs__live-note">
              <span className="meridian-workflows-runs__live-note-dot" aria-hidden="true" />
              live through one subscription
            </span>
          ) : null}
          <DeleteOlderRuns bridge={props.bridge} />
        </span>
      </div>
      {props.namingRefusal === undefined ? null : (
        <InlineRefusal code={props.namingRefusal.code} detail={props.namingRefusal.detail} />
      )}
      {filters.lastRefusal === undefined ? null : (
        <InlineRefusal code={filters.lastRefusal.code} detail={filters.lastRefusal.detail} />
      )}
      <RunsList {...props} nowMs={nowMs} clock={clock} />
    </div>
  );
}

/** What the tab ticks against while a read has nothing to draw, one identity across renders. */
const NO_RUNS: readonly WorkflowRunSummary[] = [];
const NO_ATTENTION_ENTRIES: readonly WorkflowRunAttentionEntry[] = [];

function RunsList(
  props: RunsTabProps & { readonly nowMs: number; readonly clock: Clock },
): React.JSX.Element {
  const { listState, listAsk, filters } = props;
  if (listState.kind === "not-loaded") {
    return <LoadingNotice clock={props.clock} placement="block" title="Loading the runs…" />;
  }
  if (listState.kind === "failed") {
    return (
      <Nothing
        kind="error"
        placement="block"
        title="Could not load the runs"
        detail={listState.refusal.detail}
        action={<ActionButton onClick={props.readListAgain}>Try again</ActionButton>}
      />
    );
  }
  // The answer drawn is for the ask it names; until the read for a newer ask lands, its rows and
  // its own filters' words stay on screen rather than giving way to a loading line.
  const { ask, response } = listState.value;
  const isReplacing = ask !== listAsk;
  if (response.runs.length > 0) {
    const isLoadingEarlier =
      isReplacing && ask.filters === listAsk.filters && listAsk.pageCount > ask.pageCount;
    return (
      <div className="meridian-workflows-runs__list" aria-busy={isReplacing}>
        <RunsTable
          runs={response.runs}
          accountLabel={props.accountLabel}
          bridge={props.bridge}
          onOpenRun={props.onOpenRun}
          nowMs={props.nowMs}
        />
        {listState.value.earlierRefusal === undefined ? (
          response.nextCursor === undefined ? null : (
            <ActionButton disabled={isLoadingEarlier} onClick={props.onLoadEarlier}>
              Load earlier
            </ActionButton>
          )
        ) : (
          <Nothing
            kind="error"
            placement="block"
            title="Could not load earlier runs"
            detail={listState.value.earlierRefusal.detail}
            action={<ActionButton onClick={props.readListAgain}>Try again</ActionButton>}
          />
        )}
      </div>
    );
  }
  if (hasRunFilters(ask.filters)) {
    const definitionId = ask.filters.definitionId;
    const workflowName = props.definitions.find(
      (definition) => definition.id === definitionId,
    )?.name;
    return (
      <div className="meridian-workflows-runs__no-match" role="status" aria-busy={isReplacing}>
        <p>{noRunMatchSentence(ask.filters, workflowName)}</p>
        <ActionButton
          onClick={() => {
            filters.setFilters(NO_RUN_FILTERS);
          }}
        >
          Clear filters
        </ActionButton>
      </div>
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="block"
      title="No runs yet"
      detail="A run appears here the moment a workflow starts."
    />
  );
}

/**
 * What a screen reader hears once the runs are read: how many are listed, `No runs yet`, or why
 * they could not be read. A filter matching nothing says so in its own status line instead.
 */
function runsSettlementSentence(listState: PushDrivenReadState<RunListAnswer>): string | undefined {
  switch (listState.kind) {
    case "not-loaded":
      return undefined;
    case "failed":
      return listState.refusal.detail;
    case "loaded": {
      const { ask, response } = listState.value;
      if (response.runs.length > 0) {
        return `${runCountWords(response.totalCount)} listed.`;
      }
      return hasRunFilters(ask.filters) ? undefined : "No runs yet";
    }
  }
}
