// The approvals pane's shared scaffolding: one pane, two reads, and a queue that
// grows.
//
// Both suites mount the SAME pane over the approvals scenario. The scripted reads
// are here because a shipped scenario cannot answer differently between two calls,
// and a card ARRIVING while older ones are on screen is only reachable against a
// stub whose answer changes — which is a fixture both suites need and neither owns.

import { act, render, screen } from "@testing-library/react";
import { ApprovalsPane } from "./ApprovalsPane.js";
import { ManualClock, REFRESH_DEBOUNCE_MS } from "../../core/index.js";
import {
  createFixtureBridge,
  type ApprovalRecord,
  type ConsoleBridge,
  type ParsedRows,
} from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port.js";
import { APPROVALS_SCENARIO } from "../../bridge/scenarios/approvals.js";
import { DraftStore, MemoryPersistenceAdapter, UiStateStore } from "../../persistence/index.js";
import { FrameStore, SessionStore } from "../../store/index.js";
import { type ConsoleScenario } from "../../bridge/scenario.js";
import { type PaneContextOf } from "../pane-chrome.js";

export function paneContext(
  bridge: ConsoleBridge,
  sessionStore: SessionStore | undefined,
): PaneContextOf<"approvals"> {
  return {
    // No `entity` member: the approvals pane is session-scoped, and its arm of the
    // address union carries none.
    kind: "approvals",
    paneId: "pane-approvals",
    linkedSourcePaneId: undefined,
    bridge,
    frameStore: new FrameStore(),
    sessionStore,
    uiStateStore: new UiStateStore({ adapter: new MemoryPersistenceAdapter() }),
    draftStore: new DraftStore(),
    focusHue: undefined,
  };
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

/** Let every settled promise and effect land. */
export async function flush(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Fire the reader's trailing debounce on the fixture's frozen clock, then settle. */
export async function settle(bridge: ConsoleBridge): Promise<void> {
  await act(async () => {
    bridge.scenarioEngine?.advance(REFRESH_DEBOUNCE_MS);
  });
  await flush();
}

export async function mountPane(
  scenario: ConsoleScenario = APPROVALS_SCENARIO,
): Promise<ConsoleBridge> {
  const bridge = createFixtureBridge({ scenario });
  const context = paneContext(bridge, boundStore(scenario));
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
 * failing on `undefined`.
 */
export function stubApprovalsBridge(reads: ApprovalProjectionSource): ConsoleBridge {
  const clock = new ManualClock();
  return {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => undefined,
        subscribe: () => () => undefined,
      },
    },
    growth: {
      ...createRefusingGrowthPort(),
      approvalProjectionRead: async () => ({ status: "served", value: reads.reply() }),
      approvalRuleList: async () => ({
        status: "served",
        value: { rows: [], unreadableCount: 0 },
      }),
    },
    source: "fixture",
    // Shaped so the frozen-clock helper above drives this stub unchanged: the reader
    // resolves its clock off the scenario engine, and the tier has exactly one way
    // to move time.
    scenarioEngine: { clock, advance: (deltaMs: number) => clock.advance(deltaMs) },
  } as unknown as ConsoleBridge;
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
