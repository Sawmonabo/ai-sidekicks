// Plan-005 T3.10 — Claude event normalizer.
//
// Spec coverage under test: `Spec-005 §Required Behavior` — drivers emit
// normalized runtime events rather than leaking provider-native event types,
// and the required normalized event families are accounted for. The family
// accounting is asserted against the CORPUS contract
// (`EVENT_DISPOSITION_BY_KIND` in `@ai-sidekicks/contracts`, which is the
// machine form of `Plan-006 §Event-Kind Disposition Table (surveyed-runtime normalized census)`) rather than against
// this package's own restatement of it, so the two cannot drift apart quietly.
//
// Verifies invariant: none (T3.10 is structural). The `verifies_invariant`
// obligation is empty for this task by the DAG; family coverage is verified by
// the Plan-006 taxonomy tests, and what is verified HERE is that this
// normalizer agrees with that taxonomy row for row.

import { describe, expect, it } from "vitest";

import {
  EVENT_DISPOSITION_BY_KIND,
  NORMALIZED_EVENT_KINDS,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  SESSION_EVENT_TYPES,
  TOOL_ACTIVITY_EVENT_TYPES,
  type EventCategory,
  type NormalizedEventKind,
  type SessionEventType,
} from "@ai-sidekicks/contracts";

import {
  CLAUDE_CAN_USE_TOOL_BEHAVIORS,
  CLAUDE_CAN_USE_TOOL_REQUEST_MEMBERS,
  CLAUDE_CENSUSED_CONTROL_REQUEST_SUBTYPE_COUNT_AT_PIN,
  CLAUDE_CONTROL_REQUEST_SUBTYPES_ABSENT_AT_PIN,
  CLAUDE_CONTROL_REQUEST_SUBTYPE_VECTORS,
  CLAUDE_CONTROL_RESPONSE_ERROR_ENVELOPE_MEMBERS,
  CLAUDE_MCP_SET_SERVERS_RECONCILE_RESPONSE_JSON,
} from "../__fixtures__/control-request-subtype-census.js";
import {
  CLAUDE_ADJACENT_STREAM_SUBTYPES,
  CLAUDE_API_ERROR_TO_API_RETRY_MAPPING_ARM,
  CLAUDE_API_RETRY_FRAME_MEMBERS,
  CLAUDE_API_RETRY_TYPED_ERRORS,
  CLAUDE_INIT_CAPABILITY_TOKENS,
  CLAUDE_RESULT_SUBTYPES,
  CLAUDE_RESULT_SUBTYPE_CARRYING_RESULT_FIELD,
  CLAUDE_WIRE_PIN_VERSION,
} from "../__fixtures__/stream-surface-census.js";
import { DriverDiagnosticsEmitter } from "../../../driver-diagnostics.js";
import {
  CLAUDE_FAMILY_REACHABILITY,
  CLAUDE_FRAME_NORMALIZATION_BY_KIND,
  CLAUDE_SUBAGENT_START_SIGNAL,
  CLAUDE_SUBAGENT_STOP_SIGNAL,
  CLAUDE_WIRE_FRAME_KINDS,
  UnknownClaudeWireFrameError,
  CLAUDE_API_RETRY_FRAME_SUBTYPE,
  CLAUDE_API_RETRY_FRAME_TYPE,
  CLAUDE_USAGE_LIMIT_RETRY_ERROR_MEMBER,
  classifyClaudeFrameFamilyForRouting,
  classifyClaudeUsageLimitSignal,
  composeClaudeWireFrameKind,
  normalizeClaudeSubagentLifecycle,
  normalizeClaudeWireFrame,
  resolveClaudeEmissionReadiness,
  resolveClaudeFrameEmissionRoute,
  type ClaudeFrameNormalization,
  type ClaudeNormalizedFamilyEmission,
  type ClaudeWireFrameKind,
  ClaudeTerminalEmissionGate,
  type ClaudeTerminalRunFrame,
} from "../event-normalizer.js";

// --------------------------------------------------------------------------
// Local helpers.
// --------------------------------------------------------------------------

/**
 * The six families `Spec-005 §Required Behavior` requires a driver to produce.
 *
 * Restated here (rather than imported) on purpose: the point of the ledger
 * test is to check the module's ledger against the SPEC's list, so importing
 * the module's own idea of the list would make the assertion circular.
 */
const SPEC_005_REQUIRED_FAMILIES: readonly EventCategory[] = [
  "run_lifecycle",
  "assistant_output",
  "tool_activity",
  "interactive_request",
  "artifact_publication",
  "usage_telemetry",
];

/** Narrow to the emitting arm, failing the test rather than silently skipping. */
function expectNormalized(normalization: ClaudeFrameNormalization): ClaudeNormalizedFamilyEmission {
  expect(normalization.disposition).toBe("normalized");
  if (normalization.disposition !== "normalized") {
    throw new Error("unreachable: assertion above already failed");
  }
  return normalization;
}

/**
 * Typed constructor for a Claude control-request frame.
 *
 * The wire reference records the control-request SUBTYPE registry but no
 * request body, so a golden payload file for one cannot be honestly derived
 * (`docs/reference/provider-wire/README.md` §Evidence rules — "regenerate,
 * don't transcribe"). Described-but-not-shown frames are therefore built here,
 * from the member names the reference DOES record, and never in `__fixtures__/`
 * where a hand-built body would inherit the pin's provenance stamp.
 */
function buildControlRequestFrame(subtype: string): {
  readonly type: "control_request";
  readonly request: { readonly subtype: string };
} {
  return { type: "control_request", request: { subtype } };
}

/** Typed constructor for a Claude stream `system` frame. */
function buildSystemFrame(subtype: string): {
  readonly type: "system";
  readonly subtype: string;
} {
  return { type: "system", subtype };
}

/** Typed constructor for a Claude stream `result` frame. */
function buildResultFrame(subtype: string): {
  readonly type: "result";
  readonly subtype: string;
} {
  return { type: "result", subtype };
}

// --------------------------------------------------------------------------
// Totality over the pinned census.
// --------------------------------------------------------------------------

