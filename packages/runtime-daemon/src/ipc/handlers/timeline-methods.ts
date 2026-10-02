// Binds the `timeline.*` methods onto the registry and answers `timeline.bodyRead`.
//
// * `registerTimelineMethod` takes a method name and a handler; the schemas and the `mutating`
//   flag come from `TIMELINE_METHOD_DESCRIPTORS`, so a name cannot be paired with another
//   operation's schemas and a handler for the wrong operation fails to compile.
// * The caller's principal is not in the request (each timeline request is `.strict()`); a handler
//   reads it from the `HandlerContext` passed as its second argument.
// * Only `timeline.bodyRead` is answered here. The other methods are bound by the service that
//   answers them, so no placeholder handler puts a method on the wire that answers nothing.

import {
  TIMELINE_BODY_READ_METHOD,
  TIMELINE_CHILD_RUN_EXPAND_METHOD,
  TIMELINE_METHOD_DESCRIPTORS,
  TIMELINE_PATCH_READ_METHOD,
  TIMELINE_READ_LIMIT_MAX,
  TIMELINE_READ_METHOD,
  TIMELINE_REASONING_SURFACE_READ_METHOD,
  TIMELINE_SEARCH_METHOD,
} from "@ai-sidekicks/contracts";
import type {
  Handler,
  MethodRegistry,
  SessionId,
  TimelineMethodName,
  TimelineMethodRequest,
  TimelineMethodResponse,
} from "@ai-sidekicks/contracts";

import { hydrateStoredEvent, type StoredEventContentRow } from "../../events/content-read.js";
import { RegistryDispatchError } from "../registry.js";

// ----------------------------------------------------------------------------
// Request correlation: the checks no schema can perform
// ----------------------------------------------------------------------------
//
// The registry validates a result against the response schema without seeing the request, so it
// cannot catch:
// * A reply about the wrong subject: a `timeline.read` for session A that returns valid rows of
//   session B.
// * A reply whose meaning depends on the request: an `available` reasoning surface with no entries
//   is true for a continuation at the end and false for a first read.
// * A reply that overruns the caller's window: a read for ten rows that returns 256 still parses,
//   because the schema bounds `entries` only at `TIMELINE_READ_LIMIT_MAX`.
//
// A violation is an internal error, not a client error: the daemon built an answer that does not
// answer a well-formed question. It uses the registry's `invalid_result` code, which maps to
// `-32603` with the offending paths in `data.fields.issues`.

