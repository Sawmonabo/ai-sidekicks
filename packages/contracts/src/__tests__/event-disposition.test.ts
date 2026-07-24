// Plan-006 T1.8 — NormalizedEventKind disposition registry exhaustiveness
// suite.
//
// Backstops Spec-006 §Event Type Summary (the taxonomy the dispositions
// target, incl. the Total enumerated event types prose) through the
// Plan-006 §Event-Kind Disposition Table — the disposition contract the
// Plan-005 T3.5/T3.10 normalizers (the B10 bundle) consume under the
// no-silent-capability-loss default. Coverage shape:
//   • Registry keys set-equal NORMALIZED_EVENT_KINDS in BOTH directions
//     (sorted-array equality, never a bare size assertion): every census
//     kind present AND no extra key. The Record-keyed source already makes
//     a missing kind a compile error; the runtime check additionally
//     catches a census-tuple/union drift.
//   • Full 35-row content census: each kind's entry pinned against the
//     plan table (which kinds, which targets, which reasons) — the
//     registry cannot drift from the table without this suite failing.
//   • Structural discipline over the LIVE registry, independent of the
//     pinned tables: every adopt/rename names a valid EventCategory
//     (T1.1's 19-entry union) and carries exactly one of `eventType` XOR
//     `typePending: "B18"`; every named eventType is census-registered
//     with a matching SESSION_EVENT_CATEGORY_BY_TYPE category; every
//     correlate/discard carries a non-empty reason and NO taxonomy target.
//   • The typePending census set equals — by exact set-equality — the
//     eight B18-pending kinds. This is the shrink-only ratchet in its
//     pinned PRE-flip state: T1.10 flips the registry entries to their
//     B18-minted literals and shrinks this pin to empty in a strictly-
//     later commit. Pinning BY VALUE is what makes the ratchet
//     shrink-only: a registry flip that skips the test edit fails HERE,
//     forcing registry and pin to move together. The converse direction
//     — a census widening (SessionEventType + category rows) that skips
//     the registry flip — is NOT caught here: an un-flipped entry is
//     still a structurally valid `typePending` row, so every assertion
//     in this file stays green. session-event.test.ts owns that side,
//     via its 141-type / 19-category size pins and one negative control
//     per B18-pending literal.
//   • The four illegal EventKindDisposition shapes its JSDoc calls
//     unrepresentable are pinned at COMPILE time (`@ts-expect-error`,
//     self-verifying via TS2578), so the `?: never` keys and the
//     `readonly` modifiers cannot be stripped silently.
//   • EVENT_DISPOSITION_BY_KIND is a ReadonlyMap with the same
//     `.get()`-safety as SESSION_EVENT_CATEGORY_BY_TYPE (prototype-chain
//     walks resolve to `undefined`).
// Out of scope, deliberately: the nine wire-level Claude system-channel
// discards and the current-wire delta families (incl. the
// `worker_shutting_down` orphan — the ninth B18 target, closed by T1.10's
// union widening alone) are Plan-005 normalizer wire-layer concerns, not
// registry keys — pinned below as `.get()` negative controls; the unknown
// residual is backstopped by the Plan-005 default-branch diagnostic (B10).
import { describe, expect, it } from "vitest";

import {
  EVENT_DISPOSITION_BY_KIND,
  EventCategorySchema,
  NORMALIZED_EVENT_KINDS,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  type EventKindDisposition,
  type NormalizedEventKind,
} from "../event.js";

// Live-registry partitions by disposition class, computed once — the
// structural suites below run over these (the LIVE map, not the pinned
// tables), so a registry defect fails even where the pins were edited in
// tandem.
const registryEntries = [...EVENT_DISPOSITION_BY_KIND.entries()];
const kindsWithDisposition = (wanted: EventKindDisposition["disposition"]): NormalizedEventKind[] =>
  registryEntries
    .filter(([, entry]) => entry.disposition === wanted)
    .map(([kind]) => kind)
    .sort();