describe("Claude wire frame census", () => {
  it("resolves every census member without refusing", () => {
    expect(CLAUDE_WIRE_FRAME_KINDS.length).toBeGreaterThan(0);
    for (const frameKind of CLAUDE_WIRE_FRAME_KINDS) {
      expect(() => normalizeClaudeWireFrame(frameKind)).not.toThrow();
    }
  });

  it("keeps the exported roster and the lookup map in set-equality", () => {
    expect([...CLAUDE_WIRE_FRAME_KINDS].sort()).toStrictEqual(
      [...CLAUDE_FRAME_NORMALIZATION_BY_KIND.keys()].sort(),
    );
  });

  it("stamps every row with the frame kind that keys it", () => {
    for (const [frameKind, normalization] of CLAUDE_FRAME_NORMALIZATION_BY_KIND) {
      expect(normalization.frameKind).toBe(frameKind);
    }
  });

  it("gives every not-evented row a non-empty stated reason and no taxonomy target", () => {
    const notEvented = [...CLAUDE_FRAME_NORMALIZATION_BY_KIND.values()].filter(
      (normalization) => normalization.disposition === "not-evented",
    );
    expect(notEvented.length).toBeGreaterThan(0);
    for (const normalization of notEvented) {
      expect(normalization.reason.trim().length).toBeGreaterThan(0);
      expect(normalization).not.toHaveProperty("family");
      expect(normalization).not.toHaveProperty("eventType");
      expect(normalization).not.toHaveProperty("normalizedKind");
    }
  });

  it("routes every frame kind to exactly one family emission or one stated non-emission", () => {
    for (const normalization of CLAUDE_FRAME_NORMALIZATION_BY_KIND.values()) {
      if (normalization.disposition === "normalized") {
        expect(typeof normalization.family).toBe("string");
        expect(typeof normalization.eventType).toBe("string");
      } else {
        expect(normalization.disposition).toBe("not-evented");
      }
    }
  });
});

// --------------------------------------------------------------------------
// Agreement with the corpus disposition contract.
// --------------------------------------------------------------------------

describe("agreement with EVENT_DISPOSITION_BY_KIND", () => {
  it("names only census kinds, and agrees with the registry on category and type", () => {
    const censusKinds = new Set<NormalizedEventKind>(NORMALIZED_EVENT_KINDS);
    let checkedRows = 0;

    for (const normalization of CLAUDE_FRAME_NORMALIZATION_BY_KIND.values()) {
      if (normalization.disposition !== "normalized") {
        continue;
      }
      const { normalizedKind } = normalization;
      if (normalizedKind === null) {
        // A Claude delta-family member the census deliberately does not key
        // (`worker_shutting_down` is "wire-layer rather than a T1.8 registry
        // key"). It still must name a real taxonomy type.
        expect(SESSION_EVENT_TYPES.length).toBeGreaterThan(0);
        continue;
      }

      expect(censusKinds.has(normalizedKind)).toBe(true);

      const registryDisposition = EVENT_DISPOSITION_BY_KIND.get(normalizedKind);
      expect(registryDisposition).toBeDefined();
      if (registryDisposition === undefined) {
        throw new Error("unreachable: assertion above already failed");
      }
      // Only `adopt` / `rename` rows carry a target; a Claude frame must never
      // be mapped onto a `correlate` / `discard` census row.
      expect(["adopt", "rename"]).toContain(registryDisposition.disposition);
      expect(registryDisposition.category).toBe(normalization.family);
      if (registryDisposition.eventType !== undefined) {
        expect(normalization.eventType).toBe(registryDisposition.eventType);
      }
      checkedRows += 1;
    }

    expect(checkedRows).toBeGreaterThan(0);
  });

  it("carries the census RENAME for rate_limit_event rather than inventing a kind", () => {
    const normalization = expectNormalized(normalizeClaudeWireFrame("system/rate_limit_event"));
    expect(normalization.normalizedKind).toBe("rate_limits");
    expect(EVENT_DISPOSITION_BY_KIND.get("rate_limits")?.disposition).toBe("rename");
    expect(normalization.family).toBe("usage_telemetry");
    expect(normalization.eventType).toBe("usage.rate_limit_update");
  });
});

// --------------------------------------------------------------------------
// Fixture-driven cases: every recorded frame normalizes as expected.
// --------------------------------------------------------------------------

describe("pinned control-request subtypes", () => {
  it("carries the reference's censused count plus the censused-absent answerer", () => {
    const censused = CLAUDE_CONTROL_REQUEST_SUBTYPE_VECTORS.filter(
      (vector) => vector.presentInCensusedRegistry,
    );
    expect(censused).toHaveLength(CLAUDE_CENSUSED_CONTROL_REQUEST_SUBTYPE_COUNT_AT_PIN);
    expect(CLAUDE_CONTROL_REQUEST_SUBTYPE_VECTORS).toHaveLength(
      CLAUDE_CENSUSED_CONTROL_REQUEST_SUBTYPE_COUNT_AT_PIN + 1,
    );
    // Registry ABSENCE never decides capability: the absent subtype is mapped.
    expect(
      CLAUDE_CONTROL_REQUEST_SUBTYPE_VECTORS.some(
        (vector) => vector.subtype === "mcp_set_servers" && !vector.presentInCensusedRegistry,
      ),
    ).toBe(true);
  });

  it("normalizes every recorded subtype without reaching the unknown seam", () => {
    for (const vector of CLAUDE_CONTROL_REQUEST_SUBTYPE_VECTORS) {
      const frame = buildControlRequestFrame(vector.subtype);
      const frameKind = composeClaudeWireFrameKind(frame.type, frame.request.subtype);
      const normalization = normalizeClaudeWireFrame(frameKind);
      expect(normalization.channel).toBe("control-request");
    }
  });

  it("maps the three human-facing asks into interactive_request/driver_ask.requested", () => {
    const askSubtypes = ["can_use_tool", "elicitation", "request_user_dialog"] as const;
    for (const subtype of askSubtypes) {
      const frame = buildControlRequestFrame(subtype);
      const normalization = expectNormalized(
        normalizeClaudeWireFrame(composeClaudeWireFrameKind(frame.type, frame.request.subtype)),
      );
      expect(normalization.family).toBe("interactive_request");
      expect(normalization.eventType).toBe("driver_ask.requested");
    }
    expect(
      expectNormalized(normalizeClaudeWireFrame("control_request/can_use_tool")).normalizedKind,
    ).toBe("approval_request");
    expect(
      expectNormalized(normalizeClaudeWireFrame("control_request/elicitation")).normalizedKind,
    ).toBe("user_input_request");
  });

  it("treats every daemon-originated subtype as a reasoned non-emission", () => {
    const daemonOriginated = [
      "interrupt",
      "set_permission_mode",
      "set_model",
      "get_usage",
      "get_context_usage",
      "get_session_cost",
      "list_models",
      "get_binary_version",
      "apply_flag_settings",
      "rewind_files",
      "mcp_set_servers",
      "mcp_message",
      "hook_callback",
    ] as const;
    for (const subtype of daemonOriginated) {
      const normalization = normalizeClaudeWireFrame(`control_request/${subtype}`);
      expect(normalization.disposition).toBe("not-evented");
    }
  });

  it("refuses the three subtypes the counterexample hunt found at count 0", () => {
    for (const subtype of CLAUDE_CONTROL_REQUEST_SUBTYPES_ABSENT_AT_PIN) {
      expect(() => normalizeClaudeWireFrame(`control_request/${subtype}`)).toThrow(
        UnknownClaudeWireFrameError,
      );
    }
  });

  it("parses the one verbatim reconcile body the reference reproduces", () => {
    const parsed: unknown = JSON.parse(CLAUDE_MCP_SET_SERVERS_RECONCILE_RESPONSE_JSON);
    expect(parsed).toStrictEqual({
      subtype: "success",
      response: { added: [], removed: [], errors: {} },
    });
    // The envelope that carries it is a control_response, and a control
    // response is never a timeline row.
    const normalization = normalizeClaudeWireFrame(
      composeClaudeWireFrameKind("control_response", "success"),
    );
    expect(normalization.disposition).toBe("not-evented");
    expect(normalization.channel).toBe("control-response");
  });

  it("keeps the recorded control_response error envelope on the non-emitting arm", () => {
    expect(CLAUDE_CONTROL_RESPONSE_ERROR_ENVELOPE_MEMBERS).toStrictEqual([
      "subtype",
      "request_id",
      "error",
    ]);
    const normalization = normalizeClaudeWireFrame("control_response/error");
    expect(normalization.disposition).toBe("not-evented");
    if (normalization.disposition !== "not-evented") {
      throw new Error("unreachable: assertion above already failed");
    }
    expect(normalization.reason).toContain("request_id");
  });

  it("records the can_use_tool round-trip shape without widening its behavior set", () => {
    expect(CLAUDE_CAN_USE_TOOL_REQUEST_MEMBERS).toStrictEqual(["tool_name", "input"]);
    expect(CLAUDE_CAN_USE_TOOL_BEHAVIORS).toStrictEqual(["allow", "deny", "cancelled"]);
  });
});

