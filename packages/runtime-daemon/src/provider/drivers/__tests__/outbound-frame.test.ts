// Provider-bound text neutralization and the runtime tripwire.
//
// A provider CLI whose programmatic input also parses client-side commands consumes a message
// whose first word is command-shaped and answers with a zero-turn success: a well-formed
// terminal frame with no error, no model attribution and no token accounting. The user's words
// never reach the model while every layer above reads a completed turn.
//
// Two properties must hold together: the bytes on the wire are neutralized, and a turn that
// settles with no evidence of a model having run fails loudly.
//
// The Claude vectors are recorded frames (see the Claude turn-evidence fixture); the Codex
// bodies are shaped after recorded app-server frames.

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
} from "../codex/turn-evidence.js";
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
  RuntimeBindingQuarantine,
  TextNeutralizationRefusedError,
  TEXT_NEUTRALIZATION_REFUSAL_CODE,
  UNRECOGNIZED_TURN_EVIDENCE,
  type OutboundFrameRole,
  type OutboundTextFrame,
} from "../outbound-frame.js";

// --------------------------------------------------------------------------
// Byte vocabulary, named by code point
// --------------------------------------------------------------------------
//
// Code points, not literal characters: half of these are invisible in an editor.

/** The six ASCII whitespace bytes the predicate skips, and nothing else. */
const ASCII_WHITESPACE_LEADS: readonly string[] = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20].map(
  (codePoint) => String.fromCodePoint(codePoint),
);

/** Two Unicode spaces outside that set. */
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

/**
 * Invisible characters the sentinel must never use: zero-width space, word joiner, byte-order
 * mark, zero-width joiner, variation selector 16, and a Unicode tag character.
 */
const FORBIDDEN_INVISIBLE_SENTINELS: readonly string[] = [
  0x200b, 0x2060, 0xfeff, 0x200d, 0xfe0f, 0xe0001,
].map((codePoint) => String.fromCodePoint(codePoint));

// --------------------------------------------------------------------------
// The command-shaped predicate
// --------------------------------------------------------------------------

