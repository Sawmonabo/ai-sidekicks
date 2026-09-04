// The attention plane: what the console may say about "what needs me".
//
// `Spec-023 §Console Design (Meridian)` §Notification center and the attention
// plane puts the whole answer in the daemon's projection: items are read, never
// counted here, and `Spec-019 §Required Behavior` makes emission derived from
// canonical state rather than from client heuristics. So this module holds a
// vocabulary, a narrowing, and a fold — and no derivation of attention at all.
//
// WHAT IS REGISTERED, AND WHAT IS NOT
//
// `attention.projectionRead` is a daemon JSON-RPC method the corpus registers in
// its own method-name registry, and `AttentionItem` is a shape that registry
// fixes. Neither has landed in `packages/contracts`: nothing there exports an
// attention type, no `SidekicksBridge` namespace names one, and the growth port
// carries no attention operation on any slate row. A console that composed the
// method string anyway would be wiring a surface live against an unregistered
// wire, which `Plan-023 §Console growth slate` makes a review rejection.
//
// So the read is a SEAM the caller supplies, defaulting to the one honest answer
// available today: nothing was read. `frame/session-lifecycle.ts` reaches the same
// shape for the same reason — its `READS_NOTHING_YET` resolves `undefined` rather
// than an empty projection, because "we did not ask" and "there is none" are
// different facts and an empty array asserts the second.
//
// WHEN that seam is read, and what re-reads it, is `attention-read.ts` next door:
// this module owns the vocabulary and the fold, and holds no lifetime at all.
//
// THE SHAPES HERE ARE RENDERER-LOCAL PROJECTION CONTRACTS, not wire types — the
// posture `store/entities.ts` sets for `ConsoleSessionEvent`, and for its reason:
// the payload arriving from any reader is `unknown` until the contracts package
// registers the real schema, so exactly one module narrows it and everything above
// reads the narrowed value. The narrowing is FAIL-CLOSED: an item carrying a
// trigger or a severity outside the closed sets below is dropped rather than
// coerced, because an unknown trigger rendered as a known one is the console
// asserting a fact the daemon never sent.

import type { ConsoleRefusal } from "../../core/index.js";
import {
  ATTENTION_SEVERITIES,
  ATTENTION_TRIGGERS,
  type AttentionItem,
  type AttentionSeverity,
  type AttentionTrigger,
  type GrowthPort,
} from "../../bridge/index.js";

/** One session the projection read could not answer for, with its own refusal. */
export interface RefusedAttentionSession {
  readonly sessionId: string;
  readonly refusal: ConsoleRefusal;
}

/**
 * What one fan-out over the session-scoped read produced.
 *
 * TWO HALVES, BECAUSE COVERAGE IS A SEPARATE FACT FROM CONTENT. The members are
 * what the sessions that answered carried; the refusals are the sessions that did
 * not. A reading that carried only the first would let a served empty projection
 * beside a refused one render as an all-clear — a person told nothing needs them
 * on the strength of a question half the sessions never answered.
 *
 * It is the vocabulary `sessions/InviteShelf.tsx` already folds its own fan-out
 * into, one level down: outcomes are tracked rather than survivors, so "one session
 * has nothing for you" and "another would not say" stay two facts.
 */
export interface AttentionProjectionRead {
  /** Members served, concatenated across the sessions that answered. */
  readonly members: readonly unknown[];
  /** The sessions that refused. Empty when every session that was asked answered. */
  readonly refusedSessions: readonly RefusedAttentionSession[];
}

/**
 * The read the notification center performs.
 *
 * `undefined` is "nothing was read" — the honest answer while the projection's
 * wire is unregistered, and deliberately not an empty read, which would tell the
 * center the projection is genuinely empty and let it render the all-clear line
 * for a question nobody put.
 */
export type AttentionProjectionReader = () => Promise<AttentionProjectionRead | undefined>;

/**
 * The reader that ships today: no wire, so no question, so no answer.
 *
 * Named rather than inlined at the call site, so the surface that installs it says
 * WHICH read is missing and a grep for the symbol finds every consumer the day the
 * projection lands.
 */
export const READS_NO_ATTENTION_PROJECTION: AttentionProjectionReader = () =>
  Promise.resolve(undefined);

/**
 * The reader a surface installs when it has a bridge and sessions to read for.
 *
 * The projection is SESSION-scoped on the wire, and the destination that renders it
 * is not: the all-sessions list asks "what needs me" across everything it can name.
 * So the reader fans out over the ids it was given and concatenates what came back —
 * which is a fan-out over a read, not a second projection, and the plane above still
 * folds one flat set exactly as it did when the set came from one session.
 *
 * EVERY REFUSAL TRAVELS WITH THE MEMBERS. It answered by dropping them, so a
 * session that served nothing beside one that refused produced an empty projection
 * and the center rendered the definitive all-clear — the worst sentence this
 * surface has, said on the strength of a read one session never answered. A served
 * session with items hid the refused ones the same way, quietly rather than loudly.
 * The refusals are carried per session, with the port's own words, because the
 * center names WHICH sessions went unchecked and renders each refusal's own code.
 *
 * `undefined` — "nothing was read" — on exactly one input: no ids to ask about,
 * which is a question nobody put rather than an answer. Every ask refusing is an
 * ANSWER — the wire was reached and it declined — so it returns a read carrying no
 * members and every refusal, and the center says the coverage is empty rather than
 * that the question was never asked.
 */
