// The transcript's windows and the find field's reading of them, held across a session's store
// revisions, against the same derived whole from each revision's log. A real store is fed a
// scripted session one event at a time, so a rollback rewrites held rows, a release and an earlier
// page replace the log, and a person folds and opens groups, exactly as on screen. At every step
// the held windows must publish what a whole derivation publishes, a run group under the key it
// kept from earlier windows where a whole derivation mints one; must not change what they
// published before; and must keep an unchanged row's object while giving a changed row a new one.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import { encodeEventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { describe, expect, it } from "vitest";

import {
  composeScriptBeats,
  createRunEntryBuilders,
  type ScriptEntry,
} from "#fixtures/data/script-entries.js";
import {
  RUN_ARCHITECT_CHILD,
  RUN_IMPLEMENTER,
  SESSION_ID,
  TRANSCRIPT_STATES_SCENARIO,
  startedAtMs,
} from "#fixtures/scenarios/transcript-states.js";
import { ScenarioTurnAttribution } from "#renderer/services/daemon/scenario/turn-attribution.fixture.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { type WaitingOnPersonRecords } from "#renderer/store/session/waiting-on-person/register.js";
import { DrawnRowFilter } from "../feed/drawn-rows.js";
import { type RunEntitiesByRunId } from "../runs/groups.js";
import { RunGroupFold } from "../feed/run-group-fold.js";
import {
  fixedRunWindowInputs,
  measuredRunWindowInputs,
  runWindowPositionsOf,
} from "../feed/run-group-fold.test-support.js";
import { type RunWindowInputs } from "../feed/run-group-fold.js";
import { FindMatchList, FoldedMatchCount, type FindResult } from "../find/matcher.js";
import { ChangingRowIndex } from "./changing-rows.js";
import {
  TranscriptWindowDerivation,
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "./transcript-window.js";

/**
 * The run the script streams long past its window, rewinds, and folds. It is a child run, so each
 * of its events restamps its creation row, which by then sits before its group's window.
 */
const LONG_RUN = "019b793b-7b60-740e-8150-d1a4c1150115";
/** A run folded from the start that streams between the long run's rows. */
const SIDE_RUN = "019b793b-7b60-740e-8170-d1a4c1150117";
/** A child of the long run, whose events restamp its creation row while the parent streams. */
const LONG_RUN_CHILD = "019b793b-7b60-740e-8160-d1a4c1150116";
const EXTENSION_EVENT_ID_STEM = "019b793b-7b60-7ea1-8120-e5e0d115";
const PERSON = "019b793b-7b60-79a4-8110-cca0117a0410";
/** The turn the long run is rewound to, below the turns it has streamed by then. */
const LONG_RUN_REWIND_POSITION = 2;

/**
 * What the find field holds while the log moves: one query every call's heading and the person's
 * messages match, and one only the calls' results match by their elapsed time, which the run's
 * window lets go.
 */
const FIND_QUERIES = ["read", "4 ms"] as const;

/** A stand-in renderer that draws nothing for two wire types, one of them a system message. */
function drawsBody(row: TranscriptEventRow): boolean {
  return row.type !== "run.starting" && row.type !== "usage.context_compacted";
}

/** Every window the feed derives from one log, the rows still changing in it, and each find. */
interface Windows {
  readonly unfurled: TranscriptWindowModel;
  readonly fold: TranscriptPipelineStage;
  readonly drawn: TranscriptWindowModel;
  readonly changingRowIds: ReadonlySet<string>;
  readonly finds: readonly HeldFind[];
}

/** What one find query reads over the drawn rows, and counts among the rows the fold withheld. */
interface HeldFind {
  readonly result: FindResult;
  readonly foldedAwayMatchCount: number;
}

/** The held derivations of one session, as the feed keeps them across revisions. */
class HeldWindows {
  readonly #derivation = new TranscriptWindowDerivation();
  readonly #fold = new RunGroupFold();
  readonly #runWindowInputs: RunWindowInputs;
  readonly #drawnRowFilter = new DrawnRowFilter();
  readonly #changingRowIndex = new ChangingRowIndex();
  /** The keys of the folded runs' groups, one set object while no group joins or leaves it. */
  #foldedRunGroupKeys: ReadonlySet<string> = new Set<string>();
  readonly #finds = FIND_QUERIES.map((query) => ({
    query,
    matchList: new FindMatchList(),
    foldedMatchCount: new FoldedMatchCount(),
  }));

  public constructor(runWindowInputs: RunWindowInputs) {
    this.#runWindowInputs = runWindowInputs;
  }

  public derive(
    transcript: readonly ProjectedSessionEvent[],
    runEntities: RunEntitiesByRunId,
    foldedRunIds: ReadonlySet<string>,
    waitingOnPerson: WaitingOnPersonRecords,
  ): Windows {
    const unfurled = this.#derivation.derive(transcript, runEntities);
    // A person folds every group of a run, as `Fold every run` does, so a run's new stretch is
    // folded too.
    const foldedRunGroupKeys = [...unfurled.runGroupByHeaderKey.values()]
      .filter((runGroup) => foldedRunIds.has(runGroup.runId))
      .map((runGroup) => runGroup.key);
    if (
      foldedRunGroupKeys.length !== this.#foldedRunGroupKeys.size ||
      foldedRunGroupKeys.some((runGroupKey) => !this.#foldedRunGroupKeys.has(runGroupKey))
    ) {
      this.#foldedRunGroupKeys = new Set(foldedRunGroupKeys);
    }
    const fold = this.#fold.fold(unfurled, this.#foldedRunGroupKeys, this.#runWindowInputs);
    const drawn = this.#drawnRowFilter.filter(fold.window, drawsBody);
    return {
      unfurled,
      fold,
      drawn,
      changingRowIds: this.#changingRowIndex.changingRowIdsOf(unfurled, waitingOnPerson),
      finds: this.#finds.map(({ query, matchList, foldedMatchCount }) => ({
        result: matchList.resultOf(drawn.rows, query, unfurled.systemMessageByRowId),
        foldedAwayMatchCount: foldedMatchCount.countOf(
          fold.removedRows,
          query,
          unfurled.systemMessageByRowId,
          drawsBody,
        ),
      })),
    };
  }
}

