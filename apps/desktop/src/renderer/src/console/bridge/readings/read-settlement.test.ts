// One settled read, the four ways it can finish, and who each refusal names as author.
//
// The daemon-refusal case drives the REAL scripted-reply adapter over a real scenario
// engine rather than throwing a hand-made envelope at the helper: the claim is that the
// shape that seam throws is the shape this module settles, and a locally invented
// envelope would agree with whatever this module happened to expect.
//
// The two pass-through cases are the control on every rejection case below. A helper
// that refused everything would satisfy all of them while replacing the fixture's own
// answers with a refusal no surface could tell from a real one.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, refuse, type WireErrorEnvelope } from "../../core/index.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { createFixture } from "../fixture/call-plane/bridge.test-support.js";
import { answerFromScriptedReply } from "../fixture/growth/scripted-answer.js";
import type { GrowthOutcome } from "../growth-port/growth-outcome.js";
import { growthUnavailable, growthUnscriptedReply } from "../growth-port/index.js";
import type { GrowthOperationSignatures } from "../growth-signatures/index.js";
import { ScenarioEngine } from "../scenario/runtime/engine.js";
import {
  READ_SETTLEMENT_REFUSAL_ORIGIN,
  settleGrowthRead,
  useSettledGrowthRead,
  type SettledGrowthRead,
} from "./read-settlement.js";
import {
  PROBE_PARTICIPANT_ID,
  PROBE_SESSION_ID,
} from "../scenario/runtime/scripted-probe.test-support.js";
import type { ConsoleScenario } from "../scenario/runtime/vocabulary.js";

/** The refusal the scenario below scripts, in the envelope a daemon sends. */
const SCRIPTED_DAEMON_REFUSAL: WireErrorEnvelope = {
  code: "workflow.session_not_found",
  message: "No session with that id is open on this node.",
};

/** What the enumeration answers with, read from the signature table rather than retyped. */
type DefinitionListValue = GrowthOperationSignatures["workflowDefinitionList"]["value"];

/**
 * A scenario that scripts one daemon refusal for the definition enumeration.
 *
 * No beats: nothing here reads the event stream, and beats would have to be held to the
 * wire-truth layer for facts no case below asserts.
 */
function scenarioRefusingTheEnumeration(): ConsoleScenario {
  return {
    id: "read-settlement-probe",
    label: "Read settlement probe",
    purpose: "Scripts a daemon refusal for the definition enumeration, and nothing else.",
    sessionId: PROBE_SESSION_ID,
    participantIdsInJoinOrder: [PROBE_PARTICIPANT_ID],
    startedAtIso: "2026-01-01T12:00:00.000Z",
    beats: [],
    replies: [{ call: "workflow.definitionList", refusal: SCRIPTED_DAEMON_REFUSAL }],
  };
}

/**
 * The enumeration, asked through the same seam the fixture's own port asks it through.
 *
 * The unscripted arm is unreachable from every case below — each scripts this call —
 * and exists to satisfy the adapter, which asks for the OUTCOME a scenario that
 * scripted nothing would have answered with. It is the served operation's own refusal
 * rather than an empty list, on the rule the builder's header states: an empty
 * enumeration is the claim that this session has no definitions, and a scenario that
 * models none has not made it.
 */
function enumerationThroughTheSeam(
  engine: ScenarioEngine,
): Promise<GrowthOutcome<DefinitionListValue>> {
  return answerFromScriptedReply(
    engine,
    "workflow.definitionList",
    "workflowDefinitionList",
    { sessionId: PROBE_SESSION_ID },
    () => growthUnscriptedReply("workflowDefinitionList", "workflow.definitionList"),
  );
}

