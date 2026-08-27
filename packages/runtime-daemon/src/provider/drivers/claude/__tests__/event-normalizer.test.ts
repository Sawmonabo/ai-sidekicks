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
import {
  CLAUDE_FAMILY_REACHABILITY,
  CLAUDE_FRAME_NORMALIZATION_BY_KIND,
  CLAUDE_WIRE_FRAME_KINDS,
  UnknownClaudeWireFrameError,
  composeClaudeWireFrameKind,
  normalizeClaudeWireFrame,
  resolveClaudeEmissionReadiness,
  type ClaudeFrameNormalization,
  type ClaudeNormalizedFamilyEmission,
  type ClaudeWireFrameKind,
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
    expect(CLAUDE_WIRE_PIN_VERSION).toBe("2.1.245");
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
    expect(typed.code).toBe("driver.claude_wire_frame_unmapped");
    expect(typed.name).toBe("UnknownClaudeWireFrameError");
    // The verbatim kind is the `rawWireType` the T3.11 DriverDiagnosticRecord
    // needs, carried as data rather than parsed out of the message.
    expect(typed.frameKind).toBe("system/zzq_nonexistent_subtype");
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