describe("the transcript windows held across a session's revisions", () => {
  it("publish what a whole derivation of each revision's log publishes", () => {
    const { headEvents, longRunEvents, tailEvents } = scriptedSession();
    const store = new SessionStore({ sessionId: SESSION_ID });
    store.initialize({ cursor: -1, entities: [] });
    // Twenty pixels a row on a hundred-pixel screen, so the long run's first turn passes the
    // distance at which its window lets its oldest calls go.
    const heldRunWindowInputs = measuredRunWindowInputs({
      screenHeightPx: () => 100,
      rowHeightPx: () => 20,
    });
    const held = new HeldWindows(heldRunWindowInputs);
    let foldedRunIds: ReadonlySet<string> = new Set<string>();
    let previous: CheckedStep | undefined;
    const coverage = {
      rebuilds: 0,
      runWindowLetGo: 0,
      restampedCreationRows: 0,
      foldedMatches: 0,
      splitRuns: 0,
      headersBelowUndrawnRows: 0,
    };

    const check = (): CheckedStep => {
      const { transcript, partitions } = store.snapshot();
      const windows = held.derive(
        transcript,
        partitions.run,
        foldedRunIds,
        store.waitingOnPersonRecords,
      );
      // The whole derivation holds each run's window where the held one put it, from a copy, so
      // it shares no state the held path could have got wrong.
      const whole = new HeldWindows(
        fixedRunWindowInputs(runWindowPositionsOf(heldRunWindowInputs.windows, windows.unfurled)),
      ).derive(transcript, partitions.run, foldedRunIds, store.waitingOnPersonRecords);
      const probeKeys = [
        ...whole.unfurled.rows.map((row) => row.id),
        ...whole.unfurled.runGroupByHeaderKey.keys(),
        "a key no row carries",
      ];
      const published = plainText(contentOf(windows));
      const heldText = withMintedRunGroupKeys(windows, published);
      const wholeText = withMintedRunGroupKeys(whole, plainText(contentOf(whole)));
      if (heldText !== wholeText) {
        expect(JSON.parse(heldText)).toStrictEqual(JSON.parse(wholeText));
      }
      expect(keysAnsweredApartFromEntries(windows, probeKeys)).toStrictEqual([]);
      // The mark reaches the window from each event's own stamp, and nothing else dims a row.
      expect([...windows.unfurled.supersededRowIds]).toStrictEqual(
        transcript
          .filter((event) => event.runStamp?.superseded !== undefined)
          .map((event) => event.id),
      );
      const step: CheckedStep = {
        transcript,
        windows,
        whole,
        probeKeys,
        published,
      };
      if (previous !== undefined) {
        // What the last step published is untouched by this one.
        expect(plainText(contentOf(previous.windows))).toBe(previous.published);
        expect(keysAnsweredApartFromEntries(previous.windows, previous.probeKeys)).toStrictEqual(
          [],
        );
        const isAppend = startsWith(transcript, previous.transcript);
        coverage.rebuilds += isAppend ? 0 : 1;
        coverage.restampedCreationRows += expectIdentityFollowsContent(previous, step, isAppend);
      }
      if (windows.fold.removedRows.some((row) => !foldedRunIds.has(rowRunId(row)))) {
        coverage.runWindowLetGo += 1;
      }
      if (windows.finds.every((find) => find.foldedAwayMatchCount > 0)) {
        coverage.foldedMatches += 1;
      }
      const runGroups = [...windows.unfurled.runGroupByHeaderKey.values()];
      if (new Set(runGroups.map((runGroup) => runGroup.runId)).size < runGroups.length) {
        coverage.splitRuns += 1;
      }
      if (runGroups.some((runGroup) => runGroup.headerRowId !== runGroup.rowIds[0])) {
        coverage.headersBelowUndrawnRows += 1;
      }
      previous = step;
      return step;
    };

    for (const event of headEvents) {
      store.applyBatch([event]);
      check();
    }
    // A person folds the finished run and the side run, and every later step keeps both folded.
    foldedRunIds = new Set([RUN_IMPLEMENTER, SIDE_RUN]);
    check();
    const longRunFoldAt = longRunEvents.length - 20;
    for (const [index, event] of longRunEvents.entries()) {
      store.applyBatch([event]);
      check();
      if (index === longRunFoldAt) {
        foldedRunIds = new Set([RUN_IMPLEMENTER, SIDE_RUN, LONG_RUN]);
        check();
      }
    }
    foldedRunIds = new Set([RUN_IMPLEMENTER, SIDE_RUN]);
    const beforeRelease = check();

    // The store lets go of the log's head, keeps streaming, then reads the head back.
    const releasedEvents = beforeRelease.transcript.slice(0, 12);
    const firstKept = beforeRelease.transcript[12] as ProjectedSessionEvent;
    const newest = beforeRelease.transcript.at(-1) as ProjectedSessionEvent;
    store.releaseOutside(encodeEventCursor(firstKept.sequence), encodeEventCursor(newest.sequence));
    expect(check().transcript[0]).toBe(firstKept);
    for (const event of tailEvents) {
      store.applyBatch([event]);
      check();
    }
    // Read back as a page arrives from the daemon: equal events in new objects.
    store.prependEarlierEvents({
      events: releasedEvents.map((event) => ({ ...event })),
      edge: { cursor: undefined, hasMore: false },
      runs: [],
    });
    const restored = check();
    // A row the window let go and read back is a new object, never the one held before.
    for (const event of releasedEvents) {
      const before = beforeRelease.windows.unfurled.rowsByKey.get(event.id);
      expect(before).toBeDefined();
      expect(restored.windows.unfurled.rowsByKey.get(event.id)).not.toBe(before);
    }
    // The store lets go of the log's tail, the long run's call still running among it.
    const keptLast = restored.transcript.at(-3) as ProjectedSessionEvent;
    store.releaseOutside(
      encodeEventCursor((restored.transcript[0] as ProjectedSessionEvent).sequence),
      encodeEventCursor(keptLast.sequence),
    );
    expect(check().transcript.at(-1)).toBe(keptLast);

    // The script reaches every path the held windows take: a rollback and the release and read
    // rewrite the log, an open run past its window lets rows go, a child restamps its row, each
    // find has matches the fold withholds, other rows break a run into stretches, and a header
    // stands at its group's first card below rows that draw nothing.
    expect(coverage.splitRuns).toBeGreaterThan(0);
    expect(coverage.headersBelowUndrawnRows).toBeGreaterThan(0);
    expect(coverage.rebuilds).toBeGreaterThanOrEqual(3);
    expect(coverage.runWindowLetGo).toBeGreaterThan(0);
    expect(coverage.restampedCreationRows).toBeGreaterThan(0);
    expect(coverage.foldedMatches).toBeGreaterThan(0);
    expect(restored.windows.unfurled.supersededRowIds.size).toBeGreaterThan(0);
    // Every revision is checked against a whole derivation and its own earlier text, about two and
    // a half seconds alone and over the default five on a loaded machine.
  }, 20_000);
});