describe("EVENT_DISPOSITION_BY_KIND — census exhaustiveness (T1.8)", () => {
  it("registry keys set-equal NORMALIZED_EVENT_KINDS in both directions", () => {
    // Sorted-array equality is the both-direction set check in one
    // assertion: every census kind present (⊇) AND no extra registry key
    // (⊆) — never a bare size comparison, which would pass on a same-size
    // swap of a census kind for a stray key.
    const registryKinds = [...EVENT_DISPOSITION_BY_KIND.keys()].sort();
    const censusKinds = [...NORMALIZED_EVENT_KINDS].sort();
    expect(registryKinds).toEqual(censusKinds);
    // No intra-census duplicates. Only the census TUPLE can carry one —
    // the registry side is Map keys, unique by construction. A duplicated
    // tuple entry already fails the equality above, but as an opaque
    // array diff; this guard makes the failure name the duplication.
    expect(new Set(censusKinds).size).toBe(censusKinds.length);
  });

  it("census tuple pins the plan table's Count row (35 normalized kinds)", () => {
    // Supplemental to the set-equality above (NOT a bare-size substitute):
    // pins the tuple to the plan table's `Count: … = 35` row so a census
    // amendment must touch the plan table and this suite together.
    expect(NORMALIZED_EVENT_KINDS).toHaveLength(35);
  });

  it.each([
    // The three non-default disposition classes, pinned as exact kind
    // sets: `adopt`/`rename` is the no-silent-capability-loss DEFAULT, so
    // growth of a lossy class must be a loud, deliberate edit here.
    ["rename", ["rate_limits"]],
    ["correlate", ["user_text"]],
    ["discard", ["content_block_start", "content_block_stop"]],
  ] as const)("pins the %s census exactly: %j", (dispositionClass, expectedKinds) => {
    expect(kindsWithDisposition(dispositionClass)).toEqual([...expectedKinds].sort());
  });

  it("the four disposition classes partition the census (adopt is the 31-kind remainder)", () => {
    const lossyOrRenamed = new Set([
      "rate_limits",
      "user_text",
      "content_block_start",
      "content_block_stop",
    ]);
    const expectedAdopt = NORMALIZED_EVENT_KINDS.filter((kind) => !lossyOrRenamed.has(kind)).sort();
    expect(kindsWithDisposition("adopt")).toEqual(expectedAdopt);
    // Union of the four classes covers the census exactly — an entry whose
    // disposition fell outside the four values would be missing from the
    // union and fail the set equality.
    const unioned = [
      ...kindsWithDisposition("adopt"),
      ...kindsWithDisposition("rename"),
      ...kindsWithDisposition("correlate"),
      ...kindsWithDisposition("discard"),
    ].sort();
    expect(unioned).toEqual([...NORMALIZED_EVENT_KINDS].sort());
  });
});

