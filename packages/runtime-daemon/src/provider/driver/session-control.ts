// The params of the driver operations that act on a whole session rather than one run: the live
// permission-level and mode moves, the commands the daemon answers itself, the side question and
// the review, the live command list, the move onto a new provider build, and the purge of the
// provider's own copy of its conversations.
import type { ProviderCommandListResult } from "@ai-sidekicks/contracts/provider/driver/commands";
import type {
  PermissionLevel,
  SessionMode,
  SessionReviewTarget,
  SideQuestionId,
} from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * Params of `updatePermissionLevel`: the level the session moves to, applied by the provider from
 * its next request without a relaunch.
 */
export interface UpdatePermissionLevelParams {
  sessionId: SessionId;
  level: PermissionLevel;
}

/** The provider build a driver's sessions move from and to, as each build printed its version. */
export interface ProviderBuildChange {
  fromVersion: string;
  toVersion: string;
}

/**
 * One provider conversation a session opened, by the handle it was resumed from, and the account
 * home it ran in; `providerAccountId` is absent for one that ran on the node's default home.
 */
interface PurgedConversation {
  resumeHandle: string;
  providerAccountId?: string | undefined;
}

/**
 * Params of `purgeSession`: every conversation the session's own bindings opened, newest first, so
 * a fork comes before the conversation it was forked from. A conversation the person started in a
 * terminal is never one of them.
 */
export interface PurgeSessionParams {
  sessionId: SessionId;
  conversations: readonly PurgedConversation[];
}

/** Params of `updateSessionMode`: Build or Plan, applied by the provider from the next turn. */
export interface UpdateSessionModeParams {
  sessionId: SessionId;
  mode: SessionMode;
}

/**
 * Params of `askSideQuestion`: a question asked on a throwaway copy of the conversation, leaving
 * the session's own conversation and permissions as they were. Its answer is appended as
 * `session.side_question_answered` under `sideQuestionId`.
 */
export interface AskSideQuestionParams {
  sessionId: SessionId;
  sideQuestionId: SideQuestionId;
  question: string;
}

/**
 * Params of `startReview`: the provider's own review of `target`, bracketed by the
 * `review_started` and `review_finished` notices.
 */
export interface StartReviewParams {
  sessionId: SessionId;
  target: SessionReviewTarget;
}

/** Params of `answerSessionCommand`: the text the person sent, before any run is made for it. */
export interface AnswerSessionCommandParams {
  sessionId: SessionId;
  text: string;
}

/**
 * What `answerSessionCommand` did with the text: `answered: false` when it goes to the provider as
 * typed; otherwise the daemon answered it for the session alone, with no run and no row, and `line`
 * is the one line shown beside the message box, or `null` for a `/config` key whose console control
 * the composer presses, which adds no line of its own.
 */
export type SessionCommandAnswer =
  | { readonly answered: false }
  | { readonly answered: true; readonly line: string | null };

/** Params of `subscribeProviderCommands`: the session whose live command list is followed. */
export interface SubscribeProviderCommandsParams {
  sessionId: SessionId;
}

/** Receives each new command list a session's provider and its tool servers offer. */
export type ProviderCommandsListener = (list: ProviderCommandListResult) => void;
