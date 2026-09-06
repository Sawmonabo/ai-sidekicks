// The approvals pane's shared scaffolding: one pane, two reads, and a queue that
// grows.
//
// Both suites mount the SAME pane over the approvals scenario. The scripted reads
// are here because a shipped scenario cannot answer differently between two calls,
// and a card ARRIVING while older ones are on screen is only reachable against a
// stub whose answer changes — which is a fixture both suites need and neither owns.

import { act, render, screen } from "@testing-library/react";
import { ApprovalsPane } from "./ApprovalsPane.js";
import { REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import {
  createFixtureBridge,
  type ApprovalRecord,
  type ConsoleBridge,
  type ParsedRows,
} from "../../bridge/index.js";
import { drainMicrotasks } from "../../bridge/fixture/fixture-bridge.test-support.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { APPROVALS_SCENARIO } from "../../bridge/scenarios/approvals.js";
import { SessionStore } from "../../store/index.js";
import { type ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { type PaneContextOf } from "../../seats/index.js";
import { paneContext } from "../../seats/pane-context.test-support.js";

/**
 * The approvals pane's context, over the shared builder.
 *
 * A one-line wrapper rather than four spellings of the same address: the pane is
 * session-scoped, so its arm of the address union carries no `entity` member, and
 * naming that once here keeps every approvals suite mounting the same pane.
 */
export function approvalsPaneContext(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
): PaneContextOf<"approvals"> {
  return paneContext({ kind: "approvals" }, { bridge, sessionStore });
}
/**
 * A store bound to a session, carrying the scenario's own roster.
 *
 * The roster is seeded because the caller's ROLE is a lookup in it: the fixture
 * answers which participant this window is, and the role that identity resolves to
 * lives in the session's participant partition. A store with an empty roster would
 * make every role-gated control render closed for a reason nothing checked, which is
 * exactly the state the goal controls used to be pinned in.
 */
export function boundStore(
  scenario: ConsoleScenario | undefined = APPROVALS_SCENARIO,
): SessionStore {
  const store = new SessionStore({ sessionId: scenario?.sessionId ?? "session-approvals" });
  const rolesByParticipantId = scenario?.membershipRoleByParticipantId ?? {};
  store.initialise({
    cursor: 0,
    entities: Object.entries(rolesByParticipantId).map(([participantId, role]) => ({
      kind: "participant",
      id: participantId,
      body: { role },
    })),
    participantJoinLog: Object.keys(rolesByParticipantId),
  });
  return store;
}

/**
 * Fire the reader's trailing debounce on the fixture's frozen clock, then settle.
 *
 * The settling is the bridge family's own `drainMicrotasks` and never a counted
 * number of passes. What stood here ran four `await Promise.resolve()` rounds, which
 * is a number tuned against the chain it happened to be written over: a reply that
 * grew one link deeper would stop being waited for, and the case would report the
 * absence of an answer that was merely still in flight.
 */
export async function settle(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(REFRESH_DEBOUNCE_MS);
  });
  await act(async () => {
    await drainMicrotasks();
  });
}

export async function mountPane(
  scenario: ConsoleScenario = APPROVALS_SCENARIO,
): Promise<ConsoleBridge> {
  const bridge = createFixtureBridge({ scenario });
  const context = approvalsPaneContext(bridge, boundStore(scenario));
  await act(async () => {
    render(<ApprovalsPane {...context} />);
  });
  return bridge;
}

export function section(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

// A queue that GROWS, which the shipped scenarios cannot do: a scripted reply is
// looked up per call and answers the same rows every time, so the case that matters
// here — a card arriving while older ones are already on screen — is only reachable
// against a stub whose answer changes between reads.
export class ScriptedApprovalReads {
  #admitsThird = false;

  /** Let the next read carry the arriving record. */
  public admitThird(): void {
    this.#admitsThird = true;
  }

  public reply(): ParsedRows<ApprovalRecord> {
    const shown = this.#admitsThird ? WAITING_APPROVAL_IDS : WAITING_APPROVAL_IDS.slice(0, 2);
    return { rows: shown.map(waitingRecord), unreadableCount: 0 };
  }
}

export const WAITING_APPROVAL_IDS = [
  "019b7a33-3300-7f01-8210-d1a4c1150601",
  "019b7a33-3300-7f01-8220-d1a4c1150602",
  "019b7a33-3300-7f01-8230-d1a4c1150603",
] as const;

/**
 * One waiting record, in the shape the CONSOLE holds — `approvalRequestId` and
 * `requestedScope`, not the reply's `id` and `scope`.
 *
 * The read's own narrowing performs that rename, and it is deliberate: the resolve
 * REQUEST names the same value `approvalRequestId`, and `scope` on the reply is what
 * was asked for rather than what was granted. A case constructing the wire spelling
 * here would be standing in for a read that had not run.
 */
export function waitingRecord(id: string): ApprovalRecord {
  return {
    approvalRequestId: id,
    runId: "019b7a33-3300-740e-8110-d1a4c1150511",
    requestedBy: "019b7a33-3300-7a6e-8110-d1a4c1150501",
    category: "file_write",
    requestedScope: "run",
    resourceDescriptor: { path: "packages/contracts/src/approval.ts" },
    state: "pending",
    createdAt: "2026-01-01T13:30:00.900Z",
    updatedAt: "2026-01-01T13:30:00.900Z",
  };
}

/**
 * Anything the stub port can answer the projection read with.
 *
 * The console's OWN reading of that read — rows it could decode, beside a count of
 * the ones it could not — rather than a wire-shaped reply, because that is what the
 * growth port answers with and because the claim under test is what the PANE renders
 * for a partial read. A case that handed in raw rows would be re-deciding which of
 * them are readable, which is `approval-records.test.ts`'s subject and not this
 * file's.
 */
export interface ApprovalProjectionSource {
  readonly reply: () => ParsedRows<ApprovalRecord>;
}

/**
 * A bridge whose approvals reads answer from this suite rather than from a scenario.
 *
 * The growth port is spread over the refusing one, which is the console's shape for
 * standing in for a single operation: an arm this suite does not name refuses by name
 * instead of being absent, so a pane reaching for one renders a refusal rather than
 * failing on `undefined`. The port is spread over the SHIPPED FIXTURE for the same
 * reason one layer up — what stood here was an object cast to `ConsoleBridge`, so
 * this file also decided what the daemon arm answered and had to carry a hand-made
 * scenario engine to give the reader a clock. Only the two arms this suite scripts
 * are replaced now, and the frozen clock is the fixture's own.
 */
export function stubApprovalsBridge(reads: ApprovalProjectionSource): ConsoleBridge {
  return {
    ...createFixtureBridge({ scenario: APPROVALS_SCENARIO }),
    growth: {
      ...createRefusingGrowthPort(),
      approvalProjectionRead: async () => ({ status: "served", value: reads.reply() }),
      approvalRuleList: async () => ({
        status: "served",
        value: { rows: [], unreadableCount: 0 },
      }),
    },
  };
}

/** A composer holding focus, which is the precondition the focus rule is gated on. */
export function composerHoldingFocus(): HTMLElement {
  const composer = document.createElement("div");
  composer.className = "meridian-composer";
  const field = document.createElement("button");
  composer.append(field);
  document.body.append(composer);
  field.focus();
  return composer;
}