/** One checked revision: its log, what the held and whole derivations published, and a copy. */
interface CheckedStep {
  readonly transcript: readonly ProjectedSessionEvent[];
  readonly windows: Windows;
  readonly whole: Windows;
  readonly probeKeys: readonly string[];
  /** The text of what the held windows published at this step, taken then. */
  readonly published: string;
}

/**
 * Everything the windows publish, as plain values: every list, every map walked, the size each map
 * reports, the fold's withheld rows, the rows still changing and what each find reads.
 */
function contentOf(windows: Windows): unknown {
  const runGroupKeyByRowId = windows.unfurled.runGroupKeyByRowId;
  return {
    unfurled: modelContentOf(windows.unfurled),
    // One map every stage hands on, so it is walked once.
    runGroupKeyByRowId: { entries: [...runGroupKeyByRowId], size: runGroupKeyByRowId.size },
    fold: modelContentOf(windows.fold.window),
    removedRows: windows.fold.removedRows,
    drawn: modelContentOf(windows.drawn),
    changingRowIds: [...windows.changingRowIds].sort(),
    finds: windows.finds,
  };
}

function modelContentOf(model: TranscriptWindowModel): unknown {
  return {
    viewportRows: model.viewportRows.map(({ key, parentKey, rootCursor }) => ({
      key,
      parentKey,
      rootCursor,
    })),
    rows: model.rows,
    supersededRowIds: [...model.supersededRowIds],
    liveRunIds: [...model.liveRunIds],
    maps: Object.fromEntries(
      Object.entries(mapsOf(model)).map(([name, map]) => [
        name,
        { entries: [...map], size: map.size },
      ]),
    ),
  };
}