describe("EventKindDisposition discipline over the live registry (T1.8)", () => {
  const adoptRenameEntries = registryEntries.filter(
    ([, entry]) => entry.disposition === "adopt" || entry.disposition === "rename",
  );
  const foldedEntries = registryEntries.filter(
    ([, entry]) => entry.disposition === "correlate" || entry.disposition === "discard",
  );

  it.each(adoptRenameEntries)(
    "%s: valid EventCategory + eventType XOR typePending",
    (kind, entry) => {
      if (entry.disposition !== "adopt" && entry.disposition !== "rename") {
        throw new Error(`expected an adopt/rename entry for ${kind}, got ${entry.disposition}`);
      }
      // Category names a member of T1.1's canonical 19-entry union.
      expect(EventCategorySchema.safeParse(entry.category).success).toBe(true);
      // Exactly one of eventType / typePending — the runtime leg of the
      // XOR the `?: never` union arms enforce at compile time (guards a
      // cast-defeat or future refactor of the source Record).
      const carriesEventType = Object.hasOwn(entry, "eventType");
      const carriesTypePending = Object.hasOwn(entry, "typePending");
      expect(Number(carriesEventType) + Number(carriesTypePending)).toBe(1);
      if (carriesEventType) {
        const eventType = entry.eventType;
        expect(eventType).toBeDefined();
        if (eventType !== undefined) {
          // One lookup proves both halves: `.get()` returns `undefined`
          // for an unregistered literal (so the target must be a
          // registered SessionEventType), and the returned category must
          // equal the row's own — the I-006-1-01 bijection extended to
          // disposition targets.
          expect(SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType)).toBe(entry.category);
        }
      } else {
        expect(entry.typePending).toBe("B18");
      }
      // No `reason`: its contract role is justifying the two LOSSY
      // dispositions, so an adopt/rename carrying one is the mirror of the
      // folded case's no-taxonomy-target check below. Asserted over the
      // live registry, independent of the pin tables.
      expect(Object.hasOwn(entry, "reason")).toBe(false);
    },
  );

  it.each(foldedEntries)("%s: non-empty reason and NO taxonomy target", (kind, entry) => {
    if (entry.disposition !== "correlate" && entry.disposition !== "discard") {
      throw new Error(`expected a correlate/discard entry for ${kind}, got ${entry.disposition}`);
    }
    expect(typeof entry.reason).toBe("string");
    expect(entry.reason.trim().length).toBeGreaterThan(0);
    // No category, eventType, or typePending: a lossy row smuggling a
    // taxonomy target would silently re-enter the adopt path.
    expect(Object.hasOwn(entry, "category")).toBe(false);
    expect(Object.hasOwn(entry, "eventType")).toBe(false);
    expect(Object.hasOwn(entry, "typePending")).toBe(false);
  });

  // The eight census kinds whose exact SessionEventType the 2026-07-22
  // Spec-006 B18 census amendment minted (the literals exist in Spec-006
  // §Event Type Summary; registration in this package rides T1.10). The
  // ninth B18 target — the `worker_shutting_down` delta orphan's
  // `run.worker_shutdown` — is wire-layer, outside the registry, so this
  // machine pin covers only the eight census kinds. Deliberately
  // duplicated here rather than derived from the registry: the pin BY
  // VALUE is what makes the ratchet shrink-only — a registry flip without
  // the matching test edit fails loud, and the census amendment can only
  // REMOVE names from this set as each literal lands (T1.10 shrinks it to
  // empty).
  const B18_PENDING_KINDS: readonly NormalizedEventKind[] = [
    "init",
    "turn_start",
    "session_status",
    "notification",
    "api_retry",
    "compact_boundary",
    "model_rerouted",
    "thread_renamed",
  ];

  it("typePending census set equals exactly the eight B18-pending kinds (shrink-only ratchet)", () => {
    const pendingKinds = registryEntries
      .filter(([, entry]) => Object.hasOwn(entry, "typePending"))
      .map(([kind]) => kind)
      .sort();
    expect(pendingKinds).toEqual([...B18_PENDING_KINDS].sort());
  });
});

// --------------------------------------------------------------------------
// Compile-time shape pins — EventKindDisposition's illegal states.
// --------------------------------------------------------------------------
//
// The union's JSDoc claims four shapes are unrepresentable and that every
// property is `readonly`. Everything above checks the live registry's
// VALUES, so nothing yet verifies the COMPILER half — and the `?: never`
// keys plus the `readonly` modifiers are exactly what a future edit might
// strip: the plan's flat `{ disposition; category?; eventType?;
// typePending?; reason? }` sketch reads as if they were plain optionals.
//
// Self-verifying: an UNUSED `@ts-expect-error` is itself a TS2578 error, so
// if any rejection below ever became legal, the `tsc -p tsconfig.test.json`
// leg (the package's `typecheck` script — vitest strips types and does NOT
// run it) fails. No `as never` / `as any` escape hatch is used — that would
// silence the very error each case exists to surface. Each binding is read
// by a runtime `expect` to keep it used for lint; the load-bearing check is
// the compile.