/** One request/response disagreement, shaped like a Zod issue so it rides `data.fields.issues`. */
interface RequestCorrelationViolation {
  readonly code: "custom";
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** A per-method correlation check, typed against that method's own request and response. */
type TimelineRequestCorrelationCheck<MethodName extends TimelineMethodName> = (
  request: TimelineMethodRequest<MethodName>,
  result: TimelineMethodResponse<MethodName>,
) => readonly RequestCorrelationViolation[];

// Refuses a page larger than the caller's window: the request's `limit`, or
// `TIMELINE_READ_LIMIT_MAX` when it named none. `path` names the member, not an index, because the
// page's size is the defect and no single entry is responsible.
const refusePageOverRequestedCeiling = (
  pagedMemberName: string,
  entryCount: number,
  ceiling: number,
  ceilingIsCallerSupplied: boolean,
): readonly RequestCorrelationViolation[] => {
  if (entryCount <= ceiling) {
    return [];
  }
  return [
    {
      code: "custom",
      path: [pagedMemberName],
      message:
        `the reply carries ${String(entryCount)} entries against a ceiling of ` +
        `${String(ceiling)} (${
          ceilingIsCallerSupplied
            ? "the limit this request asked for"
            : "the default page ceiling, which this request did not narrow"
        }): a caller sizing a viewport, a budget, or a render pass from the window it asked for ` +
        "is handed a larger one, with nothing on the reply saying the request was not honored",
    },
  ];
};

// The error frame is bounded, so only the first offending entry is reported, with the total count.
const TIMELINE_REQUEST_CORRELATION_CHECKS: {
  readonly [MethodName in TimelineMethodName]: TimelineRequestCorrelationCheck<MethodName>;
} = {
  [TIMELINE_READ_METHOD]: (request, result) => {
    const violations: RequestCorrelationViolation[] = [
      ...refusePageOverRequestedCeiling(
        "entries",
        result.entries.length,
        request.limit ?? TIMELINE_READ_LIMIT_MAX,
        request.limit !== undefined,
      ),
    ];
    const firstOffendingIndex = result.entries.findIndex(
      (entry) => entry.sessionId !== request.sessionId,
    );
    if (firstOffendingIndex === -1) {
      return violations;
    }
    const offendingCount = result.entries.filter(
      (entry) => entry.sessionId !== request.sessionId,
    ).length;
    const firstOffendingEntry = result.entries[firstOffendingIndex];
    violations.push({
      code: "custom",
      path: ["entries", firstOffendingIndex, "sessionId"],
      message:
        `entry sessionId ${JSON.stringify(firstOffendingEntry?.sessionId)} does not match the ` +
        `requested session ${JSON.stringify(request.sessionId)} (${String(offendingCount)} of ` +
        `${String(result.entries.length)} entries disagree): the reply is a valid page of ` +
        "another session's history, which the caller cannot distinguish from its own",
    });
    return violations;
  },
  // The reasoning surface names no run or session to cross-check. It needs the request for the
  // first-page floor: an `available` surface with no entries looks like `unavailable` on a first
  // read and is correct for a continuation at the end. The schema carries the continuing arm's
  // non-empty floor; this carries the first read's.
  [TIMELINE_REASONING_SURFACE_READ_METHOD]: (request, result) => {
    if (
      request.afterCursor !== undefined ||
      result.availability !== "available" ||
      result.reasoningEntries.length > 0
    ) {
      return [];
    }
    return [
      {
        code: "custom",
        path: ["reasoningEntries"],
        message:
          "a first reasoning read carried no cursor, so an empty available surface has no " +
          "continuation to explain it: the client renders a surface that exists and shows " +
          "nothing, which is indistinguishable from the unavailable state while asserting the " +
          "opposite — a producer with nothing to serve must answer unavailable rather than " +
          "with an empty page",
      },
    ];
  },
  [TIMELINE_CHILD_RUN_EXPAND_METHOD]: (request, result) => {
    // The request has no `limit`, so the default page ceiling applies.
    const violations: RequestCorrelationViolation[] = [
      ...refusePageOverRequestedCeiling(
        "entries",
        result.entries.length,
        TIMELINE_READ_LIMIT_MAX,
        false,
      ),
    ];
    if (result.runId === request.runId) {
      // The response schema pins every entry to `result.runId` (`requireEntriesToBelongToRun`),
      // so matching the request's run id covers the entries.
      return violations;
    }
    violations.push({
      code: "custom",
      path: ["runId"],
      message:
        `response runId ${JSON.stringify(result.runId)} does not match the expanded run ` +
        `${JSON.stringify(request.runId)}: the reply is a self-consistent expansion of a ` +
        "different run, and its entries were validated against the run it names rather than " +
        "the run that was asked for",
    });
    return violations;
  },
  // A body read and a patch read return stored text and name no subject that could be wrong.
  [TIMELINE_BODY_READ_METHOD]: () => [],
  [TIMELINE_PATCH_READ_METHOD]: () => [],
  // A search page holds to the caller's window, as a read does.
  [TIMELINE_SEARCH_METHOD]: (request, result) =>
    refusePageOverRequestedCeiling(
      "hits",
      result.hits.length,
      request.limit ?? TIMELINE_READ_LIMIT_MAX,
      request.limit !== undefined,
    ),
};

/** What binds one `timeline.*` method: its name and a handler whose types follow from the name. */
export interface TimelineMethodRegistration<MethodName extends TimelineMethodName> {
  readonly method: MethodName;
  /** Receives a schema-validated request; its result is validated before it reaches the wire. */
  readonly handler: Handler<TimelineMethodRequest<MethodName>, TimelineMethodResponse<MethodName>>;
}

/**
 * Binds one `timeline.*` method onto the registry, taking its schemas from
 * `TIMELINE_METHOD_DESCRIPTORS` under the same name. Every timeline operation is a read, so each
 * registers `mutating: false` and passes the version-mismatch gate.
 *
 * @throws RegistryRegistrationError on a duplicate registration.
 */
export function registerTimelineMethod<MethodName extends TimelineMethodName>(
  registry: MethodRegistry,
  registration: TimelineMethodRegistration<MethodName>,
): void {
  const descriptor = TIMELINE_METHOD_DESCRIPTORS[registration.method];
  const enforceRequestCorrelation = TIMELINE_REQUEST_CORRELATION_CHECKS[registration.method];
  // The only point where both the request and the result are in scope.
  const correlatedHandler: Handler<
    TimelineMethodRequest<MethodName>,
    TimelineMethodResponse<MethodName>
  > = async (request, context) => {
    const result = await registration.handler(request, context);
    const violations = enforceRequestCorrelation(request, result);
    if (violations.length > 0) {
      throw new RegistryDispatchError(
        "invalid_result",
        `${descriptor.method}: handler returned a result that does not correlate with the ` +
          "request (the daemon assembled a well-formed answer that does not answer the " +
          "question asked; the client is not at fault)",
        violations,
      );
    }
    return result;
  };
  // TypeScript widens the three indexed lookups to the union of every method's types; the cast is
  // safe because schemas and handler share the key `registration.method`.
  registry.register(
    descriptor.method,
    descriptor.requestSchema,
    descriptor.responseSchema,
    correlatedHandler as Handler<unknown, unknown>,
    { mutating: descriptor.mutating },
  );
}

/**
 * What `timeline.bodyRead` reads through: the stored event row.
 *
 * @consumedBy the daemon's method wiring for the timeline's full-body read
 */
export interface TimelineBodyReadDependencies {
  /**
   * The stored row of one event in one session, or `undefined` when the session holds no event
   * with that id. An unknown session throws `SessionNotFoundError`, reported as
   * `session.not_found`.
   */
  readonly readStoredEventRow: (
    sessionId: SessionId,
    eventId: string,
  ) => Promise<StoredEventContentRow | undefined>;
}

/**
 * Binds `timeline.bodyRead`, which returns a row's large body or full output. The row id is the
 * stored event's id; the answer is the body, or `absent` for a row that carries none. An id the
 * session does not hold is refused on the `rowId` path, so it differs from a row with no body.
 *
 * @consumedBy the daemon's method wiring for the timeline's full-body read
 */
export function registerTimelineBodyRead(
  registry: MethodRegistry,
  dependencies: TimelineBodyReadDependencies,
): void {
  registerTimelineMethod(registry, {
    method: TIMELINE_BODY_READ_METHOD,
    handler: async (request) => {
      const storedRow = await dependencies.readStoredEventRow(request.sessionId, request.rowId);
      if (storedRow === undefined) {
        throw new RegistryDispatchError(
          "invalid_params",
          `${TIMELINE_BODY_READ_METHOD}: the session holds no row with this id`,
          [{ code: "custom", path: ["rowId"], message: "the session holds no row with this id" }],
        );
      }
      return hydrateStoredEvent(storedRow).content;
    },
  });
}