function mapsOf(
  model: TranscriptWindowModel,
): Readonly<Record<string, ReadonlyMap<string, unknown>>> {
  return {
    rowsByKey: model.rowsByKey,
    runGroupByHeaderKey: model.runGroupByHeaderKey,
    systemMessageByRowId: model.systemMessageByRowId,
    childRunEntryByRowId: model.childRunEntryByRowId,
    handoffEntryByRowId: model.handoffEntryByRowId,
    replyRowIdsByFootRowId: model.replyRowIdsByFootRowId,
  };
}

/**
 * The keys, among `probeKeys`, that some published map answers by key otherwise than its own walk
 * of entries does, and each map whose size is not its walk's count. A lookup must find exactly the
 * entry the walk yields, and nothing else.
 */
function keysAnsweredApartFromEntries(
  windows: Windows,
  probeKeys: readonly string[],
): readonly string[] {
  const mismatched: string[] = [];
  const namedMaps: [string, ReadonlyMap<string, unknown>][] = [
    ...[windows.unfurled, windows.fold.window, windows.drawn].flatMap((model) =>
      Object.entries(mapsOf(model)),
    ),
    ["runGroupKeyByRowId", windows.unfurled.runGroupKeyByRowId],
  ];
  for (const [name, map] of namedMaps) {
    const walked = new Map(map);
    if (map.size !== walked.size) {
      mismatched.push(`${name}: size`);
    }
    for (const key of probeKeys) {
      if (map.get(key) !== walked.get(key) || map.has(key) !== walked.has(key)) {
        mismatched.push(`${name}: ${key}`);
      }
    }
  }
  return mismatched;
}

