// Driver-boundary provider-bound text neutralization and the runtime tripwire
// (Plan-005 Phase 3, T3.18 / I-005-7).
//
// The hazard under test, stated once: a provider CLI whose programmatic input
// surface also parses client-side commands consumes a message whose first word
// is command-shaped and answers with a ZERO-TURN SUCCESS — a well-formed
// terminal frame with no error, no model attribution, and no token accounting.
// The participant's words never reach the model while every layer above reads a
// completed turn.
//
// Two properties therefore have to hold together, and each is worthless alone:
// the bytes on the wire are neutralized, AND a turn that settles with no
// evidence of a model having run fails loudly instead of succeeding quietly.
//
// The conformance vectors here are RECORDED, not invented. The zero-turn
// `result` body is the reading taken first-party against the pinned Claude
// build; its ordinary-turn twin was captured in the same pass with the same
// model and session shape. Both are pinned in
// `docs/reference/provider-wire/claude.md`. The Codex bodies are shaped after
// the app-server frames recorded in that family's sibling reference.

import { describe, expect, it, vi } from "vitest";

import type { DriverCapabilities, RunId, SessionId } from "@ai-sidekicks/contracts";
import { DriverInterventionResultSchema } from "@ai-sidekicks/contracts";

import { classifyClaudeTurnEvidence } from "../claude/event-normalizer.js";
import {
  CLAUDE_API_ERRORED_TURN_RESULT_FRAME,
  CLAUDE_ORDINARY_TURN_RESULT_FRAME,
  CLAUDE_ZERO_TURN_RESULT_FRAME,
} from "../claude/__fixtures__/turn-evidence-transcripts.js";
import {
  ClaudeSessionLifecycle,
  ClaudeSessionUnavailableError,
  type ClaudeRunDispatch,
  type ClaudeSessionLifecycleDependencies,
} from "../claude/lifecycle.js";
import {
  buildCreateSessionParams,
  buildStartRunParams,
  FakeClaudeRunDispatchResolver,
  FakeClaudeSessionTransport,
  makeSilentDriverDiagnostics,
  TEST_BINDING_ID,
  TEST_PINNED_PROVIDER_SESSION_ID,
  TEST_RUN_ID,
  TEST_SECOND_RUN_ID,
  TEST_SESSION_ID,
} from "../claude/__tests__/claude-test-doubles.js";
import {
  codexCommandDispatchResponse,
  codexQuotaExhaustedTurn,
  codexTurnWithModelOutput,
} from "../codex/__fixtures__/turn-evidence-transcripts.js";
import {
  classifyCodexTurnEvidence,
  classifyCodexTurnEvidenceObservation,
} from "../codex/event-normalizer.js";
import {
  CodexInterventionDispatcher,
  type CodexInterventionRuntime,
} from "../codex/intervention.js";
import {
  composeTextNeutralizationFailureDetail,
  composeTextNeutralizationRunFailure,
  isCommandShapedText,
  observedTurnEvidence,
  OutboundFrameCapacityRefusedError,
  OutboundFrameTripwire,
  OutboundTextFrameWriter,
  OUTBOUND_FRAME_ORIGINS,
  OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY,
  OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY,
  OUTBOUND_TEXT_NEUTRALIZATION_SENTINEL,
  ProviderBindingQuarantine,
  TextNeutralizationRefusedError,
  TEXT_NEUTRALIZATION_REFUSAL_CODE,
  UNRECOGNIZED_TURN_EVIDENCE,
  type OutboundTextFrame,
} from "../outbound-frame.js";

// --------------------------------------------------------------------------
// Byte vocabulary, named by code point
// --------------------------------------------------------------------------
//
// Written as code points rather than as literal characters on purpose. Half of
// these are invisible in an editor, and a test whose meaning depends on which
// invisible byte a file happens to contain is a test nobody can review.

/** The six ASCII whitespace bytes the predicate skips, and nothing else. */
const ASCII_WHITESPACE_LEADS: readonly string[] = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].map(
  (codePoint) => String.fromCodePoint(codePoint),
);

/** Two Unicode spaces that are NOT in that set. */
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

/**
 * Sentinels the escalation ladder forbids at every rung: zero-width space,
 * word joiner, byte-order mark, zero-width joiner, variation selector 16, and a
 * Unicode tag character.
 */
const FORBIDDEN_INVISIBLE_SENTINELS: readonly string[] = [
  0x200b, 0x2060, 0xfeff, 0x200d, 0xfe0f, 0xe0001,
].map((codePoint) => String.fromCodePoint(codePoint));

// --------------------------------------------------------------------------
// The command-shaped predicate
// --------------------------------------------------------------------------

