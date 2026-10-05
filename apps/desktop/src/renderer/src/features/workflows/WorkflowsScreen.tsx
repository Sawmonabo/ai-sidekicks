// The rail's workflows screen. `#/workflows` names the Workflows tab, which is not built, so it
// draws the tab row alone: an unbuilt surface is absent, never stood in for. `#/workflows/runs`
// draws the Runs tab — the list of runs, or one run's page at `#/workflows/runs/<runId>` — under
// the tab's own strip, which stays drawn on both. An address naming a run the daemon does not
// have opens the list with one line saying so.

import "./WorkflowsScreen.css";

import type { ScreenContext } from "@renderer/registries/screens/screen-context.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { RunsStrip } from "./components/RunsStrip.js";
import { useWorkflowsScreen } from "./hooks/useWorkflowsScreen.js";
import { RunPage } from "./run-page/RunPage.js";
import { RunsTab } from "./runs/RunsTab.js";

/** The workflows screen at the committed route. */
export function WorkflowsScreen(props: { readonly context: ScreenContext }): React.JSX.Element {
  const screen = useWorkflowsScreen(props.context);
  const { listState, openRunId } = screen;
  const { route } = props.context;
  const isOnRunsTab = route.kind === "workflows" && route.tab === "runs";
  return (
    <div className="meridian-workflows-destination">
      <nav className="meridian-workflows-tabs" aria-label="Workflows">
        <a
          className="meridian-workflows-tabs__tab"
          href="#/workflows/runs"
          aria-current={isOnRunsTab ? "page" : undefined}
        >
          Runs
          {listState.kind === "loaded" ? (
            <span className="meridian-workflows-tabs__count">
              {formatCount(listState.value.response.totalCount)}
            </span>
          ) : null}
        </a>
      </nav>
      {isOnRunsTab ? (
        <>
          <RunsStrip
            nextWaiting={screen.nextWaiting}
            readAttentionAgain={screen.readAttentionAgain}
            isRunPageOpen={openRunId !== undefined}
            onOpenRun={screen.openRun}
            feedState={screen.feedState}
            pauseAct={screen.pauseAct}
            onSetPaused={screen.setPaused}
          />
          {openRunId === undefined ? (
            <RunsTab
              listAsk={screen.listAsk}
              listState={listState}
              readListAgain={screen.readListAgain}
              onLoadEarlier={screen.loadEarlierRuns}
              attentionState={screen.attentionState}
              readAttentionAgain={screen.readAttentionAgain}
              definitions={screen.definitions}
              namingRefusal={screen.namingRefusal}
              filters={screen.filters}
              accountLabel={screen.accountLabel}
              bridge={screen.sources.bridge}
              onOpenRun={screen.openRun}
              answeredCount={screen.answeredCount}
              isRunMissing={screen.isRunMissing}
              isLive={screen.feedState.kind === "open"}
            />
          ) : (
            <RunPage
              key={openRunId}
              sources={screen.sources}
              workflowRunId={openRunId}
              definitionNameFor={screen.definitionNameFor}
              accountLabel={screen.accountLabel}
              onOpenRun={screen.openRun}
              onBackToList={screen.backToList}
              onOpenSession={screen.openSession}
              onOpenMessage={screen.openMessage}
              onOpenWorkflow={screen.openWorkflow}
              onOpenReview={screen.openReview}
              onRunMissing={screen.onRunMissing}
              onAnswered={screen.onAnswered}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