/**
 * `text`, published by `windows`, with each run group key written as a whole derivation mints it:
 * the group's run and its first row in this log. A group the held windows derived across a page or
 * a release keeps the key it had, so only its name may differ from a whole derivation's.
 */
function withMintedRunGroupKeys(windows: Windows, text: string): string {
  const mintedKeyByKey = new Map<string, string>();
  for (const row of windows.unfurled.rows) {
    const runGroupKey = windows.unfurled.runGroupKeyByRowId.get(row.id);
    // A group opens at a run's row, so the first member met is a run row.
    if (runGroupKey !== undefined && !mintedKeyByKey.has(runGroupKey) && row.kind !== "general") {
      mintedKeyByKey.set(runGroupKey, `${row.runId}:${row.id}`);
    }
  }
  return JSON.stringify(JSON.parse(text), (_member, value: unknown) =>
    typeof value === "string" ? (mintedKeyByKey.get(value) ?? value) : value,
  );
}

/** One text for a published value, keeping a member set to `undefined` apart from an absent one. */
function plainText(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    member === undefined ? "(undefined)" : member,
  );
}

/**
 * The text of one published row or run group, taken once: each step's whole derivation is read
 * again as the next step's previous one, and an absent entry reads as `undefined`.
 */
function entryText(entry: object | undefined): string | undefined {
  if (entry === undefined) {
    return undefined;
  }
  let text = ENTRY_TEXTS.get(entry);
  if (text === undefined) {
    text = plainText(entry);
    ENTRY_TEXTS.set(entry, text);
  }
  return text;
}

const ENTRY_TEXTS = new WeakMap<object, string>();

/**
 * On a step that only grew the log, a row or run group whose whole derivation did not change keeps
 * its object and one that changed takes a new one, and every identity keeps its object. On a step
 * that rewrote the log, a changed row still takes a new object, and an unchanged one keeps its
 * object, a rollback boundary's read payload included, unless it carries a child run's summary,
 * which a whole derivation composes anew. Answers how many child creation rows were restamped.
 */
function expectIdentityFollowsContent(
  previous: CheckedStep,
  next: CheckedStep,
  isAppend: boolean,
): number {
  const stale: string[] = [];
  const churned: string[] = [];
  let restampedCreationRows = 0;
  for (const [rowId, previousRow] of previous.windows.unfurled.rowsByKey) {
    const nextWholeRow = next.whole.unfurled.rowsByKey.get(rowId);
    if (nextWholeRow === undefined) {
      continue;
    }
    const isUnchanged =
      entryText(previous.whole.unfurled.rowsByKey.get(rowId)) === entryText(nextWholeRow);
    const isSameObject = next.windows.unfurled.rowsByKey.get(rowId) === previousRow;
    if (!isUnchanged && isSameObject) {
      stale.push(`row ${rowId}`);
    }
    if (!isUnchanged && isAppend && previousRow.childRunSummary !== undefined) {
      restampedCreationRows += 1;
    }
    const isRetainedOnRewrite = previousRow.childRunSummary === undefined;
    if (isUnchanged && !isSameObject && (isAppend || isRetainedOnRewrite)) {
      churned.push(`row ${rowId}`);
    }
  }
  if (isAppend) {
    for (const [runId, previousRunGroup] of previous.windows.unfurled.runGroupByHeaderKey) {
      const isUnchanged =
        entryText(previous.whole.unfurled.runGroupByHeaderKey.get(runId)) ===
        entryText(next.whole.unfurled.runGroupByHeaderKey.get(runId));
      const isSameObject =
        next.windows.unfurled.runGroupByHeaderKey.get(runId) === previousRunGroup;
      if (isUnchanged !== isSameObject) {
        (isUnchanged ? churned : stale).push(`run group ${runId}`);
      }
    }
    const nextIdentityByKey = new Map(
      next.windows.unfurled.viewportRows.map((identity) => [identity.key, identity]),
    );
    for (const identity of previous.windows.unfurled.viewportRows) {
      if (nextIdentityByKey.get(identity.key) !== identity) {
        churned.push(`identity ${identity.key}`);
      }
    }
  }
  expect({ stale, churned }).toStrictEqual({ stale: [], churned: [] });
  return restampedCreationRows;
}

