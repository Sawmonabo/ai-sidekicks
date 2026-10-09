// The session controls Codex carries on the conversation itself: Build or Plan as its
// collaboration mode, its own review of a set of changes, and `Allow once` on a block its reviewer
// made at Reviewed. A review, and an `Allow once` sent while no turn runs, start a turn, so each is
// started as the session's own run.

import type {
  SessionMode,
  SessionReviewTarget,
} from "@ai-sidekicks/contracts/session/controls/methods";

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { CodexDeliveryDispatch } from "../delivery/dispatch.js";
import { CODEX_THREAD_SETTINGS_UPDATED_METHOD } from "../event-normalizer.js";
import type { CodexRunStart } from "../run/start.js";
import { readTurnId } from "../thread/view.js";
import { type CodexSessionRecord, isTurnInFlight } from "./state.js";

// What each review target asks Codex for. Codex names no staged set and the daemon holds no base
// branch for the session, so both are asked in words with the git command that reads them.
const CODEX_REVIEW_TARGETS: Readonly<Record<SessionReviewTarget, Record<string, string>>> = {
  workingTree: { type: "uncommittedChanges" },
  staged: {
    type: "custom",
    instructions: "Review the changes staged for commit, as `git diff --cached` shows them.",
  },
  branch: {
    type: "custom",
    instructions:
      "Review the commits on the current branch that its upstream does not have, as " +
      "`git diff @{upstream}...HEAD` shows them.",
  },
};

/**
 * Moves the conversation between Build and Plan from its next turn, as Codex's own collaboration
 * mode on the session's model and effort, with the mode's built-in instructions; the level and its
 * profile stay as they are. Throws the request's failure.
 */
export async function updateCodexSessionMode(
  record: Pick<CodexSessionRecord, "service" | "threadId" | "threadSettings" | "reasoningEffort">,
  mode: SessionMode,
): Promise<void> {
  await record.service.request("thread/settings/update", {
    threadId: record.threadId,
    collaborationMode: composeCodexCollaborationMode(
      mode,
      record.threadSettings.model,
      record.reasoningEffort,
    ),
  });
}

/**
 * Codex's collaboration mode for Build or Plan on `model` at `reasoningEffort`, with the mode's
 * built-in instructions. It takes precedence over a request's own model and effort, so both are
 * carried, and an effort left out would reset the conversation's.
 */
export function composeCodexCollaborationMode(
  mode: SessionMode,
  model: string,
  reasoningEffort: string | null,
): Record<string, unknown> {
  return {
    mode: mode === "plan" ? "plan" : "default",
    settings: { model, reasoning_effort: reasoningEffort, developer_instructions: null },
  };
}

/** Keeps the effort `thread/settings/updated` reports for the session's own conversation. */
export function observeCodexReasoningEffort(
  record: CodexSessionRecord,
  method: string,
  params: unknown,
): void {
  const payload = isPlainObject(params) ? params : {};
  const settings = payload["threadSettings"];
  if (
    method !== CODEX_THREAD_SETTINGS_UPDATED_METHOD ||
    payload["threadId"] !== record.threadId ||
    !isPlainObject(settings)
  ) {
    return;
  }
  const effort = settings["effort"];
  record.reasoningEffort = typeof effort === "string" && effort.length > 0 ? effort : null;
}

/**
 * Starts Codex's own review of `target` in the session's conversation as the session's own run and
 * records its start; the review's end is recorded when Codex leaves review mode. Throws as the
 * run's start throws.
 */
export async function startCodexReview(
  record: CodexSessionRecord,
  target: SessionReviewTarget,
  dispatch: CodexDeliveryDispatch,
  runStart: Pick<CodexRunStart, "startDaemonTurn">,
): Promise<void> {
  await runStart.startDaemonTurn(record, async (current) => {
    const reply = await current.service.request("review/start", {
      threadId: current.threadId,
      target: CODEX_REVIEW_TARGETS[target],
    });
    dispatch.sendNotice({ sessionId: current.sessionId, kind: "review_started", target }, null);
    return readTurnId(reply, "review/start");
  });
}

/**
 * Sends `Allow once` for a block Codex's reviewer made, with the review Codex sent as the block,
 * on the conversation it was made in: into the turn running there, or, on the session's own
 * conversation with no turn running, as the session's own run, since Codex then starts a turn for
 * it. Throws the request's failure, and as the run's start throws.
 */
export async function overrideCodexReviewerDenial(
  record: CodexSessionRecord,
  providerDenial: unknown,
  runStart: Pick<CodexRunStart, "startDaemonTurn">,
): Promise<void> {
  const denial = isPlainObject(providerDenial) ? providerDenial : {};
  const threadId = readNonEmptyString(denial, "threadId") ?? record.threadId;
  const approve = async (current: CodexSessionRecord): Promise<undefined> => {
    await current.service.request("thread/approveGuardianDeniedAction", {
      threadId,
      event: providerDenial,
    });
    return undefined;
  };
  if (threadId !== record.threadId || isTurnInFlight(record)) {
    await approve(record);
    return;
  }
  await runStart.startDaemonTurn(record, approve);
}