describe("command-shaped text predicate", () => {
  it("treats a leading slash as command-shaped regardless of what follows it", () => {
    // No command-name list is consulted, which is what makes these one case: the
    // measured interception happens on the leading byte, upstream of any name
    // lookup, so a consumer cannot dodge it by avoiding real command names.
    expect(isCommandShapedText("/status")).toBe(true);
    expect(isCommandShapedText("/zzqnotarealcommand and some prose")).toBe(true);
    expect(isCommandShapedText("/foo:bar")).toBe(true);
    expect(isCommandShapedText("/etc/hosts is the file I mean")).toBe(true);
  });

  it("skips exactly the six ASCII whitespace bytes before deciding", () => {
    for (const lead of ASCII_WHITESPACE_LEADS) {
      expect(isCommandShapedText(lead + "/status")).toBe(true);
    }
    expect(isCommandShapedText("  \t\r\n/status")).toBe(true);
  });

  it("does not treat a mid-text slash as command-shaped", () => {
    // The discriminating control. A predicate that matched anywhere would
    // neutralize ordinary prose — a silent corruption of every message that
    // happens to mention a path.
    expect(isCommandShapedText("please read /etc/hosts")).toBe(false);
    expect(isCommandShapedText("use the a/b test")).toBe(false);
    expect(isCommandShapedText("")).toBe(false);
    expect(isCommandShapedText("   ")).toBe(false);
  });

  it("does not treat a non-ASCII whitespace lead as command-shaped", () => {
    // A considered narrowing rather than an oversight: the predicate mirrors
    // what a provider's own ASCII parser does, and over-matching would
    // neutralize text no provider would have intercepted. The residual — a
    // parser that DOES skip exotic whitespace — belongs to the tripwire, which
    // is the fail-closed backstop for exactly that class.
    expect(isCommandShapedText(NO_BREAK_SPACE + "/status")).toBe(false);
    expect(isCommandShapedText(IDEOGRAPHIC_SPACE + "/status")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// The writer — byte-level, with the grade as an input
// --------------------------------------------------------------------------

describe("outbound text frame writer", () => {
  function writer(mechanismGrade: "native" | "emulated"): OutboundTextFrameWriter {
    return new OutboundTextFrameWriter({
      mechanismGrade,
      mintCorrelationId: () => "correlation-1",
    });
  }

  it("prepends exactly one newline on an emulated leg, and nothing else", () => {
    const frame = writer("emulated").compose({
      text: "/status please",
      origin: "participant_text",
    });

    // Asserted as BYTES, not as "it was neutralized". The transform's whole
    // claim is that it is the least visible one that works, and a boolean
    // assertion would not notice a second newline, an added space, a zero-width
    // character, or a reordering.
    expect([...frame.wireText]).toStrictEqual(["\n", ...[..."/status please"]]);
    expect(frame.wireText).toBe(OUTBOUND_TEXT_NEUTRALIZATION_SENTINEL + "/status please");
    expect(frame.wireText.length).toBe("/status please".length + 1);
    expect(frame.neutralized).toBe(true);
  });

  it("emits the author's bytes unchanged on a leg declared native", () => {
    // The grade is a behavioral INPUT. Both legs are `emulated` today; this arm
    // is driven from the test's own declaration, so a re-grade by amendment is a
    // one-value change with no code path behind it.
    const frame = writer("native").compose({ text: "/status please", origin: "participant_text" });

    expect(frame.wireText).toBe("/status please");
    expect(frame.neutralized).toBe(false);
    expect([...frame.wireText][0]).toBe("/");
  });

  it("leaves non-command-shaped text byte-identical on both grades", () => {
    for (const grade of ["emulated", "native"] as const) {
      const frame = writer(grade).compose({
        text: "please read /etc/hosts",
        origin: "participant_text",
      });
      expect(frame.wireText).toBe("please read /etc/hosts");
      expect(frame.neutralized).toBe(false);
    }
  });

  it("delivers a driver_command frame verbatim and exempts it from the tripwire", () => {
    // The one origin whose leading slash IS the payload. Neutralizing it would
    // break the very dispatch it is asking for.
    const frame = writer("emulated").compose({ text: "/compact", origin: "driver_command" });

    expect(frame.wireText).toBe("/compact");
    expect(frame.neutralized).toBe(false);
    expect(frame.tripwireExempt).toBe(true);
  });

  it("neutralizes system_narration, which is not exempt", () => {
    const frame = writer("emulated").compose({
      text: "/system notice",
      origin: "system_narration",
    });

    expect(frame.wireText).toBe("\n/system notice");
    expect(frame.tripwireExempt).toBe(false);
    expect(frame.detailOrigin).toBe("system_narration");
  });

  it("neutralizes an absent origin and an off-union origin alike, echoing neither", () => {
    // Fail-closed, and the reason this is a frame-origin discriminator rather
    // than a capability flag: an undeclared capability resolves fail-OPEN under
    // I-005-2, which is exactly backwards for this hazard.
    for (const origin of [undefined, "participant-text", "PARTICIPANT_TEXT", "arbitrary"]) {
      const frame = writer("emulated").compose({ text: "/status", origin });
      expect(frame.wireText).toBe("\n/status");
      expect(frame.tripwireExempt).toBe(false);
      expect(frame.origin).toBeNull();
      // The writer never echoes a rejected value into a persisted,
      // operator-visible string.
      expect(frame.detailOrigin).toBe("unknown");
    }
  });

  it("never mutates the author's bytes, whatever it puts on the wire", () => {
    const authored = "/status please";
    const frame = writer("emulated").compose({ text: authored, origin: "participant_text" });

    // TRANSPORT-ONLY. `authoredText` is what the daemon persists, events,
    // replays, and rewinds to, and it must carry no sentinel.
    expect(frame.authoredText).toBe(authored);
    expect(frame.authoredText.startsWith("\n")).toBe(false);
    expect(frame.authoredText).not.toBe(frame.wireText);
  });

  it("mints a correlation value per frame", () => {
    let counter = 0;
    const perFrameWriter = new OutboundTextFrameWriter({
      mechanismGrade: "emulated",
      mintCorrelationId: () => "correlation-" + (counter += 1),
    });

    expect(perFrameWriter.compose({ text: "one", origin: "participant_text" }).correlationId).toBe(
      "correlation-1",
    );
    expect(perFrameWriter.compose({ text: "two", origin: "participant_text" }).correlationId).toBe(
      "correlation-2",
    );
  });

  it("uses no invisible or zero-width character as its sentinel", () => {
    // Prohibited at every rung of the escalation ladder: an invisible sentinel
    // is indistinguishable from an attack to a reader diffing the bytes, and it
    // survives copy-paste into places nobody can see it.
    const frame = writer("emulated").compose({ text: "/status", origin: "participant_text" });
    for (const forbidden of FORBIDDEN_INVISIBLE_SENTINELS) {
      expect(frame.wireText).not.toContain(forbidden);
    }
  });

  it("freezes the frame it mints", () => {
    expect(
      Object.isFrozen(writer("emulated").compose({ text: "/status", origin: "participant_text" })),
    ).toBe(true);
  });

  it("keeps the origin union closed at three members", () => {
    // A set-membership assertion rather than a spelling one: the union is
    // daemon-local, never crosses the wire, and a fourth arm would need its own
    // neutralization and exemption decisions.
    expect([...OUTBOUND_FRAME_ORIGINS]).toStrictEqual([
      "participant_text",
      "driver_command",
      "system_narration",
    ]);
  });
});

// --------------------------------------------------------------------------
// The Claude classifier
// --------------------------------------------------------------------------

describe("Claude turn-evidence classifier", () => {
  it("finds no evidence in the recorded zero-turn synthetic reply", () => {
    const classification = classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME);

    expect(classification.recognized).toBe(true);
    expect(classification.observations).toStrictEqual([]);
  });

  it("finds evidence in the recorded ordinary turn", () => {
    const classification = classifyClaudeTurnEvidence(CLAUDE_ORDINARY_TURN_RESULT_FRAME);

    expect(classification.recognized).toBe(true);
    expect(classification.observations).toContain("turn_accounting");
    expect(classification.observations).toContain("model_output");
  });

  it("finds evidence in a genuine turn that ended in a provider-side refusal", () => {
    // The negative control that matters most. This frame renders synthetic and
    // reports `is_error: true`, and it is still a real, billed turn — so a
    // classifier keyed on either field would fail it.
    expect(classifyClaudeTurnEvidence(CLAUDE_API_ERRORED_TURN_RESULT_FRAME).observations).toContain(
      "turn_accounting",
    );
  });

  it("reads a declared failure subtype as a loud, non-silent outcome", () => {
    const classification = classifyClaudeTurnEvidence({
      type: "result",
      subtype: "error_during_execution",
      num_turns: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      modelUsage: {},
    });

    expect(classification.observations).toStrictEqual(["declared_turn_failure"]);
  });

  it("refuses to recognize a shape it was not given", () => {
    for (const envelope of [
      undefined,
      null,
      "result",
      42,
      [],
      {},
      { type: "assistant" },
      { type: "result" },
      { type: "result", subtype: "not_a_censused_subtype" },
    ]) {
      expect(classifyClaudeTurnEvidence(envelope)).toStrictEqual(UNRECOGNIZED_TURN_EVIDENCE);
    }
  });
});

// --------------------------------------------------------------------------
// The Codex classifier
// --------------------------------------------------------------------------

describe("Codex turn-evidence classifier", () => {
  it("finds model output in a turn that produced an agent message", () => {
    const classification = classifyCodexTurnEvidence(codexTurnWithModelOutput("turn-1"));

    expect(classification.recognized).toBe(true);
    expect(classification.observations).toStrictEqual(["model_output"]);
  });

  it("finds no evidence in a synthesized command-dispatch response", () => {
    const classification = classifyCodexTurnEvidence(codexCommandDispatchResponse("turn-1"));

    expect(classification.recognized).toBe(true);
    expect(classification.observations).toStrictEqual([]);
  });

  it("does not read a participant echo as evidence that a model saw it", () => {
    // The echo is what the provider sends BACK, verbatim. Reading it as evidence
    // would make the tripwire assert the very thing in doubt.
    const dispatch = codexCommandDispatchResponse("turn-1");
    const turn = dispatch["turn"] as Record<string, unknown>;
    expect((turn["items"] as unknown[]).length).toBe(1);
    expect(classifyCodexTurnEvidence(dispatch).observations).not.toContain("model_output");
  });

  it("passes a typed declared failure so an unrelated outage is not misreported", () => {
    // The measured quota-exhausted turn: no model output at all, and still not a
    // neutralization failure. Reporting it as one would poison a shared
    // operator-visible field for a completely different cause.
    expect(classifyCodexTurnEvidence(codexQuotaExhaustedTurn("turn-1")).observations).toStrictEqual(
      ["declared_turn_failure"],
    );
  });

  it("reads an interrupted turn as a declared non-completion", () => {
    expect(
      classifyCodexTurnEvidence({
        turn: { id: "turn-1", items: [], itemsView: "loaded", status: "interrupted", error: null },
      }).observations,
    ).toStrictEqual(["declared_turn_failure"]);
  });

  it("refuses to recognize a shape it was not given", () => {
    for (const envelope of [
      undefined,
      null,
      [],
      {},
      { turn: null },
      { turn: {} },
      { turn: { status: "notAStatus" } },
    ]) {
      expect(classifyCodexTurnEvidence(envelope)).toStrictEqual(UNRECOGNIZED_TURN_EVIDENCE);
    }
  });

  it("accrues in-flight model output from item notifications", () => {
    // Necessary because `turn/completed` can carry `itemsView: "notLoaded"`
    // beside an EMPTY item list, measured at the pin — an absence of loading,
    // not an absence of output.
    expect(
      classifyCodexTurnEvidenceObservation("item/completed", {
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-2" },
      }),
    ).toStrictEqual({ turnId: "turn-1", observation: "model_output" });
  });

  it("reads no in-flight evidence off a participant echo or an unrelated method", () => {
    expect(
      classifyCodexTurnEvidenceObservation("item/completed", {
        turnId: "turn-1",
        item: { type: "userMessage", id: "item-1" },
      }),
    ).toBeNull();
    expect(classifyCodexTurnEvidenceObservation("turn/started", { turnId: "turn-1" })).toBeNull();
    expect(
      classifyCodexTurnEvidenceObservation("item/completed", { item: { type: "agentMessage" } }),
    ).toBeNull();
  });
});

// --------------------------------------------------------------------------
// The tripwire
// --------------------------------------------------------------------------

describe("outbound frame tripwire", () => {
  // A fresh correlation per frame, because that value is what the store is keyed
  // by: a shared minter would make two frames on one turn indistinguishable and
  // quietly restore the single-frame-per-key behavior these tests exist to rule
  // out.
  let composedFrameCount = 0;
  function frameFor(origin: string | undefined, text = "/status"): OutboundTextFrame {
    return new OutboundTextFrameWriter({
      mechanismGrade: "emulated",
      mintCorrelationId: () => {
        composedFrameCount += 1;
        return `correlation-${String(composedFrameCount)}`;
      },
    }).compose({ text, origin });
  }

  // The scope key is the provider binding the frame is written on. These cases
  // are about correlation rather than about capacity, so they all share one
  // binding and the capacity cases below name their own.
  function registerFrame(
    tripwire: OutboundFrameTripwire,
    joinKey: string,
    frame: OutboundTextFrame,
    scopeKey = "session-1",
  ): void {
    tripwire.register({ scopeKey, joinKey, frame });
  }

  it("trips when a correlated turn settles with no evidence", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("participant_text"));

    const decision = tripwire.settle(
      "join-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    if (!decision.tripped) {
      throw new Error("expected the recorded zero-turn reply to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.refusalCode).toBe(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    expect(decision.failureDetail).toBe(
      "driver.text_neutralization_failed origin=participant_text",
    );
  });

  it("trips on an unrecognized settling envelope", () => {
    // Fail-closed polarity control: an envelope the driver cannot parse is, from
    // here, indistinguishable from a locally-composed reply.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("participant_text"));

    const decision = tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE);

    if (!decision.tripped) {
      throw new Error("expected an unrecognized envelope to trip");
    }
    expect(decision.cause).toBe("unrecognized-settling-envelope");
  });

  it("composes exactly `origin=unknown` for an off-union origin", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("some-other-origin"));

    const decision = tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE);

    if (!decision.tripped) {
      throw new Error("expected a trip");
    }
    // The exact string, not a match: two producers share this one field and a
    // consumer parses it.
    expect(decision.failureDetail).toBe("driver.text_neutralization_failed origin=unknown");
    expect(decision.failureDetail).not.toContain("some-other-origin");
  });

  it("composes exactly `origin=system_narration` for a narration frame", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("system_narration"));

    const decision = tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE);

    if (!decision.tripped) {
      throw new Error("expected a trip");
    }
    expect(decision.failureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
  });

  it("never trips on a driver_command frame, whatever the turn does", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("driver_command", "/compact"));

    expect(tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "frame-exempt",
    });
  });

  it("passes when evidence accrued in flight even if the terminal carries none", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("participant_text"));
    tripwire.observe("join-1", "model_output");

    expect(tripwire.settle("join-1", observedTurnEvidence())).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("passes a turn no frame was correlated with", () => {
    expect(
      new OutboundFrameTripwire().settle("join-unknown", UNRECOGNIZED_TURN_EVIDENCE),
    ).toStrictEqual({ tripped: false, reason: "no-correlated-frame" });
  });

  it("consumes the registration so one frame cannot trip twice", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("participant_text"));

    expect(tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
    expect(tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("re-keys a registration onto the turn id the provider names", () => {
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("participant_text");
    registerFrame(tripwire, "run-1", openingFrame);
    tripwire.recorrelateFrame(openingFrame, "turn-1");

    expect(tripwire.settle("run-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(false);
    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
  });

  it("carries the observations a frame accrued under its old key across the move", () => {
    // The evidence a frame collected is the reason its turn passes, and the
    // re-key happens AFTER a fast turn may already have produced output — so a
    // move that reset the accrual would report a turn that visibly answered as
    // one that swallowed its input.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("participant_text");
    registerFrame(tripwire, "run-1", openingFrame);
    tripwire.observe("run-1", "model_output");
    tripwire.recorrelateFrame(openingFrame, "turn-1");

    expect(tripwire.settle("turn-1", observedTurnEvidence())).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("leaves a frame that is no longer pending un-registered", () => {
    // A frame already settled, forgotten, or reclaimed is owed no further
    // correlation; re-admitting it would resurrect a registration the store has
    // already answered for and let one frame be ruled twice.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("participant_text");
    registerFrame(tripwire, "run-1", openingFrame);
    tripwire.forgetFrame(openingFrame);

    tripwire.recorrelateFrame(openingFrame, "turn-1");

    expect(tripwire.hasPendingFrame("turn-1")).toBe(false);
    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("still answers pending for a join key a forgotten frame shares with a sibling", () => {
    // The unsent arm of the drivers' failed-opening-frame ruling withdraws only
    // the refused frame and keeps the run's route for as long as this predicate
    // answers true. The Claude startRun path that once drove that arm is now
    // refused pre-write by the duplicate-dispatch guard, so the predicate is
    // pinned here, at the store that owns it: forgetting one of two frames on a
    // key must not answer for the sibling still owed a ruling.
    const tripwire = new OutboundFrameTripwire();
    const acceptedFrame = frameFor("participant_text");
    const refusedFrame = frameFor("participant_text", "/clear");
    registerFrame(tripwire, "run-1", acceptedFrame);
    registerFrame(tripwire, "run-1", refusedFrame);

    tripwire.forgetFrame(refusedFrame);
    expect(tripwire.hasPendingFrame("run-1")).toBe(true);

    tripwire.forgetFrame(acceptedFrame);
    expect(tripwire.hasPendingFrame("run-1")).toBe(false);
  });

  it("leaves the destination turn's retained decision standing", () => {
    // A move is not a fresh attempt: `register` clears the key it writes to
    // because a new write is starting there, while a settled turn's ruling is a
    // property of the turn. Clearing it here would erase exactly the trip the
    // intervention path reads back when an acknowledged steer names a turn whose
    // terminal has already gone by.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);
    const laterFrame = frameFor("participant_text", "/clear");
    registerFrame(tripwire, "run-1", laterFrame);

    tripwire.recorrelateFrame(laterFrame, "turn-1");

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
  });

  it("drops a registration no turn will ever settle", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "run-1", frameFor("participant_text"));
    tripwire.forget("run-1");

    expect(tripwire.settle("run-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(false);
  });

  it("retains a settled decision so a caller can ask after the fact", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
    expect(tripwire.decisionFor("turn-unasked")).toBeUndefined();
  });

  it("composes the run terminal a trip lands on", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"));
    const decision = tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);
    if (!decision.tripped) {
      throw new Error("expected a trip");
    }

    expect(composeTextNeutralizationRunFailure(decision)).toStrictEqual({
      eventType: "run.failed",
      failureCategory: "provider failure",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: "driver.text_neutralization_failed origin=participant_text",
    });
  });

  it("composes the detail in the fixed three-value form", () => {
    expect(composeTextNeutralizationFailureDetail("participant_text")).toBe(
      "driver.text_neutralization_failed origin=participant_text",
    );
    expect(composeTextNeutralizationFailureDetail("system_narration")).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
    expect(composeTextNeutralizationFailureDetail("unknown")).toBe(
      "driver.text_neutralization_failed origin=unknown",
    );
  });
  it("does not let evidence produced BEFORE a steer vouch for the steer", () => {
    // The false-pass half of the multi-frame defect. The settling envelope's
    // item list is the whole turn's, so every item in it precedes a steer
    // written later — attributing that list to the steer lets a swallowed
    // directive pass on words it never produced. The two frames carry different
    // origins so the composed detail names WHICH frame the turn failed to
    // account for.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"));
    tripwire.observe("turn-1", "model_output");
    registerFrame(tripwire, "turn-1", frameFor("system_narration", "/clear"));

    const decision = tripwire.settle("turn-1", observedTurnEvidence("model_output"));

    if (!decision.tripped) {
      throw new Error("expected the steer no evidence is attributable to to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.failureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
  });

  it("keeps each frame's own in-flight evidence when a later frame joins the turn", () => {
    // The false-trip half: an opening frame that was answered stays answered
    // when a steer joins its turn, and a terminal with an UNLOADED item list
    // must not then fail it. Each item lands on the oldest frame still holding
    // none, so the first vouches the opening frame and the second the steer.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"));
    tripwire.observe("turn-1", "model_output");
    registerFrame(tripwire, "turn-1", frameFor("participant_text", "also check the tests"));
    tripwire.observe("turn-1", "model_output");

    expect(tripwire.settle("turn-1", observedTurnEvidence())).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("does not let one directive's delayed output vouch a directive registered beside it", () => {
    // The false-pass twin of the two tests above. Two directives are pending
    // when a single item arrives — output the FIRST caused, delayed past the
    // second's registration. Crediting every pending frame would let that item
    // vouch the second directive too, and a steer the provider swallowed would
    // pass on words another directive produced. The item lands on the oldest
    // frame still holding no evidence, so the second is owed its own item.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"));
    registerFrame(tripwire, "turn-1", frameFor("system_narration", "/clear"));
    tripwire.observe("turn-1", "model_output");

    const decision = tripwire.settle("turn-1", observedTurnEvidence());

    if (!decision.tripped) {
      throw new Error("expected the directive no item is attributable to to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.failureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
  });

  it("consumes every frame on a turn, so a second terminal rules on none", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"));
    registerFrame(tripwire, "turn-1", frameFor("participant_text", "/clear"));

    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
    expect(tripwire.hasPendingFrame("turn-1")).toBe(false);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output"))).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("leaves a retained decision alone when a turn it holds no frame for settles", () => {
    // The `no-correlated-frame` arm stores nothing, and that is load-bearing: on
    // the same-read-chunk interleave the terminal settles before any frame is
    // correlated, and a stored pass there would overwrite the trip the re-keyed
    // frame produces a microtask later.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);

    tripwire.settle("turn-1", observedTurnEvidence("model_output"));

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
  });

  it("re-keys ONLY the named frame, leaving a concurrent attempt's on the run", () => {
    // The run id is the key EVERY attempt on that run registers under, and
    // nothing serializes two starts. A key-wide move would carry the second
    // attempt's still-unnamed frame onto the first attempt's turn, and the
    // second attempt would then find nothing left to move — leaving its own
    // turn to settle against no correlated frame, which PASSES.
    const tripwire = new OutboundFrameTripwire();
    const firstAttemptFrame = frameFor("participant_text");
    const secondAttemptFrame = frameFor("participant_text", "/clear");
    registerFrame(tripwire, "run-1", firstAttemptFrame);
    registerFrame(tripwire, "run-1", secondAttemptFrame);

    tripwire.recorrelateFrame(firstAttemptFrame, "turn-1");

    expect(tripwire.hasPendingFrame("run-1")).toBe(true);
    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
    expect(tripwire.hasPendingFrame("turn-1")).toBe(false);

    // The second attempt is still there to be named, and its own turn rules it.
    tripwire.recorrelateFrame(secondAttemptFrame, "turn-2");
    expect(tripwire.hasPendingFrame("run-1")).toBe(false);
    expect(tripwire.settle("turn-2", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
  });

  it("drops one frame without disturbing the others on its turn", () => {
    // The counterpart of `register` for a send that PROVABLY never reached the
    // wire, so leaving it registered would trip the turn its text never entered
    // — while dropping the whole key would silence the frame that opened the
    // turn and is still owed a ruling. Reserved for that class: a send whose
    // delivery is merely unknown is ruled by `settleFrame` instead.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("participant_text");
    const unsentSteerFrame = frameFor("participant_text", "/clear");
    registerFrame(tripwire, "turn-1", openingFrame);
    registerFrame(tripwire, "turn-1", unsentSteerFrame);

    tripwire.forgetFrame(unsentSteerFrame);

    expect(tripwire.hasPendingFrame("turn-1")).toBe(true);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output"))).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("rules ONE frame of an open turn without ruling the frames beside it", () => {
    // For the frame whose delivery became unknowable while its turn stayed open.
    // Settling the whole key cannot serve: an unrecognized classification trips
    // every correlated frame, so the opening frame — answered, and observed
    // producing output — would be reported swallowed too, and the operator-facing
    // detail would name a frame there is positive evidence FOR.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("participant_text");
    const uncertainSteerFrame = frameFor("system_narration", "/clear");
    registerFrame(tripwire, "turn-1", openingFrame);
    tripwire.observe("turn-1", "model_output");
    registerFrame(tripwire, "turn-1", uncertainSteerFrame);

    const decision = tripwire.settleFrame(uncertainSteerFrame, UNRECOGNIZED_TURN_EVIDENCE);

    expect(decision).toStrictEqual({
      tripped: true,
      cause: "unrecognized-settling-envelope",
      correlationId: uncertainSteerFrame.correlationId,
      detailOrigin: "system_narration",
      failureDetail: "driver.text_neutralization_failed origin=system_narration",
      refusalCode: "driver.text_neutralization_failed",
    });
    // Only that frame was consumed; the opening frame is still owed its ruling.
    expect(tripwire.hasPendingFrame("turn-1")).toBe(true);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output"))).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("does not record a turn decision when only one of its frames is ruled", () => {
    // The turn has NOT settled, so a stored trip would make the retained
    // decision answer "swallowed" for a turn whose other frames are still live
    // and may yet pass — and that decision is what the intervention path reads
    // back after the binding is gone.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("participant_text");
    const uncertainSteerFrame = frameFor("participant_text", "/clear");
    registerFrame(tripwire, "turn-1", openingFrame);
    registerFrame(tripwire, "turn-1", uncertainSteerFrame);

    expect(tripwire.settleFrame(uncertainSteerFrame, UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(
      true,
    );

    expect(tripwire.decisionFor("turn-1")).toBeUndefined();
  });

  it("rules a frame already withdrawn from its turn as uncorrelated", () => {
    // Idempotent against a double ruling: a frame consumed by its turn's own
    // terminal has been ruled once already, and ruling it a second time would
    // report one swallow twice.
    const tripwire = new OutboundFrameTripwire();
    const frame = frameFor("participant_text");
    registerFrame(tripwire, "turn-1", frame);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output")).tripped).toBe(false);

    expect(tripwire.settleFrame(frame, UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("releases the scope budget a frame ruled outside its turn was holding", () => {
    // A ruled frame is a settled frame: it must not keep spending the per-binding
    // pending budget, or a session that lost one steer would refuse writes it
    // should still admit.
    const tripwire = new OutboundFrameTripwire();
    const frame = frameFor("participant_text");
    registerFrame(tripwire, "turn-1", frame);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(1);

    tripwire.settleFrame(frame, UNRECOGNIZED_TURN_EVIDENCE);

    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
  });

  it("refuses a registration at capacity rather than discarding an unsettled frame", () => {
    // The alternative — evict the oldest and take the write — is the silent
    // swallow this whole module exists to catch: the evicted turn settles
    // against nothing and PASSES. So the store fills, the next write is refused,
    // and every frame already in it is still ruled correctly afterwards.
    const tripwire = new OutboundFrameTripwire();
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("participant_text"));
    }

    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("participant_text"));
    }).toThrow(OutboundFrameCapacityRefusedError);

    // Nothing was evicted to make room, and the refusal did not register either.
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(
      OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY,
    );
    expect(tripwire.hasPendingFrame("turn-overflow")).toBe(false);
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      expect(tripwire.hasPendingFrame(`turn-${String(index)}`)).toBe(true);
    }

    // And every one of them still settles on its own evidence — a prune that
    // reclaimed too much would show up here as a `no-correlated-frame` pass.
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      expect(
        tripwire.settle(`turn-${String(index)}`, observedTurnEvidence("model_output")),
      ).toStrictEqual({ tripped: false, reason: "turn-evidence-observed" });
    }
    expect(tripwire.pendingFrameCount).toBe(0);
  });

  it("caps each provider binding separately, so one stalled session starves none", () => {
    // The bound is per binding rather than per manager: a manager-wide budget
    // let one session that never settles a turn answer for the frames of every
    // other session on the node.
    const tripwire = new OutboundFrameTripwire();
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `stalled-${String(index)}`, frameFor("participant_text"), "stalled");
    }

    expect(() => {
      registerFrame(tripwire, "stalled-overflow", frameFor("participant_text"), "stalled");
    }).toThrow(OutboundFrameCapacityRefusedError);
    expect(() => {
      registerFrame(tripwire, "healthy-1", frameFor("participant_text"), "healthy");
    }).not.toThrow();
    expect(tripwire.hasPendingFrame("healthy-1")).toBe(true);
  });

  it("reclaims the frames of retired bindings before refusing", () => {
    // A session that died mid-turn can never settle the frames it left behind,
    // so they are owed no ruling and are pure occupancy. That is the ONLY class
    // of registration reclamation touches.
    const retiredScopeKeys = new Set<string>();
    const tripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey) => retiredScopeKeys.has(scopeKey),
    });
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("participant_text"));
    }

    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("participant_text"));
    }).toThrow(OutboundFrameCapacityRefusedError);

    retiredScopeKeys.add("session-1");
    registerFrame(tripwire, "turn-overflow", frameFor("participant_text"));

    expect(tripwire.hasPendingFrame("turn-overflow")).toBe(true);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(1);
  });

  it("keeps a frame whose binding cannot be proven retired", () => {
    // A predicate that throws has not answered the question, and reclaiming on
    // an unanswered question is the eviction the refusal replaces.
    const tripwire = new OutboundFrameTripwire({
      isScopeRetired: () => {
        throw new Error("the driver could not answer");
      },
    });
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("participant_text"));
    }

    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("participant_text"));
    }).toThrow(OutboundFrameCapacityRefusedError);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(
      OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY,
    );
  });

  it("backstops the total across every binding", () => {
    const tripwire = new OutboundFrameTripwire();
    const scopeCount =
      OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY / OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY;
    for (let scopeIndex = 0; scopeIndex < scopeCount; scopeIndex += 1) {
      for (
        let frameIndex = 0;
        frameIndex < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY;
        frameIndex += 1
      ) {
        registerFrame(
          tripwire,
          `turn-${String(scopeIndex)}-${String(frameIndex)}`,
          frameFor("participant_text"),
          `session-${String(scopeIndex)}`,
        );
      }
    }

    expect(tripwire.pendingFrameCount).toBe(OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY);
    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("participant_text"), "session-fresh");
    }).toThrow(OutboundFrameCapacityRefusedError);
  });

  it("releases a binding's frames without touching the decisions read back by turn", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("participant_text"), "session-2");
    const decision = tripwire.settle(
      "turn-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    tripwire.forgetScope("session-1");

    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
    expect(tripwire.hasPendingFrame("turn-2")).toBe(true);
    // The intervention path reads a retained decision by turn id AFTER the
    // binding is gone, which is the one moment it most needs the answer.
    expect(tripwire.decisionFor("turn-1")).toStrictEqual(decision);
  });

  it("abandons a superseded binding's frames as facts, minting no verdict", () => {
    // The third disposal, between the two the tripwire already had. A supersede
    // is neither "no turn could ever settle" (which is `forgetScope`) nor "text
    // was swallowed" (which is `settleScope`, and which mints a trip carrying
    // the registered dotted code). The frames are consumed and REPORTED, and
    // what they carry is what is known — a join key and an origin — with no
    // decision attached, because no evidence was observed either way.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("system_narration"), "session-1");
    registerFrame(tripwire, "turn-3", frameFor("participant_text"), "session-2");

    const abandoned = tripwire.abandonScope("session-1");

    expect(abandoned).toStrictEqual([
      { joinKey: "turn-1", detailOrigin: "participant_text" },
      { joinKey: "turn-2", detailOrigin: "system_narration" },
    ]);
    // Consumed, not merely read: leaving them pending would spend the binding's
    // budget forever on a binding that no longer exists.
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
    // And scoped: the other binding is untouched and still owed its ruling.
    expect(tripwire.hasPendingFrame("turn-3")).toBe(true);
  });

  it("consumes an exempt frame without reporting it", () => {
    // `#rule`'s own first test, applied here: a driver command carries no
    // participant words, so its disappearance costs nobody their turn. Consumed
    // all the same — the budget is about occupancy, not about who was harmed.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("driver_command"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("participant_text"), "session-1");

    const abandoned = tripwire.abandonScope("session-1");

    expect(abandoned.map((frame) => frame.joinKey)).toStrictEqual(["turn-2"]);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
  });

  it("reports an unrecognized origin rather than assuming it was harmless", () => {
    // The fail-closed direction the frame writer already takes: an absent or
    // unrecognized origin becomes `unknown`, and `unknown` is reported. Assuming
    // it was a driver command would silently exempt exactly the frames whose
    // provenance nobody could establish.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor(undefined), "session-1");

    expect(tripwire.abandonScope("session-1")).toStrictEqual([
      { joinKey: "turn-1", detailOrigin: "unknown" },
    ]);
  });

  it("leaves retained decisions alone, as the other two disposals do", () => {
    // The intervention path reads a decision by turn id after the binding is
    // gone. An abandon writes no decision of its own — no turn settled — and
    // must not erase one that was.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("participant_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("participant_text"), "session-1");
    const decision = tripwire.settle(
      "turn-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    const abandoned = tripwire.abandonScope("session-1");

    // The settled frame is already consumed, so only the live one is abandoned.
    expect(abandoned.map((frame) => frame.joinKey)).toStrictEqual(["turn-2"]);
    expect(tripwire.decisionFor("turn-1")).toStrictEqual(decision);
    // And no decision was invented for the abandoned frame: `decisionFor` on it
    // would be a verdict the provider never delivered a terminal for.
    expect(tripwire.decisionFor("turn-2")).toBeUndefined();
  });

  it("still trips a turn that settles long after the store filled behind it", () => {
    // The regression this replaces: the oldest unsettled frame was evicted to
    // admit a newer one, so when its turn finally settled as a zero-turn
    // interception the tripwire found no correlation and passed it.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-oldest", frameFor("participant_text"));
    for (let index = 1; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("participant_text"));
    }
    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("participant_text"));
    }).toThrow(OutboundFrameCapacityRefusedError);

    const decision = tripwire.settle(
      "turn-oldest",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    expect(decision.tripped).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Provider-binding disposal
// --------------------------------------------------------------------------

describe("provider binding quarantine", () => {
  it("refuses an attach to a disposed binding with the code the trip carried", () => {
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");

    expect(quarantine.isRunDisposed("run-1")).toBe(true);
    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(TextNeutralizationRefusedError);
    try {
      quarantine.assertRunAttachable("run-1");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as TextNeutralizationRefusedError).code).toBe(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    }
  });

  it("leaves an unaffected binding attachable", () => {
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");

    expect(() => quarantine.assertRunAttachable("run-2")).not.toThrow();
  });

  it("refuses the session a trip condemned, not only the run that was on it", () => {
    // The axis a run-keyed quarantine cannot reach: a later run resolves a
    // SESSION, so a refusal keyed only by run id would let it dispatch into the
    // process that swallowed the text.
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeSession("session-1");

    expect(quarantine.isSessionDisposed("session-1")).toBe(true);
    expect(() => quarantine.assertSessionAttachable("session-1")).toThrow(
      TextNeutralizationRefusedError,
    );
    expect(() => quarantine.assertRunAttachable("session-1")).not.toThrow();
    expect(() => quarantine.assertSessionAttachable("session-2")).not.toThrow();
  });

  it("releases a session id whose binding a fresh spawn replaced, and its runs with it", () => {
    // The quarantine names a binding, not an identifier: the promised recovery
    // is a fresh process, and refusing the id forever would refuse the recovery.
    // That applies to BOTH axes. A run reopened after the fresh spawn — a rewind
    // reinstating it is the reachable case — would otherwise stay refused for
    // the daemon's lifetime, having lost its interrupt and intervention controls
    // to a quarantine on a process that no longer exists.
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeSession("session-1");
    quarantine.disposeRun("run-1", "session-1");
    quarantine.releaseSession("session-1");

    expect(() => quarantine.assertSessionAttachable("session-1")).not.toThrow();
    expect(quarantine.isRunDisposed("run-1")).toBe(false);
    expect(() => quarantine.assertRunAttachable("run-1")).not.toThrow();
  });

  it("releases only the runs the released binding condemned", () => {
    // The negative control for the sweep: it is keyed by the CONDEMNING binding,
    // not by "release everything". A run quarantined on a different session is
    // still on a process nothing has replaced, and reaching it must still
    // refuse.
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.disposeRun("run-2", "session-2");
    quarantine.releaseSession("session-1");

    expect(() => quarantine.assertRunAttachable("run-1")).not.toThrow();
    expect(() => quarantine.assertRunAttachable("run-2")).toThrow(TextNeutralizationRefusedError);
  });

  it("keeps a run refused when a DIFFERENT session is respawned", () => {
    // The other half of the same control, from the release side: releasing a
    // binding that condemned nothing releases nothing.
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.releaseSession("session-9");

    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(TextNeutralizationRefusedError);
  });

  it("re-quarantines a released run when the fresh binding trips too", () => {
    // Release is not absolution. The run is attachable again after the respawn,
    // and a second trip on the new binding condemns it again — under the new
    // binding, so the next release is the one that clears it.
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.releaseSession("session-1");
    quarantine.disposeRun("run-1", "session-2");

    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(TextNeutralizationRefusedError);
    quarantine.releaseSession("session-1");
    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(TextNeutralizationRefusedError);
    quarantine.releaseSession("session-2");
    expect(() => quarantine.assertRunAttachable("run-1")).not.toThrow();
  });

  it("names its subject in the refusal so one cause reads as one cause", () => {
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.disposeSession("session-1");

    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(/run run-1/);
    expect(() => quarantine.assertSessionAttachable("session-1")).toThrow(/session session-1/);
  });

  it("holds a bounded number of disposals, ageing out the oldest", () => {
    // Neither collection in this module has a completion guarantee, so both are
    // capped rather than grown for the daemon process's lifetime. Ageing out a
    // disposal cannot revive the run it belonged to — that run is already
    // terminal — so what expires is only the fail-fast refusal an immediate
    // re-attach would have hit.
    const quarantine = new ProviderBindingQuarantine();
    const disposedRunCount = 200;
    for (let index = 0; index < disposedRunCount; index += 1) {
      quarantine.disposeRun(`run-${String(index)}`, "session-1");
    }

    expect(quarantine.isRunDisposed("run-0")).toBe(false);
    expect(quarantine.isRunDisposed(`run-${String(disposedRunCount - 1)}`)).toBe(true);
  });

  it("caps the session axis independently of the run axis", () => {
    // Separate collections, so a busy run axis cannot age a session refusal out
    // from under the session it condemned.
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeSession("session-1");
    for (let index = 0; index < 200; index += 1) {
      quarantine.disposeRun(`run-${String(index)}`, "session-2");
    }

    expect(quarantine.isSessionDisposed("session-1")).toBe(true);
  });

  it("keeps a re-disposed binding at the newest position", () => {
    const quarantine = new ProviderBindingQuarantine();
    quarantine.disposeRun("run-old", "session-1");
    for (let index = 0; index < 100; index += 1) {
      quarantine.disposeRun(`run-${String(index)}`, "session-1");
      quarantine.disposeRun("run-old", "session-1");
    }

    expect(quarantine.isRunDisposed("run-old")).toBe(true);
  });
});