function startsWith(
  log: readonly ProjectedSessionEvent[],
  prefix: readonly ProjectedSessionEvent[],
): boolean {
  return log.length >= prefix.length && prefix.every((event, index) => log[index] === event);
}

function rowRunId(row: TranscriptEventRow): string {
  return row.kind === "general" ? "" : row.runId;
}

/**
 * The three-lane session, then a run streamed past its window with a child under it, rewound, and a
 * final stretch: every event stamped by the daemon's turn rules as the fixture stream stamps them.
 */
function scriptedSession(): {
  readonly headEvents: readonly ProjectedSessionEvent[];
  readonly longRunEvents: readonly ProjectedSessionEvent[];
  readonly tailEvents: readonly ProjectedSessionEvent[];
} {
  const headCount = TRANSCRIPT_STATES_SCENARIO.beats.length;
  const longRunEntries = longRunScript();
  const extension = composeScriptBeats({
    sessionId: SESSION_ID,
    eventIdStem: EXTENSION_EVENT_ID_STEM,
    startedAtMs,
    entries: longRunEntries,
  }).map(
    (beat, index): ProjectedSessionEvent => ({
      ...beat.event,
      sequence: headCount + index,
      cursor: encodeEventCursor(headCount + index),
    }),
  );
  const delivered: ProjectedSessionEvent[] = [];
  const attribution = new ScenarioTurnAttribution(() => delivered);
  const stamped = [...TRANSCRIPT_STATES_SCENARIO.beats.map((beat) => beat.event), ...extension].map(
    (event) => {
      delivered.push(event);
      const runStamp = attribution.attribute(event)?.stamp;
      return runStamp === undefined ? event : { ...event, runStamp };
    },
  );
  const tailCount = 6;
  return {
    headEvents: stamped.slice(0, headCount),
    longRunEvents: stamped.slice(headCount, stamped.length - tailCount),
    tailEvents: stamped.slice(stamped.length - tailCount),
  };
}

/**
 * A run of four turns, each a reply and a run of tool calls, the first long enough to pass the
 * run's window unbroken; a side run whose replies land before the run's first card and between
 * its later calls, breaking it into stretches; a child run born in its second turn; a compaction
 * in it and in the folded run, system messages the fold withholds; a person's messages between
 * turns; a call that names no id; a rewind to the second turn; and the re-executed turn after it.
 */