describe("settleGrowthRead — a fulfilled outcome is the port's, untouched", () => {
  it("passes a served outcome through by identity", async () => {
    const served = { status: "served", value: { definitions: [] } } as const;

    await expect(settleGrowthRead(Promise.resolve(served))).resolves.toBe(served);
  });

  it("passes the port's own refusal through with everything it knows", async () => {
    // The control for every rejection case below: a helper that rebuilt refusals would
    // drop `operationId`, `slateRow`, and the document that owes the wire, and those are
    // what make a growth refusal actionable rather than merely typed.
    const refused = growthUnavailable("workflowDefinitionList");

    await expect(settleGrowthRead(Promise.resolve(refused))).resolves.toBe(refused);
  });
});

describe("settleGrowthRead — a rejection becomes a refusal, and names its author", () => {
  it("carries a scripted daemon refusal's own code and message, unreworded", async () => {
    const engine = new ScenarioEngine({ scenario: scenarioRefusingTheEnumeration() });

    const settled = await settleGrowthRead(enumerationThroughTheSeam(engine));

    // Verbatim on both halves. A console that composed its own sentence here would be
    // quoting a refusal it had edited, which rule 9 forbids. The origin names the seam
    // the refusal surfaced at rather than the daemon: what says the daemon refused is
    // the dotted code, which no synthesized refusal from this seam can spell.
    expect(settled).toStrictEqual({
      status: "unavailable",
      code: SCRIPTED_DAEMON_REFUSAL.code,
      detail: SCRIPTED_DAEMON_REFUSAL.message,
      origin: READ_SETTLEMENT_REFUSAL_ORIGIN,
    });
    engine.dispose();
  });

  it("negative control: the same seam without this helper rejects rather than settling", async () => {
    // Without this case the one above would pass over a seam that had been returning an
    // outcome all along, and the defect it fixes — an unhandled rejection leaving a
    // surface in `reading` forever — would be invisible.
    const engine = new ScenarioEngine({ scenario: scenarioRefusingTheEnumeration() });

    await expect(enumerationThroughTheSeam(engine)).rejects.toBe(SCRIPTED_DAEMON_REFUSAL);
    engine.dispose();
  });

  it("carries a refusal thrown inside a console refusal error verbatim", async () => {
    const raised = refuse(
      "workflow-authoring",
      "workflow.control_denied",
      "You are not admitted to read definitions at the shared scope on this node.",
    );

    const settled = await settleGrowthRead(Promise.reject(new ConsoleRefusalError(raised)));

    // The origin survives the relay, which is the whole reason it is on the shape.
    expect(settled).toStrictEqual({ ...raised, status: "unavailable" });
  });

  it("carries a bare thrown refusal verbatim too", async () => {
    const raised = refuse("persistence", "persistence.quota_exceeded", "The store is full.");

    const settled = await settleGrowthRead(Promise.reject(raised));

    expect(settled).toStrictEqual({ ...raised, status: "unavailable" });
  });

  it("names a rejection that carries no refusal, rather than swallowing it", async () => {
    const settled = await settleGrowthRead(Promise.reject(new Error("the bridge closed mid-read")));

    // The synthesized code is built from the origin, so a refusal this seam composed
    // reads as this seam's even where the thrown value said nothing machine-readable.
    expect(settled.code).toBe(`${READ_SETTLEMENT_REFUSAL_ORIGIN}-call-failed`);
    expect(settled.origin).toBe(READ_SETTLEMENT_REFUSAL_ORIGIN);
    // The thrown text is carried: a read that failed for a reason nobody can read is
    // indistinguishable from one that was never put.
    expect(settled.detail).toContain("the bridge closed mid-read");
  });

  it("recovers the dotted project code a JSON-RPC envelope carries beside its message", async () => {
    // The arm the family copy this replaced dropped on the floor. A daemon rejection
    // that arrives as a JSON-RPC error carries its project code at `data.type`, and a
    // reader that only knew the flat `{ code, message }` envelope synthesized a code
    // of its own over a refusal that had already named itself.
    const settled = await settleGrowthRead(
      Promise.reject({
        code: -32000,
        message: "No session with that id is open on this node.",
        data: { type: "workflow.session_not_found" },
      }),
    );

    expect(settled.code).toBe("workflow.session_not_found");
    expect(settled.detail).toBe("No session with that id is open on this node.");
  });

  it("renders a rejection whose own stringification throws, instead of throwing with it", async () => {
    // A read whose failure cannot be described must still settle. This is the arm the
    // shared stringifier exists for: a bare `String(...)` here rethrows inside the very
    // handler meant to absorb the first failure.
    const unrepresentable: object = Object.create(null) as object;

    const settled = await settleGrowthRead(Promise.reject(unrepresentable));

    expect(settled.code).toBe(`${READ_SETTLEMENT_REFUSAL_ORIGIN}-call-failed`);
    expect(settled.status).toBe("unavailable");
  });
});