// --------------------------------------------------------------------------
// The Claude driver, end to end
// --------------------------------------------------------------------------

/**
 * Drains the microtask queue by yielding to the macrotask queue once.
 *
 * A counted `await Promise.resolve()` would pin these tests to an exact number
 * of microtask hops, so any change to how the driver sequences its detached
 * teardown would silently turn a real assertion into a hang.
 */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("Claude driver provider-bound text path", () => {
  interface Harness {
    readonly lifecycle: ClaudeSessionLifecycle;
    readonly transport: FakeClaudeSessionTransport;
    readonly runDispatchResolver: FakeClaudeRunDispatchResolver;
    readonly failures: {
      sessionId: SessionId;
      runId: RunId;
      providerFailureDetail: string;
    }[];
  }

  function buildHarness(overrides: Partial<ClaudeSessionLifecycleDependencies> = {}): Harness {
    const transport = new FakeClaudeSessionTransport();
    const runDispatchResolver = new FakeClaudeRunDispatchResolver();
    const failures: Harness["failures"] = [];
    const lifecycle = new ClaudeSessionLifecycle({
      transport,
      runDispatchResolver,
      diagnostics: makeSilentDriverDiagnostics(),
      mintProviderSessionId: () => TEST_PINNED_PROVIDER_SESSION_ID,
      mintBindingId: () => TEST_BINDING_ID,
      onTextNeutralizationFailure: (sessionId, runId, failure) => {
        failures.push({ sessionId, runId, providerFailureDetail: failure.providerFailureDetail });
      },
      ...overrides,
    });
    return { lifecycle, transport, runDispatchResolver, failures };
  }

  async function startRunWith(
    harness: Harness,
    openingText: string,
  ): Promise<FakeClaudeSessionTransport["spawnedChannels"][number]> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText,
    });
    await harness.lifecycle.startRun(buildStartRunParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }
    return channel;
  }

  it("neutralizes command-shaped run-opening text on the wire only", async () => {
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    // The wire bytes carry the sentinel; the author's bytes do not. The
    // transport-only property, asserted at the byte level on a real driver path.
    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
    expect(channel.sentAuthoredTexts).toStrictEqual(["/status please"]);
  });

  it("neutralizes queue-admitted content too, which re-enters through the same path", async () => {
    // Run-opening content and admitted queue content are two ADMISSIONS, not two
    // code paths: both reach the provider through `startRun`. Asserted with a
    // second run on the same live session, which is the shape a queue admission
    // takes, so a reader does not have to take the single-path claim on trust.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "first turn");
    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/status please",
    });
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });

    expect(channel.sentWireTexts).toStrictEqual(["first turn", "\n/status please"]);
    expect(channel.sentAuthoredTexts).toStrictEqual(["first turn", "/status please"]);
  });

  it("leaves the daemon's own record of the text untouched", async () => {
    // The history non-mutation property, asserted where this layer can honestly
    // reach it. The dispatch record is the daemon-owned value the run's
    // persisted event row, its replayed timeline, and any rollback target are
    // all built from — the driver receives it and never writes back — so a
    // sentinel reaching any of those three surfaces would have to pass through
    // here first. What is asserted is therefore the whole of the driver's
    // obligation: it mutates neither the record nor the author's bytes, and the
    // one string that differs is the one that never leaves the wire.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    const dispatch = harness.runDispatchResolver.dispatchByRunId.get(TEST_RUN_ID);
    expect(dispatch?.openingText).toBe("/status please");
    expect(dispatch?.openingText).toBe(channel.sentAuthoredTexts[0]);
    expect(dispatch?.openingText?.startsWith("\n")).toBe(false);
    expect(channel.sentWireTexts[0]).not.toBe(dispatch?.openingText);
  });

  it("leaves ordinary run-opening text byte-identical", async () => {
    const harness = buildHarness();
    const channel = await startRunWith(harness, "please read /etc/hosts");

    expect(channel.sentWireTexts).toStrictEqual(["please read /etc/hosts"]);
  });

  it("neutralizes on a dispatch that names no origin, because none can be named", async () => {
    // The port carries no origin member at all: the run-opening boundary mints
    // `participant_text` from a literal. A resolver reading daemon-side run
    // state cannot state the origin, so it cannot state it wrongly.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
  });

  it("ignores an exempt origin smuggled onto the dispatch record", async () => {
    // The hazard behind the minting: `driver_command` is the one arm that both
    // delivers command-shaped bytes verbatim AND excuses the turn from the
    // tripwire. A dispatch record that could carry it would hand a caller the
    // participant's words dispatched as a provider command and the swallow
    // reported as a completed turn. Written through a cast because TypeScript
    // already refuses it — the cast is what makes the runtime claim testable.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/compact",
      frameOrigin: "driver_command",
    } as ClaudeRunDispatch);
    await harness.lifecycle.startRun(buildStartRunParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }

    // Neutralized on the wire, and still WATCHED: the zero-turn terminal fails
    // the run under the minted origin rather than passing as an exempt frame.
    expect(channel.sentWireTexts).toStrictEqual(["\n/compact"]);
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.failures.map((failure) => failure.providerFailureDetail)).toStrictEqual([
      "driver.text_neutralization_failed origin=participant_text",
    ]);
  });

  it("emits the author's bytes when the leg is declared native", async () => {
    const harness = buildHarness({ textNeutralityMechanismGrade: "native" });
    const channel = await startRunWith(harness, "/status please");

    expect(channel.sentWireTexts).toStrictEqual(["/status please"]);
  });

  it("fails the run with the exact composed detail when the turn is swallowed", async () => {
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.failures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=participant_text",
      },
    ]);
  });

  it("disposes the run's provider binding, so a later attach is refused", async () => {
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    // Refused, not answered `undefined`: the two states mean different things,
    // and a quiet `undefined` reads as "no channel yet" — the one reading that
    // invites a retry straight back into the same swallow.
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("refuses a later run on the SESSION a trip disposed, not only the run that was on it", async () => {
    // The axis a run-keyed quarantine cannot reach. `startRun` resolves a
    // SESSION, so the surviving slot would hand the next run straight back to
    // the process that swallowed the participant's words — and the refusal has
    // to be asked for BEFORE the live-session lookup, because the trip also
    // disposes the channel and that lookup would otherwise answer
    // `no_live_session`: a plausible wrong cause that reads as a race and
    // invites a retry into the same swallow.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
    // Nothing reached the provider: a refusal that still wrote would have
    // dispatched into the condemned process.
    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
  });

  it("still reports a trip on a run that was interrupted before its terminal arrived", async () => {
    // The Codex leg had a real gap here: its interrupt retires the run route,
    // and the terminal that follows was then ruled with no run to report
    // against. This leg is asserted rather than asserted-about — the claim that
    // it interrupts through the channel alone, touching neither the route map
    // nor the slot, is only worth as much as a case that would fail if it
    // stopped being true.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID, reason: "participant_stop" });
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.failures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=participant_text",
      },
    ]);
    // And the session arm, so the next run cannot resolve the same slot and
    // dispatch into the process that swallowed the text.
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("refuses a second session-bound start pre-write, leaving no route its interrupt could aim", async () => {
    // The serialization guard fires at ONE pending frame, so this session's
    // watch budget can never fill through `startRun` — the capacity refusal
    // behind it is tripwire-level defense-in-depth (unit-covered above) — and
    // the properties the budget refusal used to prove on this path now belong
    // to the guard: the refusal is definitively pre-write, nothing already
    // written is forgotten to make room, and no run route survives it. The
    // route half is not inert bookkeeping: this provider's interrupt is
    // CHANNEL-scoped and carries no run identity, so a surviving route would
    // aim the refused run's interrupt at whichever OLDER turn is genuinely
    // running on the session.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "first turn");
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "one more",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toMatchObject({
      code: "driver.unavailable",
      fields: { reason: "session_turn_in_flight" },
    });

    // Nothing reached the provider on the refused path, and nothing already
    // written was forgotten to make room for it.
    expect(channel.sentWireTexts).toHaveLength(1);
    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBeUndefined();
    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_SECOND_RUN_ID, reason: "participant_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    // The live session never saw it. Asserted on the control-request log rather
    // than on the throw alone: a refusal raised AFTER the request went out would
    // satisfy the rejection and still have interrupted somebody else's turn.
    expect(channel.controlRequests).toStrictEqual([]);
  });

  it("tears the condemned channel down, so the promised recovery is a fresh spawn", async () => {
    // The refusal alone leaves the process running with nothing holding it. The
    // teardown is detached — it runs inside the channel's own terminal listener,
    // which may neither wait on a child's death nor be unwound by one — so it is
    // observed after a drain rather than synchronously.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(channel.disposals).toStrictEqual(["session_closed"]);
    // The run terminal still landed: the teardown is a second act, never a
    // replacement for the only user-visible surface a swallowed turn has.
    expect(harness.failures).toHaveLength(1);
  });

  it("lets a fresh session under the same id run again after a trip", async () => {
    // The quarantine names a BINDING, not an identifier. Refusing the id forever
    // would refuse the very recovery the trip promises.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    await harness.lifecycle.createSession(buildCreateSessionParams());
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });

    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).resolves.toBeUndefined();
  });

  it("does not fail an ordinary turn", async () => {
    // The negative control on the real driver path.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.failures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
  });

  it("does not fail a genuine turn that ended in a provider-side refusal", async () => {
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_API_ERRORED_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.failures).toStrictEqual([]);
  });

  /**
   * Arranges a live session whose next write fails with the given delivery, and
   * returns the channel. The delivery is always stated explicitly: the whole
   * point of these cases is which arm the classification lands on, so a default
   * would be the one detail a reader has to go and look up.
   */
  async function arrangeFailingWrite(
    harness: Harness,
    delivery: "unsent" | "indeterminate",
    openingText = "/status please",
  ): Promise<FakeClaudeSessionTransport["spawnedChannels"][number]> {
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }
    channel.sendUserTextFailure = new Error("the provider stream is closed");
    channel.sendUserTextDelivery = delivery;
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText,
    });
    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow(
      "the provider stream is closed",
    );
    return channel;
  }

  it("drops a provably unsent frame, so it cannot consume a later run's turn", async () => {
    // The channel reports that it refused ahead of its write, so nothing reached
    // the provider and no turn will ever account for the frame. A stale
    // registration would still be correlated when the NEXT run on this session
    // settles — and, being the older one, it would consume that turn's evidence
    // and leave the live run ruled against none, failing the run whose text
    // actually reached the provider.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "unsent");
    expect(channel.sentWireTexts).toStrictEqual([]);

    channel.sendUserTextFailure = undefined;
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "second turn",
    });
    await harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID });

    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.failures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).not.toThrow();
  });

  it("retires the route of a provably unsent run, so its interrupt cannot stop another turn", async () => {
    // The route goes with the registration on this arm, and that matters more
    // than tidiness: this provider's interrupt is CHANNEL-scoped, so a route
    // pointing at a run that provably never dispatched is an aimed weapon with
    // nothing to aim at. Left bound, the interrupt for it would reach the live
    // session and stop whatever turn is genuinely running there.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "unsent");

    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_RUN_ID, reason: "participant_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    expect(channel.controlRequests).toStrictEqual([]);
  });

  it("fails a run whose bytes may have been taken and whose turn then showed no model output", async () => {
    // The case a blanket drop silently passed. The channel took the bytes and
    // then failed, so the provider may have received the text, intercepted it as
    // a client-side command, and answered with a zero-turn success — and the
    // rejection the caller saw says nothing either way. The registration is
    // RETAINED and the turn's own terminal, on a channel that is still
    // serviceable, is what rules it.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "indeterminate");

    expect(channel.isClosed).toBe(false);
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.failures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=participant_text",
      },
    ]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("does not fail a run whose ambiguous write was followed by a genuine model turn", async () => {
    // The negative control for retention. Retaining an ambiguous frame is not a
    // deferred trip: the turn arrives, the evidence is there, and the frame
    // passes. A retention that failed here would make every recoverable write
    // hiccup an outage.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "indeterminate");

    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.failures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
  });

  it("rules an ambiguous write immediately when the channel can no longer deliver a terminal", async () => {
    // The one case retention cannot cover: no terminal will ever arrive, so
    // waiting is silence in exactly the case that warrants the loudest answer.
    // Ruled fail-closed at the write instead — the same disposal the settlement
    // path performs, in the same order.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }
    channel.sendUserTextFailure = new Error("the provider stream is closed");
    channel.sendUserTextDelivery = "indeterminate";
    channel.isClosed = true;
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/status please",
    });
    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow(
      "the provider stream is closed",
    );
    await drainMicrotasks();

    expect(harness.failures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=participant_text",
      },
    ]);
    // Both quarantine axes, and the channel torn down: the refusal alone would
    // leave the process running with nothing holding it.
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
    expect(channel.disposals).toStrictEqual(["session_closed"]);

    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("treats a channel that raised instead of reporting as ambiguous, never as unsent", async () => {
    // A transport in breach of the port's obligation. A rejection carries no
    // claim about bytes, and "unsent" is precisely a claim about bytes, so the
    // broken contract lands on the fail-closed arm rather than being read as
    // good news: the frame is retained and the turn rules it.
    const harness = buildHarness();
    await harness.lifecycle.createSession(buildCreateSessionParams());
    const channel = harness.transport.spawnedChannels[0];
    if (channel === undefined) {
      throw new Error("expected the harness to have spawned a channel");
    }
    channel.sendUserTextRejection = new Error("the transport threw instead of reporting");
    harness.runDispatchResolver.dispatchByRunId.set(TEST_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "/status please",
    });
    await expect(harness.lifecycle.startRun(buildStartRunParams())).rejects.toThrow(
      "the transport threw instead of reporting",
    );

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.failures.map((failure) => failure.runId)).toStrictEqual([TEST_RUN_ID]);
  });

  it("never lets a second run's frame contend for a terminal that can vouch for one turn only", async () => {
    // One terminal ends one turn, and spreading its evidence across routed runs
    // is the masking this tripwire exists to prevent: the good turn would vouch
    // for text that never ran. The serialization guard now refuses the
    // contending start outright, so the terminal's evidence has exactly one
    // claimant — the run whose text actually ran — and no healthy run is ruled
    // against a terminal that was never its own.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "first turn");
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "second turn",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toMatchObject({ fields: { reason: "session_turn_in_flight" } });

    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    // The refused run was never dispatched, so nothing fails: the evidence
    // lands on its one real claimant and the session stays healthy.
    expect(harness.failures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBeUndefined();
  });

  it("keeps the predecessor's frames correlated when a rewind's adoption fails", async () => {
    // A rewind that fails after the fork is minted restores the PREDECESSOR,
    // which is still running and still owes a ruling on the turn it is in the
    // middle of. Dropping that correlation ahead of the successor's adoption
    // would let the evidence-free terminal below pass as a completed turn — the
    // exact swallow this tripwire exists to catch, hidden by the recovery path.
    const harness = buildHarness();
    const predecessorChannel = await startRunWith(harness, "/status please");

    // The transport refuses the terminal-hook registration, which is the last
    // thing that runs inside the driver's adoption window.
    harness.transport.onTurnTerminalFailure = new Error("the transport refused the terminal hook");

    const rollback = await harness.lifecycle.rollbackTo({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    expect(rollback.status).toBe("degraded");
    // Non-destructive on failure: the predecessor is the bound channel again,
    // and the FORK is what was released. Asserted so the ruling below is read
    // off the predecessor's own frame rather than off a successor that was
    // adopted and inherited the correlation.
    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBe(predecessorChannel);
    const forkChannel = harness.transport.spawnedChannels[1];
    if (forkChannel === undefined) {
      throw new Error("expected the rewind to have spawned a fork channel");
    }
    expect(forkChannel.disposals).toStrictEqual(["establishment_failed"]);

    predecessorChannel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    predecessorChannel.emitStreamFrame("result/success");

    expect(harness.failures.map((failure) => failure.runId)).toStrictEqual([TEST_RUN_ID]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("still disposes the binding when the failure consumer throws", async () => {
    // The run terminal is the guarantee; losing the disposal because a listener
    // threw would leave the swallowed turn reachable as well as unrecorded.
    const harness = buildHarness({
      onTextNeutralizationFailure: () => {
        throw new Error("the emission pipeline is unavailable");
      },
    });
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    expect(() => channel.emitStreamFrame("result/success")).not.toThrow();
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });
});

// --------------------------------------------------------------------------
// The Codex intervention path
// --------------------------------------------------------------------------

describe("Codex steer intervention under a text-neutralization refusal", () => {
  const CODEX_RUN_ID = "run-1" as RunId;

  function buildDispatcher(refused: boolean): {
    readonly dispatcher: CodexInterventionDispatcher;
    readonly steerRun: ReturnType<typeof vi.fn>;
    readonly decisionReads: string[];
  } {
    const decisionReads: string[] = [];
    const steerRun = vi.fn(async (request: { expectedTurnId?: string | undefined }) => {
      const targetedTurnId = request.expectedTurnId ?? "turn-live";
      return { targetedTurnId, acknowledgedTurnId: targetedTurnId };
    });
    const runtime = {
      steerRun,
      interruptRun: vi.fn(async () => {}),
      textNeutralizationDecisionForTurn: (turnId: string): { readonly refused: boolean } => {
        decisionReads.push(turnId);
        return { refused };
      },
    } as unknown as CodexInterventionRuntime;
    const capabilities = {
      driverName: "codex",
      driverVersion: "0.150.1",
      flags: { steer: true },
    } as unknown as DriverCapabilities;
    return {
      dispatcher: new CodexInterventionDispatcher({
        runtime,
        readCapabilities: () => capabilities,
      }),
      steerRun,
      decisionReads,
    };
  }

  const steerParams = {
    type: "steer" as const,
    targetRunId: CODEX_RUN_ID,
    expectedRunVersion: 3,
    clientIdempotencyKey: "3f1d2b4c-0000-4000-8000-000000000001",
    payload: { content: "/status please", expectedTurnId: "turn-01" },
  };

  it("settles degraded with the refusal code and no fallbackAction", async () => {
    const { dispatcher } = buildDispatcher(true);

    const result = await dispatcher.applyIntervention(steerParams);

    // Parsed through the real envelope schema rather than shape-asserted, so the
    // `.strict()` guarantee is exercised rather than described.
    const parsed = DriverInterventionResultSchema.parse(result);
    expect(parsed.status).toBe("degraded");
    expect(parsed.refusalCode).toBe(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    // No `fallbackAction`: `queue_and_interrupt` would re-queue the same text
    // into the same swallow, which is the failure again rather than a remedy.
    expect("fallbackAction" in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toStrictEqual(["refusalCode", "status"]);
  });

  it("raises no error on the refusal path", async () => {
    const { dispatcher } = buildDispatcher(true);

    // The refusal is DATA, never an exception: an unsupported-or-refused
    // intervention is something the orchestration layer has to choose against.
    await expect(dispatcher.applyIntervention(steerParams)).resolves.toBeDefined();
  });

  it("takes precedence over a matching acknowledgement", async () => {
    // A swallowed steer can still come back with a perfectly matching ack — the
    // provider accepted a turn, it simply never showed the words to a model — so
    // grading the ack first would report `applied` for an undelivered directive.
    const { dispatcher } = buildDispatcher(true);

    expect((await dispatcher.applyIntervention(steerParams)).status).toBe("degraded");
  });

  it("asks about the turn that actually went on the wire", async () => {
    const { dispatcher, decisionReads } = buildDispatcher(false);

    await dispatcher.applyIntervention({ ...steerParams, payload: { content: "keep going" } });

    expect(decisionReads).toStrictEqual(["turn-live"]);
  });

  it("declares the steer directive as participant text", async () => {
    const { dispatcher, steerRun } = buildDispatcher(false);

    await dispatcher.applyIntervention(steerParams);

    expect(steerRun.mock.calls[0]?.[0]).toMatchObject({ frameOrigin: "participant_text" });
  });

  it("applies normally when no refusal is known", async () => {
    const { dispatcher } = buildDispatcher(false);

    expect(await dispatcher.applyIntervention(steerParams)).toStrictEqual({ status: "applied" });
  });
});