describe("EventKindDisposition — compile-time shape pins (T1.8)", () => {
  it("rejects an adopt/rename row carrying BOTH eventType and typePending", () => {
    const bothTargets: EventKindDisposition = {
      disposition: "adopt",
      category: "run_lifecycle",
      eventType: "run.completed",
      // @ts-expect-error a row cannot claim a registered literal AND pend on B18: `typePending?: never` on the eventType arm, `eventType?: never` on the pending arm — no single arm admits both keys
      typePending: "B18",
    };
    expect(bothTargets.disposition).toBe("adopt");
  });

  it("rejects an adopt/rename row carrying NEITHER eventType nor typePending", () => {
    // @ts-expect-error the arm split forbids neither-present: `eventType` is required on one arm and `typePending` on the other, so a category-only row matches neither
    const noTarget: EventKindDisposition = {
      disposition: "rename",
      category: "usage_telemetry",
    };
    expect(noTarget.disposition).toBe("rename");
  });

  it("rejects a `reason` on an adopt/rename row", () => {
    // @ts-expect-error `reason?: never` on both adopt/rename arms — its contract role is justifying the two LOSSY dispositions, and a taxonomy target needs no justification beyond itself
    const justifiedAdopt: EventKindDisposition = {
      disposition: "adopt",
      category: "tool_activity",
      eventType: "tool.result",
      reason: "an adopt row does not carry a justification",
    };
    expect(justifiedAdopt.disposition).toBe("adopt");
  });

  it("rejects a taxonomy target on a correlate/discard row", () => {
    const smuggledTarget: EventKindDisposition = {
      disposition: "correlate",
      reason: "folds into the originating row via correlation_id",
      // @ts-expect-error `category?: never` on the correlate arm — a lossy row smuggling a taxonomy target would silently re-enter the adopt path
      category: "tool_activity",
    };
    expect(smuggledTarget.disposition).toBe("correlate");
  });

  it("rejects a property write on a disposition entry (readonly arms)", () => {
    // Companion to the four shape pins: EVENT_DISPOSITION_BY_KIND hands out
    // module-level shared SINGLETONS, and ReadonlyMap blocks `.set()` but
    // not property writes on an entry it returned — so a mutable `category`
    // would let one consumer corrupt disposition truth process-wide.
    const singleton: EventKindDisposition = {
      disposition: "adopt",
      category: "run_lifecycle",
      eventType: "run.completed",
    };
    // @ts-expect-error every arm's properties are `readonly` — a returned entry is a shared singleton, never a per-caller copy
    singleton.category = "tool_activity";
    expect(singleton.disposition).toBe("adopt");
  });
});

// --------------------------------------------------------------------------
// Content census — Plan-006 §Event-Kind Disposition Table pins.
// --------------------------------------------------------------------------
//
// The registry transcribed row-for-row from the plan table (the same
// expected-value duplication idiom as session-event.test.ts's
// CENSUS_BASELINE): registered rows pin the eventType the table names;
// B18-pending rows pin the pre-flip `typePending` state T1.10 flips.
// `toStrictEqual` per row also pins the ABSENCE of stray members — a
// `reason` on an adopt row, a leaked `eventType` on a pending row.

const EXPECTED_TAXONOMY_TARGETS: ReadonlyArray<
  readonly [NormalizedEventKind, EventKindDisposition]
