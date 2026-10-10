// The rail's workflows screen. `#/workflows` names the Workflows tab, which is not built, so it
// draws the tab row alone: an unbuilt surface is absent, never stood in for. `#/workflows/runs`
// draws the Runs tab — the list of runs, or one run's page at `#/workflows/runs/<runId>` — under
// the tab's own strip, which stays drawn on both. An address naming a run the daemon does not
// have opens the list with one line saying so. Before the background service first answers the
// screen draws its tab row alone, with no count, and reads nothing.

import "./WorkflowsScreen.css";

import type { ScreenContext } from "#renderer/registries/screens/context.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { RunsStrip } from "./components/RunsStrip.js";
import { WorkflowCommandTargetsContext, type WorkflowCommandTargets } from "./command-target.js";
import { useWorkflowsScreen } from "./hooks/useWorkflowsScreen.js";
import { RunPage } from "./runs/page/RunPage.js";
import { RunsTab } from "./runs/RunsTab.js";

/** The workflows screen at the committed route, offering `commandTargets` to all it draws. */
export function WorkflowsScreen(props: {
  readonly context: ScreenContext;
  readonly commandTargets: WorkflowCommandTargets;
}): React.JSX.Element {
  return props.context.hasServiceAnswered ? (
    <AnsweredWorkflowsScreen context={props.context} commandTargets={props.commandTargets} />
  ) : (
    <WorkflowsDestination route={props.context.route} runCount={undefined} />
  );
}

/** The screen once the service has answered: the tab row over the Runs tab's reads. */
function AnsweredWorkflowsScreen(props: {
  readonly context: ScreenContext;
  readonly commandTargets: WorkflowCommandTargets;
}): React.JSX.Element {
  const screen = useWorkflowsScreen(props.context, props.commandTargets.nextWaiting);
  const { listState, runCountState, openRunId } = screen;
  const { route } = props.context;
  return (
    <WorkflowCommandTargetsContext.Provider value={props.commandTargets}>
      <WorkflowsDestination
        route={route}
        runCount={runCountState.kind === "loaded" ? runCountState.value : undefined}
      >
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
            runCountState={runCountState}
            readListAgain={screen.readListAgain}
            onLoadEarlier={screen.loadEarlierRuns}
            attentionState={screen.attentionState}
            readAttentionAgain={screen.readAttentionAgain}
            definitions={screen.definitions}
            namingRefusal={screen.namingRefusal}
            filters={screen.filters}
            payerOf={screen.payerOf}
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
            payerOf={screen.payerOf}
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
      </WorkflowsDestination>
    </WorkflowCommandTargetsContext.Provider>
  );
}

/** The destination's frame: the tab row, with the Runs count once read, over the Runs tab. */
function WorkflowsDestination(props: {
  readonly route: AppRoute;
  readonly runCount: number | undefined;
  /** The Runs tab's strip and list or page, drawn only on that tab. */
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  const isOnRunsTab = props.route.kind === "workflows" && props.route.tab === "runs";
  const destinationScrollbarRef = useDrawOverlayScrollbar<HTMLDivElement>();
  return (
    <div className="meridian-workflows-destination" ref={destinationScrollbarRef}>
      <nav className="meridian-workflows-tabs" aria-label="Workflows">
        <a
          className="meridian-workflows-tabs__tab"
          href="#/workflows/runs"
          aria-current={isOnRunsTab ? "page" : undefined}
        >
          Runs
          {props.runCount === undefined ? null : (
            <span className="meridian-workflows-tabs__count">
              <WireFigure value={formatCount(props.runCount)} />
            </span>
          )}
        </a>
      </nav>
      {isOnRunsTab ? props.children : null}
    </div>
  );
}
