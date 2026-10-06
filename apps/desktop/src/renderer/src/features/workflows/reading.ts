// The reads the workflows screens draw from, each a `PushDrivenRead` refreshed by the one notice
// feed: the runs table under its filters, the count of every run, the attention list, the saved
// workflows the filter names, the accounts that pay, and one run's record. Every call goes through `callDaemon`, so
// each reply is parsed against its method's registered shape; a refusal rejects the read and
// becomes its failed state.

import type { ProviderAccountListResponse } from "@ai-sidekicks/contracts/provider/account/record";
import type { WorkflowDefinitionListResponse } from "@ai-sidekicks/contracts/workflow/definition/methods";
import type { WorkflowRunId } from "@ai-sidekicks/contracts/workflow/run/status";
import type {
  WorkflowRunAttentionListResponse,
  WorkflowRunListResponse,
  WorkflowRunReadResponse,
  WorkflowRunSummary,
} from "@ai-sidekicks/contracts/workflow/run/records";

import type { Clock } from "#renderer/lib/clock.js";
import { compareInstants, parseInstant } from "#renderer/lib/instant.js";
import { callDaemon, type DaemonReply } from "#renderer/services/daemon/daemon-reply.js";
import { PROVIDER_ACCOUNT_NOTICE_STREAM } from "#shared/daemon/streams.js";
import { unwrapDaemonReply } from "#renderer/services/daemon/unwrap-daemon-reply.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { openReopeningSubscription } from "#renderer/services/transport/reopening-subscription.js";
import { PushDrivenRead } from "#renderer/store/reads/push-driven-read.js";
import { runListRequestFor } from "./runs/run-filters.js";
import { RUNS_PAGE_SIZE, type RunListAnswer, type RunListAsk } from "./runs/list-pages.js";
import type { WorkflowNoticeFeed } from "./workflow-notice-feed.js";

/** What every workflows read is built over: the daemon, the clock and the notice feed. */
export interface WorkflowReadSources {
  readonly bridge: PlatformBridge;
  readonly clock: Clock;
  readonly feed: WorkflowNoticeFeed;
}

/**
 * How many runs there are under no filter at all, the figure the Runs tab's count reads, so what
 * stands above the table never moves under its filters. One `workflow.runList` call asking for a
 * single row answers it, since the reply carries the total, read again whenever any run moves.
 */
export function createRunCountRead(sources: WorkflowReadSources): PushDrivenRead<number> {
  const { bridge, clock, feed } = sources;
  return new PushDrivenRead({
    clock,
    origin: "workflow-run-count",
    read: async (signal) =>
      unwrapDaemonReply(await callDaemon(bridge, "workflow.runList", { limit: 1 }, { signal }))
        .totalCount,
    subscribe: (onChange) => feed.onRunSignal(onChange),
  });
}

/**
 * The runs table under the person's filters, read again whenever any run moves. A read for new
 * filters asks for one page. `Load earlier` reads only the page after the rows drawn, from the
 * cursor the last answer ended on. Any other read asks once for as many runs as are drawn, and
 * reads on only while runs that arrived above have pushed rows it already drew past that answer,
 * so a refresh costs one call however many pages are open and no drawn run leaves the table.
 */
export function createRunListRead(
  sources: WorkflowReadSources,
  readAsk: () => RunListAsk,
): PushDrivenRead<RunListAnswer> {
  const { bridge, clock, feed } = sources;
  const listRead: PushDrivenRead<RunListAnswer> = new PushDrivenRead({
    clock,
    origin: "workflow-runs",
    read: async (signal) => {
      const ask = readAsk();
      const request = runListRequestFor(ask.filters, clock.now());
      const readPage = (limit: number, cursor: string | undefined) =>
        callDaemon(
          bridge,
          "workflow.runList",
          { ...request, limit, ...(cursor === undefined ? {} : { cursor }) },
          { signal },
        );
      const shown = listRead.state.kind === "loaded" ? listRead.state.value : undefined;
      const drawn = shown?.ask.filters === ask.filters ? shown : undefined;
      if (drawn !== undefined && ask.pageCount > drawn.pageCount) {
        return await readEarlierPage(drawn, ask, readPage);
      }
      // A refused first call fails the read, so the table says why rather than drawing nothing.
      const limit = Math.max(RUNS_PAGE_SIZE, drawn?.response.runs.length ?? 0);
      let page: WorkflowRunListResponse = unwrapDaemonReply(await readPage(limit, undefined));
      const runs = [...page.runs];
      const oldestDrawn = drawn?.response.runs.at(-1);
      while (
        oldestDrawn !== undefined &&
        page.nextCursor !== undefined &&
        !reaches(runs, oldestDrawn)
      ) {
        page = unwrapDaemonReply(await readPage(RUNS_PAGE_SIZE, page.nextCursor));
        runs.push(...page.runs);
      }
      return {
        ask,
        response: {
          runs,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          totalCount: page.totalCount,
        },
        pageCount: drawn?.pageCount ?? 1,
      };
    },
    subscribe: (onChange) => feed.onRunSignal(onChange),
  });
  return listRead;
}