function longRunScript(): readonly ScriptEntry[] {
  const lane = createRunEntryBuilders(SESSION_ID);
  let atMs = 4_000;
  const nextAtMs = (): number => {
    atMs += 10;
    return atMs;
  };
  const toolPair = (runId: string, callId: string): ScriptEntry[] => [
    lane.tool(runId, {
      atMs: nextAtMs(),
      kind: "tool.invoked",
      toolName: "read",
      toolCallId: callId,
    }),
    lane.tool(runId, {
      atMs: nextAtMs(),
      kind: "tool.result",
      toolName: "read",
      toolCallId: callId,
      durationMs: 4,
      body: "read 64 bytes",
    }),
  ];
  const turnStarted = (): ScriptEntry => ({
    atMs: nextAtMs(),
    kind: "run.turn_started",
    payload: { sessionId: SESSION_ID, runId: LONG_RUN },
  });
  const reply = (runId: string): ScriptEntry =>
    lane.output(runId, {
      atMs: nextAtMs(),
      kind: "assistant.message",
      contentType: "text/markdown",
      body: "The reply.",
    });
  const compacted = (runId: string): ScriptEntry => ({
    atMs: nextAtMs(),
    kind: "usage.context_compacted",
    payload: { sessionId: SESSION_ID, runId },
  });
  const personSays = (message: string): ScriptEntry => ({
    atMs: nextAtMs(),
    kind: "user.message",
    actorId: PERSON,
    payload: { sessionId: SESSION_ID, actor: PERSON, message },
  });
  const entries: ScriptEntry[] = [
    personSays("Walk the whole store and list every reader."),
    lane.transition(LONG_RUN, {
      atMs: nextAtMs(),
      runVersion: 1,
      newState: "queued",
      parentRunId: RUN_IMPLEMENTER,
    }),
    lane.transition(SIDE_RUN, { atMs: nextAtMs(), runVersion: 1, newState: "queued" }),
    lane.transition(SIDE_RUN, {
      atMs: nextAtMs(),
      runVersion: 2,
      previousState: "queued",
      newState: "running",
    }),
    reply(SIDE_RUN),
    lane.transition(LONG_RUN, {
      atMs: nextAtMs(),
      runVersion: 2,
      previousState: "queued",
      newState: "starting",
    }),
    lane.transition(LONG_RUN, {
      atMs: nextAtMs(),
      runVersion: 3,
      previousState: "starting",
      newState: "running",
    }),
  ];
  for (let turn = 1; turn <= 4; turn += 1) {
    entries.push(turnStarted(), reply(LONG_RUN), reply(LONG_RUN));
    if (turn === 2) {
      entries.push(
        lane.transition(LONG_RUN_CHILD, {
          atMs: nextAtMs(),
          runVersion: 1,
          newState: "queued",
          parentRunId: LONG_RUN,
        }),
      );
    }
    // The first turn is one unbroken stretch past the window; later ones are broken.
    const callCount = turn === 1 ? 62 : 6;
    for (let call = 0; call < callCount; call += 1) {
      entries.push(...toolPair(LONG_RUN, `call-long-${String(turn)}-${String(call)}`));
      if (turn === 2 && call % 10 === 0) {
        entries.push(reply(LONG_RUN_CHILD));
      }
      if (turn >= 3 && call % 7 === 3) {
        entries.push(reply(SIDE_RUN));
      }
      if (turn === 1 && call === 5) {
        entries.push(compacted(LONG_RUN), compacted(SIDE_RUN));
      }
    }
    entries.push(reply(LONG_RUN), personSays(`Turn ${String(turn)} read; go on.`));
  }
  entries.push(
    {
      atMs: nextAtMs(),
      kind: "tool.invoked",
      payload: { sessionId: SESSION_ID, runId: LONG_RUN, toolName: "shell" },
    },
    lane.transition(LONG_RUN_CHILD, {
      atMs: nextAtMs(),
      runVersion: 2,
      previousState: "queued",
      newState: "completed",
      completionKind: "turn",
    }),
    {
      atMs: nextAtMs(),
      kind: "run.rolled_back",
      actorId: PERSON,
      payload: {
        sessionId: SESSION_ID,
        runId: LONG_RUN,
        runVersion: 4,
        targetPosition: LONG_RUN_REWIND_POSITION,
      },
    },
    turnStarted(),
    reply(LONG_RUN),
  );
  for (let call = 0; call < 6; call += 1) {
    entries.push(...toolPair(LONG_RUN, `call-again-${String(call)}`));
  }
  entries.push(
    reply(LONG_RUN),
    reply(RUN_ARCHITECT_CHILD),
    lane.tool(LONG_RUN, {
      atMs: nextAtMs(),
      kind: "tool.invoked",
      toolName: "write",
      toolCallId: "call-last",
    }),
    personSays("That is enough for now."),
  );
  return entries;
}