/**
 * The projection, and the two endings that must stop it being built.
 *
 * `settleUnlessAbandoned` answers which of two events came FIRST, and it resolves the
 * instant the read does — retiring its abort listener as it goes. A departure landing
 * after that resolution and before this callback runs therefore finds nothing to
 * reach, and the captured settlement still reads `settled`: one microtask, which is
 * exactly the gap a fulfilment and a pane teardown scheduled in the same tick fall
 * into. The round is the reading that covers it.
 *
 * The projection callback is COUNTED rather than inferred from the rendered value:
 * what this hook exists to save is `settled` never running, and a value nobody
 * renders looks identical to one that was never composed.
 */
describe("useSettledGrowthRead — no projection is built for a surface that has left", () => {
  /** The port this hook addresses its state and its read line against. */
  const growthPort = createFixture().bridge.growth;

  /** What the cases below settle their read with. Narrow on purpose: nothing renders it. */
  type ProbeOutcome = { readonly status: "served"; readonly value: number };

  /** One read this suite settles when it chooses, and the act that settles it. */
  interface HeldRead {
    readonly promise: Promise<ProbeOutcome>;
    readonly serve: (outcome: ProbeOutcome) => void;
  }

  function heldRead(): HeldRead {
    let serve: (outcome: ProbeOutcome) => void = () => undefined;
    const promise = new Promise<ProbeOutcome>((resolve) => {
      serve = resolve;
    });
    return { promise, serve };
  }

  /** The hook under test, with every projection it builds recorded. */
  function renderProbe(
    read: HeldRead,
    projections: string[],
  ): RenderHookResult<SettledGrowthRead<string>, void> {
    return renderHook(() =>
      useSettledGrowthRead<ProbeOutcome, string>(growthPort, PROBE_SESSION_ID, () => read.promise, {
        unsettled: () => "unsettled",
        settled: (settlement) => {
          projections.push(settlement.status);
          return settlement.status;
        },
      }),
    );
  }

  it("skips the projection when the departure lands between the settlement and the callback", async () => {
    const read = heldRead();
    const projections: string[] = [];
    const { unmount } = renderProbe(read, projections);

    // Registered AFTER the hook's own handler on the same promise, so the settlement
    // wins the race and this lands one microtask behind it — the gap no signal check
    // placed earlier could have covered.
    void read.promise.then(() => {
      queueMicrotask(() => {
        unmount();
      });
    });
    await act(async () => {
      read.serve({ status: "served", value: 1 });
      await crossMacrotaskBoundary();
    });

    expect(projections).toStrictEqual([]);
  });

  it("negative control: the same read on a surface that stayed builds its projection", async () => {
    // Without this the case above would hold over a hook that projected nothing at
    // all, which is the same green for the opposite defect.
    const read = heldRead();
    const projections: string[] = [];
    const { result } = renderProbe(read, projections);

    await act(async () => {
      read.serve({ status: "served", value: 1 });
      await crossMacrotaskBoundary();
    });

    expect(projections).toStrictEqual(["served"]);
    expect(result.current.value).toBe("served");
  });
});