export function attentionProjectionReaderFor(
  growth: GrowthPort,
  sessionIds: readonly string[],
): AttentionProjectionReader {
  return async () => {
    if (sessionIds.length === 0) {
      return undefined;
    }
    const outcomes = await Promise.all(
      sessionIds.map(async (sessionId) => ({
        sessionId,
        outcome: await growth.attentionProjectionRead({ sessionId }),
      })),
    );
    const members: unknown[] = [];
    const refusedSessions: RefusedAttentionSession[] = [];
    for (const { sessionId, outcome } of outcomes) {
      if (outcome.status === "served") {
        members.push(...outcome.value.items);
      } else {
        refusedSessions.push({ sessionId, refusal: outcome });
      }
    }
    return { members, refusedSessions };
  };
}

function isTrigger(candidate: unknown): candidate is AttentionTrigger {
  return (
    typeof candidate === "string" && (ATTENTION_TRIGGERS as readonly string[]).includes(candidate)
  );
}

function isSeverity(candidate: unknown): candidate is AttentionSeverity {
  return (
    typeof candidate === "string" && (ATTENTION_SEVERITIES as readonly string[]).includes(candidate)
  );
}

function readString(source: Readonly<Record<string, unknown>>, member: string): string | undefined {
  const value = source[member];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * What an OPTIONAL member answered — three values, because two would lose one.
 *
 * `readString` above answers `undefined` for a member that is absent, empty, or not
 * a string at all, which is exactly right for a REQUIRED member (the conjunction
 * below rejects the item either way) and exactly wrong for an optional one: it
 * converts "the producer sent something this console cannot read" into "the
 * producer sent nothing", and absence is a meaningful value on both optional
 * members here.
 */
type OptionalStringReading =
  | { readonly presence: "absent" }
  | { readonly presence: "present"; readonly value: string }
  | { readonly presence: "invalid" };

/**
 * Read an optional string member without flattening invalid onto absent.
 *
 * `undefined` is absence and nothing else is: a JSON producer omits an optional
 * member rather than sending a null, so `null`, `""`, and every non-string answer
 * `invalid` and the item is dropped. That is the fail-closed arm — the alternative
 * is a console that reads `resolvedAt: null` as "still outstanding" and offers a
 * person work the daemon already closed.
 */
function readOptionalString(
  source: Readonly<Record<string, unknown>>,
  member: string,
): OptionalStringReading {
  const value = source[member];
  if (value === undefined) {
    return { presence: "absent" };
  }
  return typeof value === "string" && value !== ""
    ? { presence: "present", value }
    : { presence: "invalid" };
}

/**
 * Narrow one projection member, or drop it.
 *
 * The one boundary between whatever a reader produced and everything above. Every
 * required member has to be present and every closed-set member has to be inside
 * its set; anything else answers `undefined` and the item never reaches a render.
 * Dropping is the fail-closed arm: a half-narrowed item would put a blank summary
 * or an unstyled trigger on a surface whose whole job is to be trusted.
 *
 * An OPTIONAL member that is present and unreadable drops the item too, on the same
 * arm and for the same reason. Absence carries meaning on both of them — no
 * `runId` is the session-scoped aggregate, no `resolvedAt` is still outstanding —
 * so admitting a malformed one as absent would not be tolerance, it would be the
 * console asserting a scope or a resolution state the producer never sent.
 */
export function narrowAttentionItem(candidate: unknown): AttentionItem | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const source = candidate as Readonly<Record<string, unknown>>;
  const id = readString(source, "id");
  const sessionId = readString(source, "sessionId");
  const summary = readString(source, "summary");
  const sourceEventId = readString(source, "sourceEventId");
  const createdAt = readString(source, "createdAt");
  const { trigger, severity } = source;
  if (
    id === undefined ||
    sessionId === undefined ||
    summary === undefined ||
    sourceEventId === undefined ||
    createdAt === undefined ||
    !isTrigger(trigger) ||
    !isSeverity(severity)
  ) {
    return undefined;
  }
  const runId = readOptionalString(source, "runId");
  const resolvedAt = readOptionalString(source, "resolvedAt");
  if (runId.presence === "invalid" || resolvedAt.presence === "invalid") {
    return undefined;
  }
  return {
    id,
    sessionId,
    ...(runId.presence === "absent" ? {} : { runId: runId.value }),
    trigger,
    severity,
    summary,
    sourceEventId,
    createdAt,
    ...(resolvedAt.presence === "absent" ? {} : { resolvedAt: resolvedAt.value }),
  };
}

