// Codex's corrected approvals, held by the hand-off for the turn they were made in: Codex's next
// ask in that turn for exactly the corrected command names the card it was approved on, and once
// the turn ends its corrections are dropped, so the hand-off keeps none past the turn.

import { describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { HOST_OPERATING_SYSTEM } from "../../../../../tests/helpers/host-operating-system.js";
import type { ProviderPermissionAsk } from "../../../port/permission-ask.js";
import { PortRegistration } from "../../../port/registration.js";
import { CodexAskHandOff } from "../delivery/asks.js";
import type { CodexDeliveryDispatch } from "../delivery/dispatch.js";
import type { CodexService } from "../service/supervisor.js";
import type { CodexSessionRecord } from "../session/state.js";

const SESSION_ID = "00000000-0000-7000-8000-000000000001" as SessionId;
const RUN_ID = "00000000-0000-7000-8000-0000000000b1" as RunId;
const OWNER = { runId: RUN_ID, bindingId: "binding-1" };

function buildHandOff(): { handOff: CodexAskHandOff; taken: ProviderPermissionAsk[] } {
  const taken: ProviderPermissionAsk[] = [];
  const permissionAsks = new PortRegistration<{
    takeAsk: (ask: ProviderPermissionAsk) => Promise<void>;
    withdrawAsk: () => Promise<void>;
  }>("permission-ask");
  permissionAsks.register({
    takeAsk: (ask) => {
      taken.push(ask);
      return Promise.resolve();
    },
    withdrawAsk: () => Promise.resolve(),
  });
  const handOff = new CodexAskHandOff({
    dispatch: {
      send: () => Promise.resolve({ disposition: "ask_admitted" }),
    } as unknown as CodexDeliveryDispatch,
    owners: { permissionAsks, questions: new PortRegistration("question") },
    reportDiagnostic: () => undefined,
    recordFor: () => undefined,
    readGitFolder: () => Promise.reject(new Error("no project rule is written here")),
    diskFlush: HOST_OPERATING_SYSTEM.diskFlush,
  });
  return { handOff, taken };
}

// A session whose turns have all ended, so a correction's steer finds no turn to go into.
const ENDED_SESSION = {
  sessionId: SESSION_ID,
  runIdByActiveTurnId: new Map(),
  interruptingTurnIds: new Set(),
} as unknown as CodexSessionRecord;
const SERVICE = { answerHeldRequest: () => Promise.resolve() } as unknown as CodexService;

async function askCommand(
  handOff: CodexAskHandOff,
  requestId: string,
  turnId: string,
  command: string,
): Promise<void> {
  const decision = await handOff.hold(SESSION_ID, OWNER, {
    requestId,
    method: "item/commandExecution/requestApproval",
    askKind: "approval",
    params: { threadId: "thread-1", turnId, itemId: `item-${requestId}`, command },
  });
  // The connection now holds the ask, and the approval goes to its owner.
  if (decision.decision === "held") {
    decision.onHeld?.();
  }
}

async function correctTo(
  handOff: CodexAskHandOff,
  requestId: string,
  editedAction: string,
): Promise<void> {
  await handOff.answer(ENDED_SESSION, SERVICE, {
    runId: RUN_ID,
    requestId,
    response: {
      decision: "allow",
      correction: { editedAction, approvalRequestId: `card-${requestId}` },
    },
  });
}

describe("CodexAskHandOff corrections", () => {
  it("names the card in its own turn, and keeps none once that turn ends", async () => {
    const { handOff, taken } = buildHandOff();

    await askCommand(handOff, "1", "turn-1", "rm -rf build");
    await correctTo(handOff, "1", "npm test");
    await askCommand(handOff, "2", "turn-1", "npm test");

    await askCommand(handOff, "3", "turn-2", "rm -rf build");
    await correctTo(handOff, "3", "npm test");
    handOff.forgetTurnCorrections(SESSION_ID, "turn-2");
    await askCommand(handOff, "4", "turn-2", "npm test");

    expect(taken.map((ask) => [ask.requestId, ask.correctionOf])).toStrictEqual([
      ["1", undefined],
      ["2", "card-1"],
      ["3", undefined],
      ["4", undefined],
    ]);
  });
});