describe("command-shaped text predicate", () => {
  it("treats a leading slash as command-shaped regardless of what follows it", () => {
    // No command-name list is consulted: the measured interception happens on the leading byte,
    // upstream of any name lookup, so avoiding real command names does not dodge it.
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
    // A predicate that matched anywhere would silently corrupt every message that mentions a path.
    expect(isCommandShapedText("please read /etc/hosts")).toBe(false);
    expect(isCommandShapedText("use the a/b test")).toBe(false);
    expect(isCommandShapedText("")).toBe(false);
    expect(isCommandShapedText("   ")).toBe(false);
  });

  it("does not treat a non-ASCII whitespace lead as command-shaped", () => {
    // Deliberate: the predicate mirrors a provider's own ASCII parser, and over-matching would
    // neutralize text no provider intercepts. A parser that does skip exotic whitespace is the
    // tripwire's job.
    expect(isCommandShapedText(NO_BREAK_SPACE + "/status")).toBe(false);
    expect(isCommandShapedText(IDEOGRAPHIC_SPACE + "/status")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// The writer, byte-level, with the grade as an input
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
      origin: "human_text",
    });

    // Asserted as bytes: a boolean would not notice a second newline, an added space, a
    // zero-width character or a reordering.
    expect([...frame.wireText]).toStrictEqual(["\n", ...[..."/status please"]]);
    expect(frame.wireText).toBe(OUTBOUND_TEXT_NEUTRALIZATION_SENTINEL + "/status please");
    expect(frame.wireText.length).toBe("/status please".length + 1);
    expect(frame.neutralized).toBe(true);
  });

  it("emits the author's bytes unchanged on a leg declared native", () => {
    // The grade is a behavioral input; both drivers default to `emulated`, so this arm is driven
    // by the test's own declaration.
    const frame = writer("native").compose({ text: "/status please", origin: "human_text" });

    expect(frame.wireText).toBe("/status please");
    expect(frame.neutralized).toBe(false);
    expect([...frame.wireText][0]).toBe("/");
  });

  it("leaves non-command-shaped text byte-identical on both grades", () => {
    for (const grade of ["emulated", "native"] as const) {
      const frame = writer(grade).compose({
        text: "please read /etc/hosts",
        origin: "human_text",
      });
      expect(frame.wireText).toBe("please read /etc/hosts");
      expect(frame.neutralized).toBe(false);
    }
  });

  it("delivers a driver_command frame verbatim and exempts it from the tripwire", () => {
    // The leading slash is this origin's payload; neutralizing it would break the dispatch.
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
    // Fail-closed. An undeclared capability flag would resolve fail-open, which is backwards for
    // this hazard, so the writer discriminates on frame origin instead.
    for (const origin of [undefined, "human-text", "HUMAN_TEXT", "arbitrary"]) {
      const frame = writer("emulated").compose({ text: "/status", origin });
      expect(frame.wireText).toBe("\n/status");
      expect(frame.tripwireExempt).toBe(false);
      expect(frame.origin).toBeNull();
      // A rejected value is never echoed into a persisted, operator-visible string.
      expect(frame.detailOrigin).toBe("unknown");
    }
  });

  it("never mutates the author's bytes, whatever it puts on the wire", () => {
    const authored = "/status please";
    const frame = writer("emulated").compose({ text: authored, origin: "human_text" });

    // The sentinel is transport-only: `authoredText` is what the daemon persists and replays.
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

    expect(perFrameWriter.compose({ text: "one", origin: "human_text" }).correlationId).toBe(
      "correlation-1",
    );
    expect(perFrameWriter.compose({ text: "two", origin: "human_text" }).correlationId).toBe(
      "correlation-2",
    );
  });

  it("uses no invisible or zero-width character as its sentinel", () => {
    // An invisible sentinel looks like an attack to a reader diffing bytes and survives
    // copy-paste where nobody can see it.
    const frame = writer("emulated").compose({ text: "/status", origin: "human_text" });
    for (const forbidden of FORBIDDEN_INVISIBLE_SENTINELS) {
      expect(frame.wireText).not.toContain(forbidden);
    }
  });

  it("freezes the frame it mints", () => {
    expect(
      Object.isFrozen(writer("emulated").compose({ text: "/status", origin: "human_text" })),
    ).toBe(true);
  });

  it("keeps the origin union closed at three members", () => {
    // A fourth origin would need its own neutralization and exemption decisions.
    expect([...OUTBOUND_FRAME_ORIGINS]).toStrictEqual([
      "human_text",
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
    // The key negative control: this frame renders synthetic and reports `is_error: true` yet is
    // a real, billed turn, so a classifier keyed on either field would fail it.
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

  it("does not read a user echo as evidence that a model saw it", () => {
    // The echo is the provider sending the input back; reading it as evidence would assert the
    // very thing in doubt.
    const dispatch = codexCommandDispatchResponse("turn-1");
    const turn = dispatch["turn"] as Record<string, unknown>;
    expect((turn["items"] as unknown[]).length).toBe(1);
    expect(classifyCodexTurnEvidence(dispatch).observations).not.toContain("model_output");
  });

  it("passes a typed declared failure so an unrelated outage is not misreported", () => {
    // The measured quota-exhausted turn has no model output but is not a neutralization failure;
    // reporting it as one would put the wrong cause in a shared operator-visible field.
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
    // `turn/completed` can carry `itemsView: "notLoaded"` beside an empty item list (measured at
    // the pinned build): items not loaded, not output absent.
    expect(
      classifyCodexTurnEvidenceObservation("item/completed", {
        turnId: "turn-1",
        item: { type: "agentMessage", id: "item-2" },
      }),
    ).toStrictEqual({ turnId: "turn-1", observation: "model_output" });
  });

  it("reads no in-flight evidence off a user echo or an unrelated method", () => {
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
  // A fresh correlation per frame: the store is keyed by it, and a shared value would make two
  // frames on one turn indistinguishable.
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

  // The scope key is the provider binding the frame is written on. Correlation cases share one
  // binding; the capacity cases name their own.
  function registerFrame(
    tripwire: OutboundFrameTripwire,
    joinKey: string,
    frame: OutboundTextFrame,
    scopeKey = "session-1",
    frameRole: OutboundFrameRole = "turn-opening",
  ): void {
    tripwire.register({ scopeKey, joinKey, frameRole, frame });
  }

  it("trips when a correlated turn settles with no evidence", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("human_text"));

    const decision = tripwire.settle(
      "join-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    if (!decision.tripped) {
      throw new Error("expected the recorded zero-turn reply to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.refusalCode).toBe(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    expect(decision.failureDetail).toBe("driver.text_neutralization_failed origin=human_text");
  });

  it("trips on an unrecognized settling envelope", () => {
    // Fail-closed: an envelope the driver cannot parse is indistinguishable from a locally
    // composed reply.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "join-1", frameFor("human_text"));

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
    // The exact string: two producers share this field and a consumer parses it.
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
    registerFrame(tripwire, "join-1", frameFor("human_text"));
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
    registerFrame(tripwire, "join-1", frameFor("human_text"));

    expect(tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
    expect(tripwire.settle("join-1", UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("re-keys a registration onto the turn id the provider names", () => {
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    registerFrame(tripwire, "run-1", openingFrame);
    tripwire.recorrelateFrame(openingFrame, "turn-1");

    expect(tripwire.settle("run-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(false);
    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
  });

  it("carries the observations a frame accrued under its old key across the move", () => {
    // The re-key can happen after a fast turn already produced output, so resetting the accrual
    // would report an answered turn as swallowed.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    registerFrame(tripwire, "run-1", openingFrame);
    tripwire.observe("run-1", "model_output");
    tripwire.recorrelateFrame(openingFrame, "turn-1");

    expect(tripwire.settle("turn-1", observedTurnEvidence())).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("leaves a frame that is no longer pending un-registered", () => {
    // A settled, forgotten or reclaimed frame is owed no further correlation; re-admitting it
    // would let one frame be ruled twice.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
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
    // The drivers' failed-opening-frame handling withdraws only the refused frame and keeps the
    // run's route while this predicate answers true. Forgetting one of two frames on a key must
    // not answer for the sibling still owed a ruling.
    const tripwire = new OutboundFrameTripwire();
    const acceptedFrame = frameFor("human_text");
    const refusedFrame = frameFor("human_text", "/clear");
    registerFrame(tripwire, "run-1", acceptedFrame);
    registerFrame(tripwire, "run-1", refusedFrame);

    tripwire.forgetFrame(refusedFrame);
    expect(tripwire.hasPendingFrame("run-1")).toBe(true);

    tripwire.forgetFrame(acceptedFrame);
    expect(tripwire.hasPendingFrame("run-1")).toBe(false);
  });

  it("leaves the destination turn's retained decision standing", () => {
    // A move is not a fresh attempt: `register` clears the key it writes to, but a settled turn's
    // ruling belongs to the turn. Clearing it would erase the trip the intervention path reads
    // back when an acknowledged steer names a turn whose terminal already went by.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);
    const laterFrame = frameFor("human_text", "/clear");
    registerFrame(tripwire, "run-1", laterFrame);

    tripwire.recorrelateFrame(laterFrame, "turn-1");

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
  });

  it("drops a registration no turn will ever settle", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "run-1", frameFor("human_text"));
    tripwire.forget("run-1");

    expect(tripwire.settle("run-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(false);
  });

  it("retains a settled decision so a caller can ask after the fact", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
    expect(tripwire.decisionFor("turn-unasked")).toBeUndefined();
  });

  it("composes the run terminal a trip lands on", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    const decision = tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);
    if (!decision.tripped) {
      throw new Error("expected a trip");
    }

    expect(composeTextNeutralizationRunFailure(decision)).toStrictEqual({
      eventType: "run.failed",
      failureCategory: "provider failure",
      recoveryCondition: "recovery-needed",
      providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
    });
  });

  it("composes the detail in the fixed three-value form", () => {
    expect(composeTextNeutralizationFailureDetail("human_text")).toBe(
      "driver.text_neutralization_failed origin=human_text",
    );
    expect(composeTextNeutralizationFailureDetail("system_narration")).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
    expect(composeTextNeutralizationFailureDetail("unknown")).toBe(
      "driver.text_neutralization_failed origin=unknown",
    );
  });
  it("does not let evidence produced BEFORE a steer vouch for the steer", () => {
    // The settling envelope's item list is the whole turn's, so every item precedes a steer
    // written later; crediting the list to the steer would let a swallowed directive pass. Items
    // and the envelope credit the turn-opening frame alone. The frames carry different origins
    // so the failure detail names which one went unaccounted for.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.observe("turn-1", "model_output");
    registerFrame(
      tripwire,
      "turn-1",
      frameFor("system_narration", "/clear"),
      "session-1",
      "turn-joining",
    );

    const decision = tripwire.settle("turn-1", observedTurnEvidence("model_output"));

    if (!decision.tripped) {
      throw new Error("expected the steer no evidence is attributable to to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.failureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
  });

  it("rules the opening frame on its items and a joined frame on its answered request", () => {
    // An answered opening frame stays answered when a steer joins its turn, and an unloaded item
    // list must not fail it: the opener holds its item, and the steer holds the provider's answer
    // to its own request, the only per-frame statement the transport produces (receipt, not
    // delivery).
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.observe("turn-1", "model_output");
    const steerFrame = frameFor("human_text", "also check the tests");
    registerFrame(tripwire, "turn-1", steerFrame, "session-1", "turn-joining");
    tripwire.recordRequestAnswered(steerFrame);

    expect(tripwire.settle("turn-1", observedTurnEvidence())).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("does not let the opener's delayed output vouch an already-evidenced turn's steer", () => {
    // The opener is already vouched, a steer registers, and a delayed item from the opener's own
    // output arrives. Crediting the oldest frame without evidence would hand that item to the
    // steer and let a swallowed steer pass. Items credit the turn-opening frame alone, so the
    // unacknowledged steer trips.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.observe("turn-1", "model_output");
    registerFrame(
      tripwire,
      "turn-1",
      frameFor("system_narration", "/clear"),
      "session-1",
      "turn-joining",
    );
    tripwire.observe("turn-1", "model_output");

    const decision = tripwire.settle("turn-1", observedTurnEvidence());

    if (!decision.tripped) {
      throw new Error("expected the steer no item is attributable to to trip");
    }
    expect(decision.cause).toBe("no-turn-evidence");
    expect(decision.failureDetail).toBe(
      "driver.text_neutralization_failed origin=system_narration",
    );
  });

  it("never lets an answered request vouch for a turn-opening frame", () => {
    // The zero-turn hazard is a request answered as taken and met with an empty turn, so an
    // answer-vouched opener would pass in exactly the case the tripwire exists to catch. The
    // call is a fail-closed no-op.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    registerFrame(tripwire, "turn-1", openingFrame);
    tripwire.recordRequestAnswered(openingFrame);

    const decision = tripwire.settle("turn-1", observedTurnEvidence());

    expect(decision.tripped).toBe(true);
  });

  it("trips even an acknowledged steer when the settlement is unrecognized", () => {
    // `recognized` is a property of the turn: a zero-turn settlement means the whole turn was
    // swallowed, and no frame's proven delivery outranks that.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.observe("turn-1", "model_output");
    const steerFrame = frameFor("human_text", "keep going");
    registerFrame(tripwire, "turn-1", steerFrame, "session-1", "turn-joining");
    tripwire.recordRequestAnswered(steerFrame);

    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
  });

  it("consumes every frame on a turn, so a second terminal rules on none", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    registerFrame(tripwire, "turn-1", frameFor("human_text", "/clear"));

    expect(tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(true);
    expect(tripwire.hasPendingFrame("turn-1")).toBe(false);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output"))).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("leaves a retained decision alone when a turn it holds no frame for settles", () => {
    // The `no-correlated-frame` arm must store nothing: when the terminal settles before any
    // frame is correlated (same read chunk), a stored pass would overwrite the trip the re-keyed
    // frame produces a microtask later.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"));
    tripwire.settle("turn-1", UNRECOGNIZED_TURN_EVIDENCE);

    tripwire.settle("turn-1", observedTurnEvidence("model_output"));

    expect(tripwire.decisionFor("turn-1")?.tripped).toBe(true);
  });

  it("re-keys ONLY the named frame, leaving a concurrent attempt's on the run", () => {
    // Every attempt on a run registers under the run id and nothing serializes two starts. A
    // key-wide move would carry the second attempt's unnamed frame onto the first attempt's turn
    // and leave its own turn to settle against no correlated frame, which passes.
    const tripwire = new OutboundFrameTripwire();
    const firstAttemptFrame = frameFor("human_text");
    const secondAttemptFrame = frameFor("human_text", "/clear");
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
    // For a send that provably never reached the wire: leaving it registered would trip a turn
    // its text never entered, while dropping the whole key would silence the opening frame that
    // is still owed a ruling. A send whose delivery is merely unknown goes to `settleFrame`.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    const unsentSteerFrame = frameFor("human_text", "/clear");
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
    // For a frame whose delivery became unknowable while its turn stayed open. Settling the whole
    // key would trip every correlated frame, so the answered opening frame that produced output
    // would be reported swallowed too.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
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
    // Only that frame was consumed.
    expect(tripwire.hasPendingFrame("turn-1")).toBe(true);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output"))).toStrictEqual({
      tripped: false,
      reason: "turn-evidence-observed",
    });
  });

  it("does not record a turn decision when only one of its frames is ruled", () => {
    // The turn has not settled, so a stored trip would answer "swallowed" for a turn whose other
    // frames may yet pass, and the intervention path reads that decision back after the binding
    // is gone.
    const tripwire = new OutboundFrameTripwire();
    const openingFrame = frameFor("human_text");
    const uncertainSteerFrame = frameFor("human_text", "/clear");
    registerFrame(tripwire, "turn-1", openingFrame);
    registerFrame(tripwire, "turn-1", uncertainSteerFrame);

    expect(tripwire.settleFrame(uncertainSteerFrame, UNRECOGNIZED_TURN_EVIDENCE).tripped).toBe(
      true,
    );

    expect(tripwire.decisionFor("turn-1")).toBeUndefined();
  });

  it("rules a frame already withdrawn from its turn as uncorrelated", () => {
    // A frame consumed by its turn's own terminal was ruled once; ruling it again would report
    // one swallow twice.
    const tripwire = new OutboundFrameTripwire();
    const frame = frameFor("human_text");
    registerFrame(tripwire, "turn-1", frame);
    expect(tripwire.settle("turn-1", observedTurnEvidence("model_output")).tripped).toBe(false);

    expect(tripwire.settleFrame(frame, UNRECOGNIZED_TURN_EVIDENCE)).toStrictEqual({
      tripped: false,
      reason: "no-correlated-frame",
    });
  });

  it("releases the scope budget a frame ruled outside its turn was holding", () => {
    // A ruled frame must stop spending the per-binding pending budget, or a session that lost one
    // steer would refuse writes it should admit.
    const tripwire = new OutboundFrameTripwire();
    const frame = frameFor("human_text");
    registerFrame(tripwire, "turn-1", frame);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(1);

    tripwire.settleFrame(frame, UNRECOGNIZED_TURN_EVIDENCE);

    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
  });

  it("refuses a registration at capacity rather than discarding an unsettled frame", () => {
    // Evicting the oldest frame to take the write would be the silent swallow the tripwire exists
    // to catch: the evicted turn settles against nothing and passes. So the next write is refused
    // and every frame already stored is still ruled correctly.
    const tripwire = new OutboundFrameTripwire();
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("human_text"));
    }

    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("human_text"));
    }).toThrow(OutboundFrameCapacityRefusedError);

    // Nothing was evicted, and the refused frame was not registered.
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(
      OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY,
    );
    expect(tripwire.hasPendingFrame("turn-overflow")).toBe(false);
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      expect(tripwire.hasPendingFrame(`turn-${String(index)}`)).toBe(true);
    }

    // Each still settles on its own evidence; over-eager reclamation would show up here as a
    // `no-correlated-frame` pass.
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      expect(
        tripwire.settle(`turn-${String(index)}`, observedTurnEvidence("model_output")),
      ).toStrictEqual({ tripped: false, reason: "turn-evidence-observed" });
    }
    expect(tripwire.pendingFrameCount).toBe(0);
  });

  it("caps each provider binding separately, so one stalled session starves none", () => {
    // The bound is per binding: a manager-wide budget would let one session that never settles a
    // turn starve every other session.
    const tripwire = new OutboundFrameTripwire();
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `stalled-${String(index)}`, frameFor("human_text"), "stalled");
    }

    expect(() => {
      registerFrame(tripwire, "stalled-overflow", frameFor("human_text"), "stalled");
    }).toThrow(OutboundFrameCapacityRefusedError);
    expect(() => {
      registerFrame(tripwire, "healthy-1", frameFor("human_text"), "healthy");
    }).not.toThrow();
    expect(tripwire.hasPendingFrame("healthy-1")).toBe(true);
  });

  it("reclaims the frames of retired bindings before refusing", () => {
    // A session that died mid-turn can never settle its frames, so they are pure occupancy. That
    // is the only class of registration reclamation touches.
    const retiredScopeKeys = new Set<string>();
    const tripwire = new OutboundFrameTripwire({
      isScopeRetired: (scopeKey) => retiredScopeKeys.has(scopeKey),
    });
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("human_text"));
    }

    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("human_text"));
    }).toThrow(OutboundFrameCapacityRefusedError);

    retiredScopeKeys.add("session-1");
    registerFrame(tripwire, "turn-overflow", frameFor("human_text"));

    expect(tripwire.hasPendingFrame("turn-overflow")).toBe(true);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(1);
  });

  it("keeps a frame whose binding cannot be proven retired", () => {
    // A predicate that throws has not answered; reclaiming anyway would be the eviction the
    // refusal replaces.
    const tripwire = new OutboundFrameTripwire({
      isScopeRetired: () => {
        throw new Error("the driver could not answer");
      },
    });
    for (let index = 0; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("human_text"));
    }

    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("human_text"));
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
          frameFor("human_text"),
          `session-${String(scopeIndex)}`,
        );
      }
    }

    expect(tripwire.pendingFrameCount).toBe(OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY);
    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("human_text"), "session-fresh");
    }).toThrow(OutboundFrameCapacityRefusedError);
  });

  it("releases a binding's frames without touching the decisions read back by turn", () => {
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("human_text"), "session-2");
    const decision = tripwire.settle(
      "turn-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    tripwire.forgetScope("session-1");

    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
    expect(tripwire.hasPendingFrame("turn-2")).toBe(true);
    // The intervention path reads a retained decision by turn id after the binding is gone.
    expect(tripwire.decisionFor("turn-1")).toStrictEqual(decision);
  });

  it("abandons a superseded binding's frames as facts, minting no verdict", () => {
    // A supersede is neither "no turn could ever settle" (`forgetScope`) nor "text was swallowed"
    // (`settleScope`, which mints a trip). The frames are consumed and reported with what is
    // known, a join key and an origin, and no decision, because no evidence was observed either
    // way.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("system_narration"), "session-1");
    registerFrame(tripwire, "turn-3", frameFor("human_text"), "session-2");

    const abandoned = tripwire.abandonScope("session-1");

    expect(abandoned).toStrictEqual([
      { joinKey: "turn-1", detailOrigin: "human_text" },
      { joinKey: "turn-2", detailOrigin: "system_narration" },
    ]);
    // Consumed, not merely read: pending frames would spend a dead binding's budget forever.
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
    // The other binding is untouched.
    expect(tripwire.hasPendingFrame("turn-3")).toBe(true);
  });

  it("consumes an exempt frame without reporting it", () => {
    // A driver command carries no user words, so losing it costs nobody their turn. It is still
    // consumed, because the budget is about occupancy.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("driver_command"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("human_text"), "session-1");

    const abandoned = tripwire.abandonScope("session-1");

    expect(abandoned.map((frame) => frame.joinKey)).toStrictEqual(["turn-2"]);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
  });

  it("reports an answered frame whose turn never settled as delivery unproven", () => {
    // An answered request proves the provider took the frame, not that the model read it, and a
    // turn that died unsettled never reached the settlement that consumes the frame. Delivery is
    // unproven, so the frame is reported beside the opener.
    const tripwire = new OutboundFrameTripwire();
    const answeredSteer = frameFor("system_narration", "keep going");
    registerFrame(tripwire, "turn-1", frameFor("human_text"), "session-1");
    registerFrame(tripwire, "turn-1", answeredSteer, "session-1", "turn-joining");
    tripwire.recordRequestAnswered(answeredSteer);

    const abandoned = tripwire.abandonScope("session-1");

    expect(abandoned).toStrictEqual([
      { joinKey: "turn-1", detailOrigin: "human_text" },
      { joinKey: "turn-1", detailOrigin: "system_narration" },
    ]);
    expect(tripwire.pendingFrameCountForScope("session-1")).toBe(0);
  });

  it("reports an unrecognized origin rather than assuming it was harmless", () => {
    // Fail-closed, as the writer is: an absent or unrecognized origin becomes `unknown` and is
    // reported. Treating it as a driver command would exempt frames of unknown provenance.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor(undefined), "session-1");

    expect(tripwire.abandonScope("session-1")).toStrictEqual([
      { joinKey: "turn-1", detailOrigin: "unknown" },
    ]);
  });

  it("leaves retained decisions alone, as the other two disposals do", () => {
    // An abandon writes no decision of its own, since no turn settled, and must not erase one
    // that was.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-1", frameFor("human_text"), "session-1");
    registerFrame(tripwire, "turn-2", frameFor("human_text"), "session-1");
    const decision = tripwire.settle(
      "turn-1",
      classifyClaudeTurnEvidence(CLAUDE_ZERO_TURN_RESULT_FRAME),
    );

    const abandoned = tripwire.abandonScope("session-1");

    // The settled frame is already consumed.
    expect(abandoned.map((frame) => frame.joinKey)).toStrictEqual(["turn-2"]);
    expect(tripwire.decisionFor("turn-1")).toStrictEqual(decision);
    // No decision is invented for a frame whose turn never delivered a terminal.
    expect(tripwire.decisionFor("turn-2")).toBeUndefined();
  });

  it("still trips a turn that settles long after the store filled behind it", () => {
    // The oldest unsettled frame must not be evicted to admit a newer one: its late zero-turn
    // settlement would find no correlation and pass.
    const tripwire = new OutboundFrameTripwire();
    registerFrame(tripwire, "turn-oldest", frameFor("human_text"));
    for (let index = 1; index < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY; index += 1) {
      registerFrame(tripwire, `turn-${String(index)}`, frameFor("human_text"));
    }
    expect(() => {
      registerFrame(tripwire, "turn-overflow", frameFor("human_text"));
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

describe("runtime binding quarantine", () => {
  it("refuses an attach to a disposed binding with the code the trip carried", () => {
    const quarantine = new RuntimeBindingQuarantine();
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
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");

    expect(() => quarantine.assertRunAttachable("run-2")).not.toThrow();
  });

  it("refuses the session a trip condemned, not only the run that was on it", () => {
    // A later run resolves a session, so a refusal keyed only by run id would let it dispatch into
    // the process that swallowed the text.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeSession("session-1");

    expect(quarantine.isSessionDisposed("session-1")).toBe(true);
    expect(() => quarantine.assertSessionAttachable("session-1")).toThrow(
      TextNeutralizationRefusedError,
    );
    expect(() => quarantine.assertRunAttachable("session-1")).not.toThrow();
    expect(() => quarantine.assertSessionAttachable("session-2")).not.toThrow();
  });

  it("releases a session id whose binding a fresh spawn replaced, and its runs with it", () => {
    // The quarantine names a binding, not an identifier: recovery is a fresh process, and
    // refusing the id forever would refuse it. A run reopened after the fresh spawn (a rewind can
    // reinstate one) would otherwise stay refused for the daemon's lifetime, its interrupt and
    // intervention controls lost to a process that no longer exists.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeSession("session-1");
    quarantine.disposeRun("run-1", "session-1");
    quarantine.releaseSession("session-1");

    expect(() => quarantine.assertSessionAttachable("session-1")).not.toThrow();
    expect(quarantine.isRunDisposed("run-1")).toBe(false);
    expect(() => quarantine.assertRunAttachable("run-1")).not.toThrow();
  });

  it("releases only the runs the released binding condemned", () => {
    // The sweep is keyed by the condemning binding, not "release everything": a run quarantined
    // on another session is still on a process nothing replaced.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.disposeRun("run-2", "session-2");
    quarantine.releaseSession("session-1");

    expect(() => quarantine.assertRunAttachable("run-1")).not.toThrow();
    expect(() => quarantine.assertRunAttachable("run-2")).toThrow(TextNeutralizationRefusedError);
  });

  it("keeps a run refused when a DIFFERENT session is respawned", () => {
    // Releasing a binding that condemned nothing releases nothing.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.releaseSession("session-9");

    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(TextNeutralizationRefusedError);
  });

  it("re-quarantines a released run when the fresh binding trips too", () => {
    // A second trip on the fresh binding condemns the run again, under the new binding, so only
    // that binding's release clears it.
    const quarantine = new RuntimeBindingQuarantine();
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
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeRun("run-1", "session-1");
    quarantine.disposeSession("session-1");

    expect(() => quarantine.assertRunAttachable("run-1")).toThrow(/run run-1/);
    expect(() => quarantine.assertSessionAttachable("session-1")).toThrow(/session session-1/);
  });

  it("holds a bounded number of disposals, aging out the oldest", () => {
    // Neither collection has a completion guarantee, so both are capped. Aging out a disposal
    // cannot revive its run, which is already terminal; only the fail-fast refusal expires.
    const quarantine = new RuntimeBindingQuarantine();
    const disposedRunCount = 200;
    for (let index = 0; index < disposedRunCount; index += 1) {
      quarantine.disposeRun(`run-${String(index)}`, "session-1");
    }

    expect(quarantine.isRunDisposed("run-0")).toBe(false);
    expect(quarantine.isRunDisposed(`run-${String(disposedRunCount - 1)}`)).toBe(true);
  });

  it("caps the session axis independently of the run axis", () => {
    // Separate collections: a busy run axis must not age out a session refusal.
    const quarantine = new RuntimeBindingQuarantine();
    quarantine.disposeSession("session-1");
    for (let index = 0; index < 200; index += 1) {
      quarantine.disposeRun(`run-${String(index)}`, "session-2");
    }

    expect(quarantine.isSessionDisposed("session-1")).toBe(true);
  });

  it("keeps a re-disposed binding at the newest position", () => {
    const quarantine = new RuntimeBindingQuarantine();
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
 * Drains the microtask queue by yielding to the macrotask queue once. A counted
 * `await Promise.resolve()` would pin the tests to an exact number of microtask hops.
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

    // The wire bytes carry the sentinel; the author's bytes do not.
    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
    expect(channel.sentAuthoredTexts).toStrictEqual(["/status please"]);
  });

  it("neutralizes queue-admitted content too, which re-enters through the same path", async () => {
    // Run-opening and queue-admitted content both reach the provider through `startRun`; a second
    // run on the live session is the shape a queue admission takes.
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
    // The dispatch record is the daemon-owned value the persisted event row, the replayed
    // timeline and any rollback target are built from, and the driver never writes back to it.
    // The driver's whole obligation is to mutate neither the record nor the author's bytes; only
    // the wire string differs.
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
    // The dispatch port carries no origin member: the run-opening path supplies `human_text`
    // itself, so a resolver cannot state the origin wrongly.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
  });

  it("ignores an exempt origin smuggled onto the dispatch record", async () => {
    // `driver_command` both delivers command-shaped bytes verbatim and excuses the turn from the
    // tripwire. A dispatch record that could carry it would let the user's words run as a
    // provider command with the swallow reported as a completed turn. The cast is needed because
    // TypeScript already refuses it.
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

    // Neutralized on the wire and still watched: the zero-turn terminal fails the run under the
    // supplied origin rather than passing as an exempt frame.
    expect(channel.sentWireTexts).toStrictEqual(["\n/compact"]);
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    expect(harness.failures.map((failure) => failure.providerFailureDetail)).toStrictEqual([
      "driver.text_neutralization_failed origin=human_text",
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
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
  });

  it("disposes the run's provider binding, so a later attach is refused", async () => {
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");

    // Refused, not `undefined`: a quiet `undefined` reads as "no channel yet" and invites a retry
    // into the same swallow.
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("refuses a later run on the SESSION a trip disposed, not only the run that was on it", async () => {
    // `startRun` resolves a session, so a surviving slot would hand the next run back to the
    // process that swallowed the text. The refusal must be checked before the live-session
    // lookup: the trip also disposes the channel, and that lookup would answer `no_live_session`,
    // which reads as a race and invites a retry into the same swallow.
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
    // Nothing reached the provider.
    expect(channel.sentWireTexts).toStrictEqual(["\n/status please"]);
  });

  it("still reports a trip on a run that was interrupted before its terminal arrived", async () => {
    // The interrupt goes through the channel alone, touching neither the route map nor the slot,
    // so the terminal that follows still has a run to report against.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    await harness.lifecycle.interruptRun({ runId: TEST_RUN_ID, reason: "user_stop" });
    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.failures).toStrictEqual([
      {
        sessionId: TEST_SESSION_ID,
        runId: TEST_RUN_ID,
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    // The next run must not resolve the same slot and dispatch into the swallowing process.
    harness.runDispatchResolver.dispatchByRunId.set(TEST_SECOND_RUN_ID, {
      sessionId: TEST_SESSION_ID,
      openingText: "carry on",
    });
    await expect(
      harness.lifecycle.startRun({ ...buildStartRunParams(), runId: TEST_SECOND_RUN_ID }),
    ).rejects.toThrow(TextNeutralizationRefusedError);
  });

  it("refuses a second session-bound start pre-write, leaving no route its interrupt could aim", async () => {
    // The serialization guard fires at one pending frame, so `startRun` never fills the watch
    // budget. The refusal is pre-write, nothing already written is forgotten, and no run route
    // survives it. The route matters: this provider's interrupt is channel-scoped and carries no
    // run identity, so a surviving route would aim the refused run's interrupt at the older turn
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

    // Nothing reached the provider on the refused path.
    expect(channel.sentWireTexts).toHaveLength(1);
    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBeUndefined();
    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_SECOND_RUN_ID, reason: "user_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    // Asserted on the control-request log, since a refusal raised after the request went out
    // would satisfy the rejection and still have interrupted another turn.
    expect(channel.controlRequests).toStrictEqual([]);
  });

  it("tears the condemned channel down, so the promised recovery is a fresh spawn", async () => {
    // The refusal alone would leave the process running. The teardown is detached, since it runs
    // inside the channel's terminal listener, so it is observed after a drain.
    const harness = buildHarness();
    const channel = await startRunWith(harness, "/status please");

    channel.terminalFrameBody = CLAUDE_ZERO_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(channel.disposals).toStrictEqual(["session_closed"]);
    // The run terminal still landed; the teardown does not replace it.
    expect(harness.failures).toHaveLength(1);
  });

  it("lets a fresh session under the same id run again after a trip", async () => {
    // The quarantine names a binding, not an identifier; refusing the id forever would refuse
    // the recovery.
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
   * Arranges a live session whose next write fails with the given delivery, and returns the
   * channel. The delivery is always explicit because the cases test which arm it lands on.
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
    // The channel refused ahead of its write, so no turn will account for the frame. A stale
    // registration, being older, would consume the next run's evidence and fail the run whose
    // text actually reached the provider.
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
    // This provider's interrupt is channel-scoped, so a route left bound to a run that never
    // dispatched would let its interrupt stop whatever turn is running on the live session.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "unsent");

    expect(harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toBeUndefined();
    await expect(
      harness.lifecycle.interruptRun({ runId: TEST_RUN_ID, reason: "user_stop" }),
    ).rejects.toThrow(ClaudeSessionUnavailableError);
    expect(channel.controlRequests).toStrictEqual([]);
  });

  it("fails a run whose bytes may have been taken and whose turn then showed no model output", async () => {
    // The channel took the bytes and then failed, so the provider may have intercepted the text
    // and answered with a zero-turn success; the rejection says nothing either way. The
    // registration is retained and the turn's own terminal rules it.
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
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).toThrow(
      TextNeutralizationRefusedError,
    );
  });

  it("does not fail a run whose ambiguous write was followed by a genuine model turn", async () => {
    // Retaining an ambiguous frame is not a deferred trip: when real evidence arrives the frame
    // passes, or every recoverable write hiccup would become an outage.
    const harness = buildHarness();
    const channel = await arrangeFailingWrite(harness, "indeterminate");

    channel.terminalFrameBody = CLAUDE_ORDINARY_TURN_RESULT_FRAME;
    channel.emitStreamFrame("result/success");
    await drainMicrotasks();

    expect(harness.failures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
  });

  it("rules an ambiguous write immediately when the channel can no longer deliver a terminal", async () => {
    // Retention cannot cover a channel that can never deliver a terminal, so the frame is ruled
    // fail-closed at the write, with the same disposal the settlement path performs.
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
        providerFailureDetail: "driver.text_neutralization_failed origin=human_text",
      },
    ]);
    // Both quarantine axes, and the channel torn down.
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
    // A transport that throws breaks the port's contract. A rejection makes no claim about bytes
    // and "unsent" is one, so it lands on the fail-closed arm: the frame is retained and the
    // turn rules it.
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
    // One terminal ends one turn, and spreading its evidence across runs would let a good turn
    // vouch for text that never ran. The serialization guard refuses the contending start, so
    // the terminal's evidence has one claimant.
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

    // The refused run was never dispatched, so nothing fails.
    expect(harness.failures).toStrictEqual([]);
    expect(() => harness.lifecycle.findChannelForRun(TEST_RUN_ID)).not.toThrow();
    expect(harness.lifecycle.findChannelForRun(TEST_SECOND_RUN_ID)).toBeUndefined();
  });

  it("keeps the predecessor's frames correlated when a rewind's adoption fails", async () => {
    // A rewind that fails after the fork is minted restores the predecessor, which is still
    // mid-turn and owes a ruling. Dropping its correlation before the successor is adopted would
    // let the evidence-free terminal below pass as a completed turn.
    const harness = buildHarness();
    const predecessorChannel = await startRunWith(harness, "/status please");

    // The transport refuses the terminal-hook registration, the last step of the adoption window.
    harness.transport.onTurnTerminalFailure = new Error("the transport refused the terminal hook");

    const rollback = await harness.lifecycle.forkConversation({
      sessionId: TEST_SESSION_ID,
      bindingId: TEST_BINDING_ID,
      position: 4,
    });

    expect(rollback.status).toBe("degraded");
    // The predecessor is the bound channel again and the fork was released, so the ruling below
    // reads the predecessor's own frame.
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
    // A throwing listener must not lose the disposal, or the swallowed turn stays reachable as
    // well as unrecorded.
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

    // Parsed through the real envelope schema so its `.strict()` guarantee is exercised.
    const parsed = DriverInterventionResultSchema.parse(result);
    expect(parsed.status).toBe("degraded");
    expect(parsed.refusalCode).toBe(TEXT_NEUTRALIZATION_REFUSAL_CODE);
    // No `fallbackAction`: `queue_and_interrupt` would re-queue the same text into the same
    // swallow.
    expect("fallbackAction" in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toStrictEqual(["refusalCode", "status"]);
  });

  it("raises no error on the refusal path", async () => {
    const { dispatcher } = buildDispatcher(true);

    // The refusal is data, never an exception: the orchestration layer chooses against it.
    await expect(dispatcher.applyIntervention(steerParams)).resolves.toBeDefined();
  });

  it("takes precedence over a matching acknowledgement", async () => {
    // A swallowed steer can come back with a matching ack, since the provider accepted a turn
    // but never showed the words to a model, so grading the ack first would report `applied`.
    const { dispatcher } = buildDispatcher(true);

    expect((await dispatcher.applyIntervention(steerParams)).status).toBe("degraded");
  });

  it("asks about the turn that actually went on the wire", async () => {
    const { dispatcher, decisionReads } = buildDispatcher(false);

    await dispatcher.applyIntervention({ ...steerParams, payload: { content: "keep going" } });

    expect(decisionReads).toStrictEqual(["turn-live"]);
  });

  it("declares the steer directive as user text", async () => {
    const { dispatcher, steerRun } = buildDispatcher(false);

    await dispatcher.applyIntervention(steerParams);

    expect(steerRun.mock.calls[0]?.[0]).toMatchObject({ frameOrigin: "human_text" });
  });

  it("applies normally when no refusal is known", async () => {
    const { dispatcher } = buildDispatcher(false);

    expect(await dispatcher.applyIntervention(steerParams)).toStrictEqual({ status: "applied" });
  });
});