/** One session's live attention, split on the axis suppression keys on. */
export interface AttentionSessionGroup {
  readonly sessionId: string;
  readonly actionable: readonly AttentionItem[];
  readonly informational: readonly AttentionItem[];
}

/**
 * The fold over one projection read.
 *
 * An encapsulated value rather than four loose helpers: the center, the
 * all-sessions list, and the tests all ask the same three questions of one read,
 * and three functions each re-walking the array would be three chances to
 * disagree about what "live" means.
 *
 * IT COUNTS NOTHING THE DAEMON DID NOT SEND. The only arithmetic here is
 * partitioning and ordering. Severity is read off each item; the session-scoped
 * aggregate is an item the projection built, not a reduction this class performs.
 * `Spec-023 §Console Design (Meridian)`: "Never counts attention itself; severity
 * per row comes from the attention projection."
 *
 * A resolved item is dropped at construction. `resolvedAt` is the daemon's word
 * that the item has cleared, and a center that kept it would be offering a person
 * work that is already done.
 */
export class AttentionPlane {
  readonly #liveItems: readonly AttentionItem[];
  readonly #groups: readonly AttentionSessionGroup[];
  readonly #severityBySessionId: ReadonlyMap<string, AttentionSeverity>;

  public constructor(items: readonly AttentionItem[]) {
    this.#liveItems = items.filter((item) => item.resolvedAt === undefined);
    this.#groups = groupBySession(this.#liveItems);
    this.#severityBySessionId = new Map(
      this.#groups.map((group) => [
        group.sessionId,
        group.actionable.length > 0 ? "actionable" : "informational",
      ]),
    );
  }

  /** Every unresolved item, oldest first. Ordering is the projection's own. */
  public get liveItems(): readonly AttentionItem[] {
    return this.#liveItems;
  }

  /** Live items grouped by session, sessions ordered by their oldest item. */
  public get groups(): readonly AttentionSessionGroup[] {
    return this.#groups;
  }

  /** True while any session has actionable attention. Drives the density fold. */
  public get hasActionable(): boolean {
    return this.#groups.some((group) => group.actionable.length > 0);
  }

  /**
   * The severity that applies to one session, or `undefined` when the projection
   * carries nothing for it.
   *
   * `undefined` is not "clear". It is the absence a row renders as nothing at all,
   * because a row that showed an all-clear mark for a session the projection never
   * mentioned would be reporting an answer to a question nobody asked.
   */
  public severityFor(sessionId: string): AttentionSeverity | undefined {
    return this.#severityBySessionId.get(sessionId);
  }
}

/**
 * Narrow a whole read, dropping members that do not survive the boundary.
 *
 * Separate from the plane so a caller can count what was dropped: the plane takes
 * items, and what arrived as unrecognisable is a fact about the reader rather than
 * about the attention state.
 */
export function narrowAttentionProjection(members: readonly unknown[]): {
  readonly items: readonly AttentionItem[];
  readonly droppedCount: number;
} {
  const items: AttentionItem[] = [];
  let droppedCount = 0;
  for (const member of members) {
    const item = narrowAttentionItem(member);
    if (item === undefined) {
      droppedCount += 1;
      continue;
    }
    items.push(item);
  }
  return { items, droppedCount };
}

function groupBySession(items: readonly AttentionItem[]): readonly AttentionSessionGroup[] {
  const bySessionId = new Map<
    string,
    { actionable: AttentionItem[]; informational: AttentionItem[] }
  >();
  for (const item of items) {
    const existing = bySessionId.get(item.sessionId) ?? { actionable: [], informational: [] };
    if (item.severity === "actionable") {
      existing.actionable.push(item);
    } else {
      existing.informational.push(item);
    }
    bySessionId.set(item.sessionId, existing);
  }
  return [...bySessionId].map(([sessionId, split]) => ({
    sessionId,
    actionable: split.actionable,
    informational: split.informational,
  }));
}

/**
 * What one projection read produced, as a value a view narrows on.
 *
 * Four phases and not two: a read in flight, a read that was never put, a read that
 * answered, and a read that FAILED. Collapsing the second into the third would let
 * the all-clear line stand for a question nobody asked, which is exactly the
 * conflation the five kinds of nothing exist to prevent — and collapsing the fourth
 * into the second would report a reader that broke as a reader that was never asked,
 * which is the same conflation from the other side.
 *
 * The `read` arm carries its own COVERAGE, because a read that answered is not the
 * same as a read that answered for everything it asked about, and one phase for
 * both would make the difference unrenderable.
 */
export type AttentionReading =
  | { readonly phase: "reading" }
  | { readonly phase: "not-asked" }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal }
  | {
      readonly phase: "read";
      readonly plane: AttentionPlane;
      /** Members the boundary refused. A fact about the reader, not about attention. */
      readonly droppedCount: number;
      /** Sessions that never answered. Non-empty means the coverage is incomplete. */
      readonly refusedSessions: readonly RefusedAttentionSession[];
    };