/** The runs waiting on a person and the spent accounts, as the daemon groups them. */
export function createAttentionRead(
  sources: WorkflowReadSources,
): PushDrivenRead<WorkflowRunAttentionListResponse> {
  const { bridge, clock, feed } = sources;
  return new PushDrivenRead({
    clock,
    origin: "workflow-attention",
    read: async (signal) =>
      unwrapDaemonReply(await callDaemon(bridge, "workflow.runAttentionList", {}, { signal })),
    subscribe: (onChange) => feed.onRunSignal(onChange),
  });
}

/** The saved workflows the workflow filter offers, read again when a definition changes. */
export function createDefinitionListRead(
  sources: WorkflowReadSources,
): PushDrivenRead<WorkflowDefinitionListResponse> {
  const { bridge, clock, feed } = sources;
  return new PushDrivenRead({
    clock,
    origin: "workflow-definitions",
    read: async (signal) =>
      unwrapDaemonReply(await callDaemon(bridge, "workflow.definitionList", {}, { signal })),
    subscribe: (onChange) =>
      feed.onRunSignal((runSignal) => {
        if (runSignal.scope === "all") {
          onChange();
        }
      }),
  });
}

/**
 * The machine's provider accounts, for the label a cost or a spent account is named by. It
 * listens on the account registry's own stream, so a renamed account reads its new label.
 */
export function createProviderAccountRead(
  bridge: PlatformBridge,
  clock: Clock,
): PushDrivenRead<ProviderAccountListResponse> {
  return new PushDrivenRead({
    clock,
    origin: "workflow-provider-accounts",
    read: async (signal) =>
      unwrapDaemonReply(await callDaemon(bridge, "providerAccount.list", {}, { signal })),
    // A stream opened again after it ended reads again, since a rename in the gap went unheard.
    subscribe: (onChange) =>
      openReopeningSubscription({
        signal: bridge.transportReconnect,
        subject: PROVIDER_ACCOUNT_NOTICE_STREAM,
        clock,
        open: (deliver, onEnded) =>
          bridge.daemon.subscribe(PROVIDER_ACCOUNT_NOTICE_STREAM, {}, deliver, onEnded),
        onFrame: onChange,
        onReopened: onChange,
      }),
  });
}

/** One run's record, read again on the frames that name this run. */
export function createRunRead(
  sources: WorkflowReadSources,
  workflowRunId: WorkflowRunId,
): PushDrivenRead<WorkflowRunReadResponse> {
  const { bridge, clock, feed } = sources;
  return new PushDrivenRead({
    clock,
    origin: "workflow-run",
    read: async (signal) =>
      unwrapDaemonReply(
        await callDaemon(bridge, "workflow.runRead", { workflowRunId }, { signal }),
      ),
    subscribe: (onChange) =>
      feed.onRunSignal((runSignal) => {
        if (runSignal.scope === "all" || runSignal.workflowRunId === workflowRunId) {
          onChange();
        }
      }),
  });
}

/**
 * `Load earlier`: the page after the drawn rows, from the cursor their answer ended on, joined
 * below them. A refused page keeps the rows, with why the page could not be read.
 */
async function readEarlierPage(
  drawn: RunListAnswer,
  ask: RunListAsk,
  readPage: (
    limit: number,
    cursor: string | undefined,
  ) => Promise<DaemonReply<WorkflowRunListResponse>>,
): Promise<RunListAnswer> {
  const { nextCursor } = drawn.response;
  if (nextCursor === undefined) {
    return { ...drawn, ask };
  }
  const reply = await readPage(RUNS_PAGE_SIZE, nextCursor);
  if (reply.status === "refused") {
    return { ...drawn, ask, earlierRefusal: reply.refusal };
  }
  const page = reply.value;
  return {
    ask,
    response: {
      runs: [...drawn.response.runs, ...page.runs],
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      totalCount: page.totalCount,
    },
    pageCount: drawn.pageCount + 1,
  };
}

/**
 * Whether the runs read so far reach down to `oldest`, the last run drawn before: it is among
 * them, or they already hold a run that started before it, as when it was deleted.
 */
function reaches(runs: readonly WorkflowRunSummary[], oldest: WorkflowRunSummary): boolean {
  const oldestStart = parseInstant(oldest.startedAt);
  return runs.some((run) => {
    const runStart = parseInstant(run.startedAt);
    return run.workflowRunId === oldest.workflowRunId || compareInstants(runStart, oldestStart) < 0;
  });
}