describe("pinned stream surface", () => {
  it("maps all five result subtypes into the run_lifecycle terminal", () => {
    expect(CLAUDE_RESULT_SUBTYPES).toHaveLength(5);
    for (const subtype of CLAUDE_RESULT_SUBTYPES) {
      const frame = buildResultFrame(subtype);
      const normalization = expectNormalized(
        normalizeClaudeWireFrame(composeClaudeWireFrameKind(frame.type, frame.subtype)),
      );
      expect(normalization.family).toBe("run_lifecycle");
      expect(normalization.channel).toBe("stream");
    }
  });

  it("splits success from the four failure subtypes per census rows 6 and 13", () => {
    const success = expectNormalized(
      normalizeClaudeWireFrame(`result/${CLAUDE_RESULT_SUBTYPE_CARRYING_RESULT_FIELD}`),
    );
    expect(success.eventType).toBe("run.completed");
    expect(success.normalizedKind).toBe("turn_complete");

    const failures = CLAUDE_RESULT_SUBTYPES.filter(
      (subtype) => subtype !== CLAUDE_RESULT_SUBTYPE_CARRYING_RESULT_FIELD,
    );
    expect(failures).toHaveLength(4);
    for (const subtype of failures) {
      const normalization = expectNormalized(normalizeClaudeWireFrame(`result/${subtype}`));
      expect(normalization.eventType).toBe("run.failed");
      expect(normalization.normalizedKind).toBe("error");
    }
  });

  it("honours the reference's system/api_error -> system/api_retry mapping arm", () => {
    const [fromKind, toKind] = CLAUDE_API_ERROR_TO_API_RETRY_MAPPING_ARM;
    const from = expectNormalized(normalizeClaudeWireFrame(fromKind));
    const to = expectNormalized(normalizeClaudeWireFrame(toKind));
    expect(from.family).toBe(to.family);
    expect(from.eventType).toBe(to.eventType);
    expect(from.normalizedKind).toBe(to.normalizedKind);
    expect(to.eventType).toBe("usage.api_retry");
    expect(CLAUDE_API_RETRY_FRAME_MEMBERS).toContain("error_status");
    expect(CLAUDE_API_RETRY_FRAME_MEMBERS).toContain("retry_delay_ms");
  });

  it("keeps the api_retry typed-error list advisory rather than enforcing", () => {
    // The reference grades the union's arity Derived. The normalizer must
    // therefore reach the SAME row for a retry frame regardless of which typed
    // error it carries — including one the census never saw. Anything else
    // would fail closed on a set no evidence can close.
    expect(CLAUDE_API_RETRY_TYPED_ERRORS).toContain("unknown");
    expect(CLAUDE_API_RETRY_TYPED_ERRORS).not.toContain("zzq_unrecorded_typed_error");
    const frame = buildSystemFrame("api_retry");
    const normalization = expectNormalized(
      normalizeClaudeWireFrame(composeClaudeWireFrameKind(frame.type, frame.subtype)),
    );
    expect(normalization.eventType).toBe("usage.api_retry");
  });

  it("maps the two dispositioned adjacent subtypes and refuses the four undispositioned ones", () => {
    expect(CLAUDE_ADJACENT_STREAM_SUBTYPES).toHaveLength(6);
    const dispositioned = ["rate_limit_event", "compact_boundary"];
    for (const subtype of CLAUDE_ADJACENT_STREAM_SUBTYPES) {
      const frameKind = composeClaudeWireFrameKind("system", subtype);
      if (dispositioned.includes(subtype)) {
        const normalization = expectNormalized(normalizeClaudeWireFrame(frameKind));
        expect(normalization.family).toBe("usage_telemetry");
      } else {
        // command_lifecycle / queued_notification / the model-refusal pair:
        // Verified present at the pin, covered by no disposition table, so they
        // reach the T3.11 seam loudly instead of being mapped by inference.
        expect(() => normalizeClaudeWireFrame(frameKind)).toThrow(UnknownClaudeWireFrameError);
      }
    }
  });

  it("maps the nine explicitly-discarded system subtypes to reasoned non-emissions", () => {
    const discarded = [
      "hook_started",
      "hook_progress",
      "hook_response",
      "notification",
      "files_persisted",
      "tool_use_summary",
      "memory_recall",
      "local_command_output",
      "task_progress",
    ] as const;
    for (const subtype of discarded) {
      const normalization = normalizeClaudeWireFrame(composeClaudeWireFrameKind("system", subtype));
      expect(normalization.disposition).toBe("not-evented");
      if (normalization.disposition !== "not-evented") {
        throw new Error("unreachable: assertion above already failed");
      }
      expect(normalization.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("maps system/init and system/worker_shutting_down into run_lifecycle", () => {
    const init = expectNormalized(normalizeClaudeWireFrame("system/init"));
    expect(init.family).toBe("run_lifecycle");
    expect(init.eventType).toBe("run.provider_initialized");
    expect(init.normalizedKind).toBe("init");
    expect(CLAUDE_INIT_CAPABILITY_TOKENS).toContain("interrupt_receipt_v1");

    const shutdown = expectNormalized(normalizeClaudeWireFrame("system/worker_shutting_down"));
    expect(shutdown.family).toBe("run_lifecycle");
    expect(shutdown.eventType).toBe("run.worker_shutdown");
    // The corpus assigns this delta-family member a category and a type but
    // deliberately NO census kind ("wire-layer rather than a T1.8 registry key").
    expect(shutdown.normalizedKind).toBeNull();
  });

  it("stamps the fixtures with the pin the reference names", () => {
    // The PIN, not the build the schema-constructor census was extracted from.
    // Those came apart at the 2.1.251 re-pin: the census is carried at 2.1.245
    // (claude.md §Version pin, "Carried census") while the pin itself moved, so
    // this constant must track the pin a running build is compared against.
    expect(CLAUDE_WIRE_PIN_VERSION).toBe("2.1.251");
  });
});

// --------------------------------------------------------------------------
// The unknown-frame seam (Plan-005 T3.11, PR-B).
// --------------------------------------------------------------------------

describe("unknown frame handling", () => {
  it("refuses with a typed error rather than dropping silently", () => {
    let thrown: unknown;
    try {
      normalizeClaudeWireFrame("system/zzq_nonexistent_subtype");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownClaudeWireFrameError);
    const typed = thrown as UnknownClaudeWireFrameError;
    expect(typed.name).toBe("UnknownClaudeWireFrameError");
    // The verbatim kind is the `rawWireType` the T3.11 DriverDiagnosticRecord
    // needs, carried as data rather than parsed out of the message.
    expect(typed.frameKind).toBe("system/zzq_nonexistent_subtype");
  });

  it("mints no dotted wire code, leaving the §Driver registry census closed", () => {
    // `error-contracts.md` §Driver is a closed seven-code census, and this
    // refusal rides no error envelope — T3.11 turns it into a daemon
    // diagnostic keyed on `frameKind`. A `code` member here would be an
    // unregistered eighth `driver.*` code declared in code and in no contract
    // doc, so its ABSENCE is asserted rather than left to review. The twin
    // `UnknownCodexInboundFrameError` carries none either.
    const error = new UnknownClaudeWireFrameError("system/zzq_nonexistent_subtype");
    expect(Object.hasOwn(error, "code")).toBe(false);
    expect((error as unknown as Record<string, unknown>)["code"]).toBeUndefined();
    // The two discriminators the seam actually uses.
    expect(error).toBeInstanceOf(UnknownClaudeWireFrameError);
    expect(error.frameKind).toBe("system/zzq_nonexistent_subtype");
  });

  it("never returns undefined or a fabricated family for an unmapped kind", () => {
    for (const frameKind of [
      "assistant",
      "user",
      "SubagentStart",
      "SubagentStop",
      "prompt_suggestion",
      "system/prompt_suggestion",
      "",
    ]) {
      expect(() => normalizeClaudeWireFrame(frameKind)).toThrow(UnknownClaudeWireFrameError);
    }
  });

  it("is immune to prototype-chain keys", () => {
    for (const hostileKey of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(() => normalizeClaudeWireFrame(hostileKey)).toThrow(UnknownClaudeWireFrameError);
    }
  });

  it("composes a bare type for a subtype-less frame, which reaches the seam", () => {
    expect(composeClaudeWireFrameKind("system", "init")).toBe("system/init");
    expect(composeClaudeWireFrameKind("system", null)).toBe("system");
    expect(() => normalizeClaudeWireFrame(composeClaudeWireFrameKind("system", null))).toThrow(
      UnknownClaudeWireFrameError,
    );
  });

  it("carries the offending kind into the message as JSON data, not raw text", () => {
    const error = new UnknownClaudeWireFrameError('system/"injected"');
    expect(error.message).toContain('"system/\\"injected\\""');
    expect(error.frameKind).toBe('system/"injected"');
  });
});

// --------------------------------------------------------------------------
// Determinism and immutability.
// --------------------------------------------------------------------------

describe("determinism", () => {
  it("returns the identical frozen singleton for repeated resolution", () => {
    for (const frameKind of CLAUDE_WIRE_FRAME_KINDS) {
      const first = normalizeClaudeWireFrame(frameKind);
      const second = normalizeClaudeWireFrame(frameKind);
      expect(first).toBe(second);
      expect(Object.isFrozen(first)).toBe(true);
    }
  });

  it("freezes the exported roster and the ledger", () => {
    expect(Object.isFrozen(CLAUDE_WIRE_FRAME_KINDS)).toBe(true);
    expect(Object.isFrozen(CLAUDE_FAMILY_REACHABILITY)).toBe(true);
    for (const entry of CLAUDE_FAMILY_REACHABILITY) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("is pure: a full census sweep repeated yields structurally equal results", () => {
    const sweep = (): readonly ClaudeFrameNormalization[] =>
      CLAUDE_WIRE_FRAME_KINDS.map((frameKind) => normalizeClaudeWireFrame(frameKind));
    expect(sweep()).toStrictEqual(sweep());
  });
});

// --------------------------------------------------------------------------
// Emission readiness — the Plan-005 normalize-boundary rule.
// --------------------------------------------------------------------------

describe("emission readiness", () => {
  it("answers envelope-constructible only for a type with a registered payload variant", () => {
    const registered = SESSION_EVENT_TYPES[0];
    expect(registered).toBeDefined();
    if (registered === undefined) {
      throw new Error("unreachable: assertion above already failed");
    }
    expect(resolveClaudeEmissionReadiness(registered)).toBe("envelope-constructible");
  });

  it("answers payload-variant-pending for a census literal with no registered variant", () => {
    // Plan-006 T1.10's flip-is-not-emission rule: a literal registered in the
    // TAXONOMY is not thereby buildable into an envelope. The case is derived
    // from the live corpus rather than hard-coded, so this test asserts the
    // function's contract instead of pinning a particular literal's current
    // registration state — hard-coding one would turn an emitting plan landing
    // its payload variant into a failure of THIS suite.
    const registered = new Set<SessionEventType>(SESSION_EVENT_TYPES);
    const pendingTarget = [...SESSION_EVENT_CATEGORY_BY_TYPE.keys()].find(
      (candidate) => !registered.has(candidate),
    );
    expect(pendingTarget).toBeDefined();
    if (pendingTarget === undefined) {
      throw new Error("unreachable: assertion above already failed");
    }
    expect(resolveClaudeEmissionReadiness(pendingTarget)).toBe("payload-variant-pending");
  });

  it("stamps every normalized row consistently with the live registered set", () => {
    for (const normalization of CLAUDE_FRAME_NORMALIZATION_BY_KIND.values()) {
      if (normalization.disposition !== "normalized") {
        continue;
      }
      const expected = SESSION_EVENT_TYPES.includes(
        normalization.eventType as (typeof SESSION_EVENT_TYPES)[number],
      )
        ? "envelope-constructible"
        : "payload-variant-pending";
      expect(normalization.emissionReadiness).toBe(expected);
    }
  });
});

// --------------------------------------------------------------------------
// Family reachability ledger.
// --------------------------------------------------------------------------

describe("family reachability ledger", () => {
  it("is total over the six Spec-005 required families, and no wider", () => {
    expect(CLAUDE_FAMILY_REACHABILITY.map((entry) => entry.family).sort()).toStrictEqual(
      [...SPEC_005_REQUIRED_FAMILIES].sort(),
    );
  });

  it("agrees with the mapping table about which kinds reach each family", () => {
    const computed = new Map<EventCategory, ClaudeWireFrameKind[]>();
    for (const [frameKind, normalization] of CLAUDE_FRAME_NORMALIZATION_BY_KIND) {
      if (normalization.disposition !== "normalized") {
        continue;
      }
      const bucket = computed.get(normalization.family) ?? [];
      bucket.push(frameKind);
      computed.set(normalization.family, bucket);
    }

    for (const entry of CLAUDE_FAMILY_REACHABILITY) {
      const actual = computed.get(entry.family) ?? [];
      expect([...entry.reachedBy].sort()).toStrictEqual([...actual].sort());
    }

    // Nothing normalizes into a family outside the ledger's six. This is a
    // property of the CLAUDE table specifically, not of the taxonomy: the
    // 35-kind census routes other kinds into `session_lifecycle` and
    // `approval_flow`, which are deliberately out of the ledger's scope.
    for (const family of computed.keys()) {
      expect(SPEC_005_REQUIRED_FAMILIES).toContain(family);
    }
  });

  it("states a reason for exactly the families with a shortfall", () => {
    for (const entry of CLAUDE_FAMILY_REACHABILITY) {
      const hasShortfall = entry.reachedBy.length === 0 || entry.unreachedCensusKinds.length > 0;
      if (hasShortfall) {
        expect(entry.shortfallReason).not.toBeNull();
        expect((entry.shortfallReason ?? "").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("names only real census kinds as unreached", () => {
    const censusKinds = new Set<NormalizedEventKind>(NORMALIZED_EVENT_KINDS);
    let named = 0;
    for (const entry of CLAUDE_FAMILY_REACHABILITY) {
      for (const kind of entry.unreachedCensusKinds) {
        expect(censusKinds.has(kind)).toBe(true);
        named += 1;
      }
    }
    // A ledger that named nothing would be a family-level claim with no
    // actionable content; the point is to tell the next wire probe what to
    // look for.
    expect(named).toBeGreaterThan(0);
  });

  it("never claims an unreached kind is also reached", () => {
    const reachedKinds = new Set<NormalizedEventKind>();
    for (const normalization of CLAUDE_FRAME_NORMALIZATION_BY_KIND.values()) {
      if (normalization.disposition === "normalized" && normalization.normalizedKind !== null) {
        reachedKinds.add(normalization.normalizedKind);
      }
    }
    for (const entry of CLAUDE_FAMILY_REACHABILITY) {
      for (const kind of entry.unreachedCensusKinds) {
        expect(reachedKinds.has(kind)).toBe(false);
      }
    }
  });

  it("records artifact_publication as reached by no provider frame, by corpus routing", () => {
    const entry = CLAUDE_FAMILY_REACHABILITY.find(
      (candidate) => candidate.family === "artifact_publication",
    );
    expect(entry).toBeDefined();
    expect(entry?.reachedBy).toStrictEqual([]);
    // The corpus routes both file-change census kinds to `tool_activity`, which
    // is why no Claude row can target the publication family without
    // contradicting the taxonomy.
    expect(EVENT_DISPOSITION_BY_KIND.get("diff")?.category).toBe("tool_activity");
    expect(EVENT_DISPOSITION_BY_KIND.get("command_output")?.category).toBe("tool_activity");
  });
});

// --------------------------------------------------------------------------
// T3.11 — emission routing, family classification, subagent lifecycle.
// --------------------------------------------------------------------------

describe("resolveClaudeFrameEmissionRoute (T3.11 P0-1)", () => {
  function makeDiagnostics() {
    return new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
  }

  it("mirrors the mapping table's verdict for every censused kind — the route arm IS the row's disposition", () => {
    const diagnostics = makeDiagnostics();
    for (const frameKind of CLAUDE_WIRE_FRAME_KINDS) {
      const row = CLAUDE_FRAME_NORMALIZATION_BY_KIND.get(frameKind);
      const route = resolveClaudeFrameEmissionRoute(frameKind, diagnostics);
      if (row?.disposition === "not-evented") {
        expect(route.route, frameKind).toBe("not-evented");
      } else if (row?.emissionReadiness === "payload-variant-pending") {
        expect(route.route, frameKind).toBe("diagnostic");
        if (route.route === "diagnostic") {
          expect(route.record.kind, frameKind).toBe("payload_variant_pending");
        }
      } else {
        expect(route.route, frameKind).toBe("emit");
      }
    }
    // A censused kind never lands on the unmapped arm.
    expect(diagnostics.recentRecordsOfKind("unmapped_wire_kind")).toHaveLength(0);
  });

  it("routes an unmapped kind to the diagnostic default branch — emitted, never thrown, never enveloped", () => {
    const diagnostics = makeDiagnostics();
    const route = resolveClaudeFrameEmissionRoute("system/unheard_of", diagnostics);
    expect(route.route).toBe("diagnostic");
    if (route.route === "diagnostic") {
      expect(route.record.kind).toBe("unmapped_wire_kind");
      expect(route.record.rawWireType).toBe("system/unheard_of");
      expect(route.record.provider).toBe("claude");
    }
    expect(diagnostics.emittedRecordCount()).toBe(1);
    // The bare resolver keeps its throwing contract for direct misuse; the
    // diagnostic route is the driver-core entry point.
    expect(() => normalizeClaudeWireFrame("system/unheard_of")).toThrow(
      UnknownClaudeWireFrameError,
    );
  });
});

describe("classifyClaudeFrameFamilyForRouting (T3.11, NS-91)", () => {
  it("classifies every censused kind plus the two lifecycle signals — none falls to unknown", () => {
    const routableKinds = [
      ...CLAUDE_WIRE_FRAME_KINDS,
      CLAUDE_SUBAGENT_START_SIGNAL,
      CLAUDE_SUBAGENT_STOP_SIGNAL,
    ];
    for (const frameKind of routableKinds) {
      expect(
        classifyClaudeFrameFamilyForRouting(frameKind, { cumulativeUsage: undefined }).scope,
        frameKind,
      ).not.toBe("unknown");
    }
  });

  it("classifies the retry / rate-limit / init frames and the control channel connection-scoped — routable without a thread id", () => {
    for (const connectionScopedKind of [
      "system/api_retry",
      "system/rate_limit_event",
      "system/init",
      "control_request/can_use_tool",
      "control_response/success",
    ]) {
      expect(
        classifyClaudeFrameFamilyForRouting(connectionScopedKind, { cumulativeUsage: undefined }),
      ).toEqual({
        scope: "connection",
      });
    }
  });

  it("classifies the compaction marker thread-scoped usage and the lifecycle signals thread-scoped lifecycle", () => {
    expect(
      classifyClaudeFrameFamilyForRouting("system/compact_boundary", {
        cumulativeUsage: undefined,
      }),
    ).toEqual({
      scope: "thread",
      capability: "usage",
    });
    for (const lifecycleSignal of [CLAUDE_SUBAGENT_START_SIGNAL, CLAUDE_SUBAGENT_STOP_SIGNAL]) {
      expect(
        classifyClaudeFrameFamilyForRouting(lifecycleSignal, { cumulativeUsage: undefined }),
      ).toEqual({
        scope: "thread",
        capability: "lifecycle",
      });
    }
  });

  it("classifies an unlisted shape unknown — never presumed connection-scoped", () => {
    expect(
      classifyClaudeFrameFamilyForRouting("novel/unheard_of", { cumulativeUsage: undefined }),
    ).toEqual({ scope: "unknown" });
  });

  it("re-classifies a thread-scoped frame that CARRIES a usage reading as thread-scoped usage", () => {
    // This provider reserves no frame kind for usage: the cumulative readings
    // ride the same frames as assistant content. Classifying by kind alone
    // would route a registered child's usage-bearing frame to plain transcript
    // suppression, and the child's spend would be scoped out of existence
    // instead of metered under its own attribution.
    expect(
      classifyClaudeFrameFamilyForRouting("system/task_progress", {
        cumulativeUsage: { namedTurnId: null, cumulative: { input: 10 } },
      }),
    ).toEqual({ scope: "thread", capability: "usage" });

    // Same kind, no reading: unchanged.
    expect(
      classifyClaudeFrameFamilyForRouting("system/task_progress", { cumulativeUsage: null }),
    ).toEqual({ scope: "thread", capability: "content" });
  });

  it("a usage reading never PROMOTES a connection-scoped or unlisted kind into a thread-scoped one", () => {
    const carriedReading = { cumulativeUsage: { namedTurnId: null, cumulative: { input: 10 } } };
    // Connection-scoped frames route and meter without an identity already.
    expect(classifyClaudeFrameFamilyForRouting("system/init", carriedReading)).toEqual({
      scope: "connection",
    });
    // And an unlisted kind stays fail-closed: a frame does not become routable
    // because it happened to carry a number.
    expect(classifyClaudeFrameFamilyForRouting("novel/unheard_of", carriedReading)).toEqual({
      scope: "unknown",
    });
  });
});

describe("normalizeClaudeSubagentLifecycle (T3.11, NS-91 + B10)", () => {
  it("normalizes SubagentStart into subagent.started with the parent-linked announcement", () => {
    const normalization = normalizeClaudeSubagentLifecycle(
      { signal: "SubagentStart", subagentId: "subagent-7", parentToolUseId: "toolu_01" },
      "session-thread",
    );
    expect(normalization.family).toBe("tool_activity");
    expect(normalization.eventType).toBe("subagent.started");
    expect(normalization.parentToolUseId).toBe("toolu_01");
    // The arrival in the parent's own stream IS the declared lineage, and the
    // subagent id doubles as the child thread identity.
    expect(normalization.announcement).toEqual({
      childThreadId: "subagent-7",
      declaredParentThreadId: "session-thread",
      subagentId: "subagent-7",
    });
  });

  it("normalizes SubagentStop into subagent.completed with no announcement", () => {
    const normalization = normalizeClaudeSubagentLifecycle(
      { signal: "SubagentStop", subagentId: "subagent-7", parentToolUseId: "toolu_01" },
      "session-thread",
    );
    expect(normalization.eventType).toBe("subagent.completed");
    expect(normalization.announcement).toBeNull();
  });

  it("both lifecycle emissions target registered tool_activity event types — the pair survives suppression", () => {
    for (const [signal, expectedEventType] of [
      ["SubagentStart", "subagent.started"],
      ["SubagentStop", "subagent.completed"],
    ] as const) {
      const normalization = normalizeClaudeSubagentLifecycle(
        { signal, subagentId: "subagent-7", parentToolUseId: null },
        "session-thread",
      );
      expect(normalization.eventType).toBe(expectedEventType);
      // Registered union members on the tool_activity roster — the child's
      // only timeline presence, and it survives transcript suppression.
      expect(TOOL_ACTIVITY_EVENT_TYPES).toContain(normalization.eventType);
    }
  });
});

// --------------------------------------------------------------------------
// T3.14 P1-1 / P1-2-driver — the terminal-emission boundary.
// --------------------------------------------------------------------------
//
// Spec coverage under test:
//   `Spec-006 §Run Lifecycle (run_lifecycle)` — a daemon-initiated close is
//     stamped `intendedClose` so the recovery classifier reads a clean shutdown
//     as a clean shutdown rather than as a crash.
//   `Spec-005 §Required Behavior` — at most one terminal per
//     `(runId, runVersion)` epoch reaches the emission pipeline, so the ordinary
//     post-interrupt double is absorbed at the driver rather than failing loud
//     against Plan-006's partial unique index.

describe("ClaudeTerminalEmissionGate (T3.14 P1-1, P1-2-driver)", () => {
  const PROJECTED_ROUTE = { decision: "project" } as const;

  function terminalFrame(overrides: Partial<ClaudeTerminalRunFrame> = {}): ClaudeTerminalRunFrame {
    return {
      runId: "run-1",
      runVersion: 1,
      rawWireType: "turn/completed",
      route: PROJECTED_ROUTE,
      ...overrides,
    };
  }

  it("stamps `intendedClose: false` for a terminal no close preceded", () => {
    const gate = new ClaudeTerminalEmissionGate();

    expect(gate.admitTerminalFrame(terminalFrame())).toStrictEqual({
      emit: true,
      runId: "run-1",
      runVersion: 1,
      intendedClose: false,
    });
  });

  it("stamps `intendedClose: true` once a daemon-initiated close is signalled", () => {
    const gate = new ClaudeTerminalEmissionGate();

    gate.signalIntendedClose();

    expect(gate.intendedCloseSignalled()).toBe(true);
    expect(gate.admitTerminalFrame(terminalFrame())).toMatchObject({
      emit: true,
      intendedClose: true,
    });
  });

  it("suppresses a second terminal for the SAME epoch", () => {
    // The ordinary post-interrupt double. Absorbed here rather than left to
    // fail loud against the schema backstop on a condition the driver could
    // have handled.
    const gate = new ClaudeTerminalEmissionGate();
    gate.admitTerminalFrame(terminalFrame());

    expect(gate.admitTerminalFrame(terminalFrame({ rawWireType: "turn/failed" }))).toStrictEqual({
      emit: false,
      suppressionReason: "duplicate-terminal-epoch",
    });
    expect(gate.hasSettledEpoch("run-1", 1)).toBe(true);
  });

  it("admits a NEW epoch for the same run", () => {
    // The key is the epoch, not the run: a re-dispatched run version is a
    // different settlement and must not be swallowed by its predecessor's.
    const gate = new ClaudeTerminalEmissionGate();
    gate.admitTerminalFrame(terminalFrame());

    expect(gate.admitTerminalFrame(terminalFrame({ runVersion: 2 }))).toMatchObject({ emit: true });
    expect(gate.hasSettledEpoch("run-1", 2)).toBe(true);
  });

  it("settles no run for a frame the router did not route to the session's thread", () => {
    // Routing is CONSUMED, never re-decided: a child thread's terminal must not
    // settle the parent's run, and this boundary adds no second source of truth
    // for whose stream a frame came from.
    const gate = new ClaudeTerminalEmissionGate();

    const decision = gate.admitTerminalFrame(
      terminalFrame({ route: { decision: "suppress-child-transcript", childThreadId: "child-1" } }),
    );

    expect(decision).toStrictEqual({ emit: false, suppressionReason: "not-the-session-thread" });
    // And it consumed no epoch, so the parent's own terminal still settles.
    expect(gate.hasSettledEpoch("run-1", 1)).toBe(false);
  });

  it("evicts oldest-first so the memory stays proportional to the hazard", () => {
    // A long session's run count is unbounded while the window a duplicate
    // arrives in is not.
    const gate = new ClaudeTerminalEmissionGate({ settledEpochMemory: 2 });
    gate.admitTerminalFrame(terminalFrame({ runId: "run-a" }));
    gate.admitTerminalFrame(terminalFrame({ runId: "run-b" }));
    gate.admitTerminalFrame(terminalFrame({ runId: "run-c" }));

    expect(gate.hasSettledEpoch("run-a", 1)).toBe(false);
    expect(gate.hasSettledEpoch("run-b", 1)).toBe(true);
    expect(gate.hasSettledEpoch("run-c", 1)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// T3.16 — typed provider usage-limit signal, Claude leg (I-005-6)
// --------------------------------------------------------------------------
//
// Frames below carry the member set `docs/reference/provider-wire/claude.md`
// records verbatim for the retry channel: `{ type: "system", subtype:
// "api_retry", attempt, max_retries, retry_delay_ms, error_status, error }`,
// with `error_status` sitting beside the typed `error`.

/** A fixed observation clock, so the derived boundary is asserted, not approximated. */
const RETRY_OBSERVED_AT_EPOCH_MS = Date.parse("2026-08-31T12:00:00.000Z");

// The default names the ladder's FINAL announced attempt, and that value is
// LOAD-BEARING rather than arbitrary. Every negative control below asserts
// `null` for a reason about the typed `error` member; a mid-ladder default would
// let the attempt gate satisfy all of them, and the block would keep passing
// while it silently stopped testing what it claims. The reference pins this
// frame's member NAMES and no example values, so nothing transcribed moves here.
function apiRetryFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: 10,
    max_retries: 10,
    retry_delay_ms: 60000,
    error_status: 429,
    error: "rate_limit",
    ...overrides,
  };
}

/** The whole signal a recognized, exhausted-ladder frame composes at the fixed clock. */
const EXHAUSTED_LADDER_SIGNAL = {
  cause: "plan-allowance-exhausted",
  resetBoundary: { resetsAt: "2026-08-31T12:01:00.000Z", provenance: "runtime-derived" },
} as const;

describe("classifyClaudeUsageLimitSignal — typed-only recognition on the retry frame", () => {
  it("names the frame discriminants by identity rather than by repeated literals", () => {
    expect(CLAUDE_API_RETRY_FRAME_TYPE).toBe("system");
    expect(CLAUDE_API_RETRY_FRAME_SUBTYPE).toBe("api_retry");
    expect(CLAUDE_USAGE_LIMIT_RETRY_ERROR_MEMBER).toBe("rate_limit");
  });

  it("emits the signal with a RUNTIME-DERIVED boundary composed from the backoff", () => {
    // The provider states a delay, not a reset. The instant is still worth
    // arming a schedule on, and the provenance stamp is what stops a consumer
    // showing it as the provider's own answer.
    expect(classifyClaudeUsageLimitSignal(apiRetryFrame(), RETRY_OBSERVED_AT_EPOCH_MS)).toEqual({
      cause: "plan-allowance-exhausted",
      resetBoundary: { resetsAt: "2026-08-31T12:01:00.000Z", provenance: "runtime-derived" },
    });
  });

  it("differs from the Codex leg in PROVENANCE, which is the whole point of the stamp", () => {
    const claudeSignal = classifyClaudeUsageLimitSignal(
      apiRetryFrame(),
      RETRY_OBSERVED_AT_EPOCH_MS,
    );
    expect(claudeSignal?.resetBoundary?.provenance).toBe("runtime-derived");
    expect(claudeSignal?.resetBoundary?.provenance).not.toBe("provider-stated");
  });

  it("stays PURE — the same frame and clock always compose the same boundary", () => {
    const first = classifyClaudeUsageLimitSignal(apiRetryFrame(), RETRY_OBSERVED_AT_EPOCH_MS);
    const second = classifyClaudeUsageLimitSignal(apiRetryFrame(), RETRY_OBSERVED_AT_EPOCH_MS);
    expect(first).toEqual(second);
  });

  it("fires ONLY on the ladder's final announced attempt, never mid-ladder", () => {
    // `Spec-017 §Provider-limit pacing and durable resumption (SA-40)` parks the
    // phase IMMEDIATELY on any recognized signal and arms a schedule only for a
    // provider-reported boundary — and this leg's boundary is runtime-derived.
    // So a signal off `attempt: 1, max_retries: 10`, where the provider is still
    // retrying internally, is an UNSCHEDULED park of work that was about to
    // complete. Asserted across the ladder rather than at one point, so a gate
    // that merely moved the threshold would fail here.
    for (const attempt of [1, 2, 9]) {
      expect(
        classifyClaudeUsageLimitSignal(
          apiRetryFrame({ attempt, max_retries: 10 }),
          RETRY_OBSERVED_AT_EPOCH_MS,
        ),
      ).toBeNull();
    }
    // The final announced retry — the point the provider has committed to
    // failing the request on the next refusal — and anything past it, because a
    // ladder that overran its own announced ceiling has certainly reached it.
    for (const attempt of [10, 11]) {
      expect(
        classifyClaudeUsageLimitSignal(
          apiRetryFrame({ attempt, max_retries: 10 }),
          RETRY_OBSERVED_AT_EPOCH_MS,
        ),
      ).toEqual(EXHAUSTED_LADDER_SIGNAL);
    }
  });

  it("takes the null path when the ladder members are absent, malformed, or announce no ladder", () => {
    // FAIL-CLOSED on this axis's own rule: silence means "not known to be
    // limited", never "known not to be limited". The run continues and an
    // eventual failure takes the ordinary failure path, which is the recoverable
    // direction — the opposite of parking a run against a boundary composed from
    // members the frame did not state.

    // A frame carrying NEITHER member. Written out rather than built from the
    // fixture, because the property under test is the absence of keys the
    // fixture always supplies — the pair is no longer merely unread, so a frame
    // that omits it is not recognized at all.
    expect(
      classifyClaudeUsageLimitSignal(
        { type: "system", subtype: "api_retry", retry_delay_ms: 60000, error: "rate_limit" },
        RETRY_OBSERVED_AT_EPOCH_MS,
      ),
    ).toBeNull();

    const unusableLadders: readonly Record<string, unknown>[] = [
      { attempt: undefined, max_retries: 10 },
      { attempt: 10, max_retries: undefined },
      // The string form a JSON producer can emit for a number: `"10" >= "10"` is
      // true, so a comparison written without the numeric guard would emit here.
      { attempt: "10", max_retries: "10" },
      { attempt: "10", max_retries: 10 },
      { attempt: 10, max_retries: null },
      { attempt: Number.NaN, max_retries: 10 },
      { attempt: 10, max_retries: [10] },
      // `max_retries: 0` announces NO ladder at all. A bare finite check would
      // let `0 >= 0` emit a signal off a frame stating there was nothing to
      // exhaust — the one value the positive-number guard is load-bearing at.
      { attempt: 0, max_retries: 0 },
      { attempt: -1, max_retries: -1 },
    ];
    for (const ladder of unusableLadders) {
      expect(
        classifyClaudeUsageLimitSignal(apiRetryFrame(ladder), RETRY_OBSERVED_AT_EPOCH_MS),
      ).toBeNull();
    }
  });

  it("returns the CAUSE ALONE when the frame carries no usable delay", () => {
    for (const retryDelayMs of [undefined, null, 0, -1, Number.NaN, "60000", {}]) {
      expect(
        classifyClaudeUsageLimitSignal(
          apiRetryFrame({ retry_delay_ms: retryDelayMs }),
          RETRY_OBSERVED_AT_EPOCH_MS,
        ),
      ).toEqual({ cause: "plan-allowance-exhausted" });
    }
  });

  it("returns the CAUSE ALONE when the observation clock names no instant", () => {
    for (const observedAt of [Number.NaN, Number.POSITIVE_INFINITY, 1e18]) {
      expect(classifyClaudeUsageLimitSignal(apiRetryFrame(), observedAt)).toEqual({
        cause: "plan-allowance-exhausted",
      });
    }
  });

  it("SEEDED DISCRIMINATING CONTROL — usage-limit prose plus a 429 produce NO signal", () => {
    // Every one of these carries the HTTP status a status-matcher would fire on
    // and the prose a text-matcher would fire on, while the typed `error` member
    // says something else. All must be silent.
    const proseAndStatusFrames: readonly unknown[] = [
      apiRetryFrame({
        error: "server_error",
        error_status: 429,
        message: "Rate limit exceeded — usage limit reached, retry after 60s",
      }),
      apiRetryFrame({
        error: "overloaded",
        error_status: 429,
        detail: "You have exceeded your plan's usage limit.",
      }),
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        error_status: 429,
        exitCode: 1,
        result: "Claude usage limit reached. Your limit will reset at 3pm.",
      },
      { type: "system", subtype: "api_error", error_status: 429, error: "rate_limit" },
    ];
    for (const frame of proseAndStatusFrames) {
      expect(classifyClaudeUsageLimitSignal(frame, RETRY_OBSERVED_AT_EPOCH_MS)).toBeNull();
    }
  });

  it("does not read `error_status` — a bare 429 is not evidence an allowance is spent", () => {
    // Positive control for the negative claim above: the SAME frame recognized
    // on its typed member is silent the moment that member changes, while the
    // status stays 429 throughout.
    expect(
      classifyClaudeUsageLimitSignal(
        apiRetryFrame({ error_status: 429 }),
        RETRY_OBSERVED_AT_EPOCH_MS,
      ),
    ).not.toBeNull();
    expect(
      classifyClaudeUsageLimitSignal(
        apiRetryFrame({ error: "overloaded", error_status: 429 }),
        RETRY_OBSERVED_AT_EPOCH_MS,
      ),
    ).toBeNull();
    // And the typed member alone is enough — no status present at all.
    const { error_status: _omitted, ...withoutStatus } = apiRetryFrame();
    expect(
      classifyClaudeUsageLimitSignal(withoutStatus, RETRY_OBSERVED_AT_EPOCH_MS),
    ).not.toBeNull();
  });

  it("recognizes EXACTLY ONE member of the pinned typed-error census", () => {
    // Checked against the census fixture rather than a list written down here,
    // so a member added to the pin cannot quietly land in the recognized set —
    // and so the deliberate exclusions are checked rather than merely asserted.
    // `billing_error` is the sharpest of them: a payment fault is a human's to
    // fix, so a park against a reset boundary would never lift.
    const recognized = CLAUDE_API_RETRY_TYPED_ERRORS.filter(
      (errorMember) =>
        classifyClaudeUsageLimitSignal(
          apiRetryFrame({ error: errorMember }),
          RETRY_OBSERVED_AT_EPOCH_MS,
        ) !== null,
    );
    expect(recognized).toEqual([CLAUDE_USAGE_LIMIT_RETRY_ERROR_MEMBER]);
    expect(CLAUDE_API_RETRY_TYPED_ERRORS).toContain("billing_error");
  });

  it("RECOGNIZES rather than REJECTS — an unfamiliar member takes the ordinary null path", () => {
    // The reference grades the `error` union's arity Derived, so failing closed
    // on an unrecognized member would turn a set the evidence cannot close into
    // an enforced allow-list. Silence is the same answer as for any other shape
    // the driver has not been taught, and it throws nothing.
    expect(() =>
      classifyClaudeUsageLimitSignal(
        apiRetryFrame({ error: "some_future_member" }),
        RETRY_OBSERVED_AT_EPOCH_MS,
      ),
    ).not.toThrow();
    expect(
      classifyClaudeUsageLimitSignal(
        apiRetryFrame({ error: "some_future_member" }),
        RETRY_OBSERVED_AT_EPOCH_MS,
      ),
    ).toBeNull();
  });

  it("yields NOTHING — never a default-caused signal — on unparseable or absent input", () => {
    const unrecognized: readonly unknown[] = [
      null,
      undefined,
      "api_retry",
      42,
      [],
      [apiRetryFrame()],
      {},
      apiRetryFrame({ type: "assistant" }),
      apiRetryFrame({ subtype: "api_error" }),
      apiRetryFrame({ error: undefined }),
      apiRetryFrame({ error: null }),
      apiRetryFrame({ error: 429 }),
      apiRetryFrame({ error: { type: "rate_limit" } }),
    ];
    for (const frame of unrecognized) {
      expect(classifyClaudeUsageLimitSignal(frame, RETRY_OBSERVED_AT_EPOCH_MS)).toBeNull();
    }
  });
});