> = [
  // Inline timeline (rows 1–14).
  ["init", { disposition: "adopt", category: "run_lifecycle", typePending: "B18" }],
  [
    "text_delta",
    { disposition: "adopt", category: "assistant_output", eventType: "assistant.message" },
  ],
  ["tool_start", { disposition: "adopt", category: "tool_activity", eventType: "tool.invoked" }],
  ["tool_complete", { disposition: "adopt", category: "tool_activity", eventType: "tool.result" }],
  ["turn_start", { disposition: "adopt", category: "run_lifecycle", typePending: "B18" }],
  [
    "turn_complete",
    { disposition: "adopt", category: "run_lifecycle", eventType: "run.completed" },
  ],
  [
    "approval_request",
    { disposition: "adopt", category: "interactive_request", eventType: "driver_ask.requested" },
  ],
  [
    "approval_resolved",
    { disposition: "adopt", category: "approval_flow", eventType: "approval.approved" },
  ],
  [
    "user_input_request",
    { disposition: "adopt", category: "interactive_request", eventType: "driver_ask.requested" },
  ],
  [
    "user_input_resolved",
    { disposition: "adopt", category: "interactive_request", eventType: "driver_ask.responded" },
  ],
  ["session_status", { disposition: "adopt", category: "session_lifecycle", typePending: "B18" }],
  [
    "token_usage",
    { disposition: "adopt", category: "usage_telemetry", eventType: "usage.token_count" },
  ],
  ["error", { disposition: "adopt", category: "run_lifecycle", eventType: "run.failed" }],
  ["todo_update", { disposition: "adopt", category: "tool_activity", eventType: "tool.result" }],
  // Task mirror (rows 15–17).
  ["task_create", { disposition: "adopt", category: "tool_activity", eventType: "tool.result" }],
  ["task_update", { disposition: "adopt", category: "tool_activity", eventType: "tool.result" }],
  ["notification", { disposition: "adopt", category: "session_lifecycle", typePending: "B18" }],
  // Transient retry (row 18).
  ["api_retry", { disposition: "adopt", category: "usage_telemetry", typePending: "B18" }],
  // System, no timeline row (rows 19–22; 23–24 are the discard pair
  // pinned in EXPECTED_FOLDED_ROWS below).
  ["compact_boundary", { disposition: "adopt", category: "usage_telemetry", typePending: "B18" }],
  [
    "rate_limits",
    { disposition: "rename", category: "usage_telemetry", eventType: "usage.rate_limit_update" },
  ],
  ["model_rerouted", { disposition: "adopt", category: "usage_telemetry", typePending: "B18" }],
  ["thread_renamed", { disposition: "adopt", category: "session_lifecycle", typePending: "B18" }],
  // Background/subagent (rows 25–28).
  [
    "background_task_terminal",
    { disposition: "adopt", category: "tool_activity", eventType: "subagent.completed" },
  ],
  [
    "background_task_notification",
    { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  ],
  [
    "subagent_notification",
    { disposition: "adopt", category: "tool_activity", eventType: "subagent.completed" },
  ],
  [
    "subagent_status",
    { disposition: "adopt", category: "tool_activity", eventType: "subagent.started" },
  ],
  // Codex process/terminal (rows 29–30).
  [
    "codex_exec_result",
    { disposition: "adopt", category: "tool_activity", eventType: "tool.result" },
  ],
  [
    "terminal_interaction",
    { disposition: "adopt", category: "tool_activity", eventType: "tool.invoked" },
  ],
  // Heavy, persisted (rows 32–35; row 31 is the user_text correlate
  // pinned in EXPECTED_FOLDED_ROWS below).
  ["diff", { disposition: "adopt", category: "tool_activity", eventType: "tool.result" }],
  ["command_output", { disposition: "adopt", category: "tool_activity", eventType: "tool.result" }],
  [
    "thinking",
    { disposition: "adopt", category: "assistant_output", eventType: "assistant.thinking_update" },
  ],
  [
    "proposed_plan",
    { disposition: "adopt", category: "assistant_output", eventType: "assistant.message" },
  ],
];

// Reason-content pins for the three lossy rows. The full prose lives in
// event.ts; each row here asserts the LOAD-BEARING substance of its table
// reason via substring — foremost user_text's correlate target naming
// `user.message` (B18-minted; contracts registration rides T1.10, which
// updates the reason wording) and its correlation_id fold. Structural
// discipline (non-empty reason, no taxonomy target) is asserted over the
// live registry above.
const EXPECTED_FOLDED_ROWS: ReadonlyArray<
  readonly [NormalizedEventKind, "correlate" | "discard", readonly string[]]
> = [
  ["content_block_start", "discard", ["streaming", "text_delta"]],
  ["content_block_stop", "discard", ["content_block_start"]],
  ["user_text", "correlate", ["correlation_id", "user.message", "T1.10"]],
];

describe("Disposition content census — plan-table pins (T1.8)", () => {
  it("the pinned tables cover the census exactly (32 taxonomy rows + 3 lossy rows)", () => {
    // Completeness self-check for the expected tables (the CENSUS_BASELINE
    // row-sum idiom): a row silently dropped from either pin table fails
    // here instead of leaving the remaining per-row pins green.
    const pinnedKinds = [
      ...EXPECTED_TAXONOMY_TARGETS.map(([kind]) => kind),
      ...EXPECTED_FOLDED_ROWS.map(([kind]) => kind),
    ];
    expect(new Set(pinnedKinds).size).toBe(pinnedKinds.length);
    expect([...pinnedKinds].sort()).toEqual([...NORMALIZED_EVENT_KINDS].sort());
  });

  it.each(EXPECTED_TAXONOMY_TARGETS)("disposition table row: %s", (kind, expected) => {
    expect(EVENT_DISPOSITION_BY_KIND.get(kind)).toStrictEqual(expected);
  });

  it.each(EXPECTED_FOLDED_ROWS)(
    "lossy-row reason content: %s (%s)",
    (kind, expectedDisposition, requiredSubstrings) => {
      const entry = EVENT_DISPOSITION_BY_KIND.get(kind);
      expect(entry).toBeDefined();
      if (entry === undefined) {
        throw new Error(`expected a registry entry for ${kind}`);
      }
      expect(entry.disposition).toBe(expectedDisposition);
      for (const substring of requiredSubstrings) {
        // `reason` is `string | undefined` on the full union; `?? ""`
        // keeps a missing reason failing the containment loudly rather
        // than throwing a TypeError.
        expect(entry.reason ?? "").toContain(substring);
      }
    },
  );
});

describe("EVENT_DISPOSITION_BY_KIND `.get()` safety (T1.8)", () => {
  it("is a ReadonlyMap, not a plain object (the SESSION_EVENT_CATEGORY_BY_TYPE idiom)", () => {
    expect(EVENT_DISPOSITION_BY_KIND).toBeInstanceOf(Map);
  });

  it.each([["__proto__"], ["constructor"], ["toString"], ["hasOwnProperty"]])(
    "rejects prototype-chain walks: %s",
    (untrusted) => {
      // Map (NOT object-literal) lookup is load-bearing: a Plan-005
      // normalizer that calls `.get(kind)` on an unvalidated wire string
      // MUST resolve to `undefined` for every key outside the explicit
      // table, including built-in object prototype keys (same `as never`
      // idiom as the SESSION_EVENT_CATEGORY_BY_TYPE suite — the literal is
      // deliberately outside the NormalizedEventKind union).
      expect(EVENT_DISPOSITION_BY_KIND.get(untrusted as never)).toBeUndefined();
    },
  );

  it.each([["worker_shutting_down"], ["hook_started"], ["rate_limit_event"]])(
    "wire-layer strings are not registry keys: %s",
    (wireLayerString) => {
      // Negative controls for the registry's scope boundary: the
      // `worker_shutting_down` delta orphan (the ninth B18 target — its
      // `run.worker_shutdown` closure is T1.10's union widening alone,
      // never a registry row), the `hook_started` wire-level discard, and
      // the raw Claude wire string `rate_limit_event` (the registry keys
      // the NORMALIZED `rate_limits` kind it renames onto). All are
      // Plan-005 normalizer wire-layer concerns; a future edit promoting
      // them into the census registry must fail here first.
      expect(EVENT_DISPOSITION_BY_KIND.get(wireLayerString as never)).toBeUndefined();
    },
  );
});
