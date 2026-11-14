// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A session's notices and flow rows: the rows its controls write, the notices about its provider and about the WSL 2 distribution it runs in, the flag from a provider's own reviewer, and the live frame of a provider's safety hold on a turn.

import type { AgentId } from "../../agent/definition.js";
import type { DistroName, Place } from "../../place.js";
import type { ProviderId } from "../../provider/id.js";
import type { RunId } from "../../run/id.js";
import type { ProviderTurnId } from "../../turn.js";
import type { TokensPerRun, UsdMicros } from "../cost.js";
import type { SessionId } from "../id.js";
import type {
  PermissionLevel,
  SessionMode,
  SessionReviewTarget,
  SideQuestionId,
  SideQuestionText,
} from "./methods.js";

/**
 * Which kind of notice a provider warning came from: a warning, a deprecation notice, or the
 * provider's refusal to continue the session's conversation.
 */
export type ProviderWarningSource = "warning" | "deprecation" | "refusal";
/**
 * The `session.notice.posted` payload. Its kinds are a closed set, each drawn as one plain
 * sentence; `settingsIgnored` takes one shape per kind of report: a file and a line, or a file and
 * a key, each where known.
 */
export type SessionNoticePostedPayload =
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Always `settingsIgnored`.
       */
      kind: "settingsIgnored";
      /**
       * The provider whose settings were ignored.
       */
      provider: ProviderId;
      /**
       * The settings file.
       */
      file: string;
      /**
       * The line in it.
       */
      line: number;
      /**
       * Never present: a report naming a line names no key.
       */
      key?: never;
      /**
       * The provider's own words for what it ignored, quoted from its report, where it gave any.
       */
      text?: string;
    }
  | {
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Always `settingsIgnored`.
       */
      kind: "settingsIgnored";
      /**
       * The provider whose settings were ignored.
       */
      provider: ProviderId;
      /**
       * The settings file, where one is known.
       */
      file?: string;
      /**
       * The key with the bad value, where one is known.
       */
      key?: string;
      /**
       * Never present: a report naming a key names no line.
       */
      line?: never;
      /**
       * The provider's own words for what it ignored, quoted from its report, where it gave any.
       */
      text?: string;
    }
  | (
      | {
          kind: "conversationReloaded";
          /**
           * The session.
           */
          sessionId: SessionId;
        }
      | {
          kind: "reviewStarted";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * What the review covers.
           */
          target: SessionReviewTarget;
        }
      | {
          kind: "reviewFinished";
          /**
           * The session.
           */
          sessionId: SessionId;
        }
      | {
          kind: "goalNotMet";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The agent whose goal it is.
           */
          agentId: AgentId;
        }
      | {
          kind: "goalCheckUnfinished";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The agent whose goal it is.
           */
          agentId: AgentId;
        }
      | {
          kind: "providerWarning";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * Which kind of notice it came from.
           */
          source: ProviderWarningSource;
          /**
           * The provider's words.
           */
          text: string;
          /**
           * The provider's details, where it sent any.
           */
          details?: string;
        }
      | {
          kind: "levelUnavailable";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The level that cannot run.
           */
          level: PermissionLevel;
        }
      | {
          kind: "levelMoved";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The level it runs at.
           */
          level: PermissionLevel;
          /**
           * Whether its next turns plan or build.
           */
          sessionMode: SessionMode;
        }
      | {
          kind: "providerUpdated";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The provider.
           */
          provider: ProviderId;
          /**
           * The version it left.
           */
          fromVersion: string;
          /**
           * The version it runs.
           */
          toVersion: string;
        }
      | {
          kind: "providerRestarted";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The provider.
           */
          provider: ProviderId;
        }
      | ((
          | {
              exitCode: unknown;
            }
          | {
              signal: unknown;
            }
          | {
              silentSeconds: unknown;
            }
          | {
              startFailure: unknown;
            }
        ) & {
          kind: "providerCrashLoop";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The provider.
           */
          provider: ProviderId;
          /**
           * The exit code it ended with, where it ended with one.
           */
          exitCode?: number;
          /**
           * The signal it ended on, where it ended on one.
           */
          signal?: string;
          /**
           * How long it answered nothing before the daemon ended it, in seconds, where that ended
           * it.
           */
          silentSeconds?: number;
          /**
           * The failure its last restart gave, word for word, where no ending was read.
           */
          startFailure?: string;
        })
      | {
          kind: "fastOutputUnavailable";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The run that asked for fast output.
           */
          runId: RunId;
          /**
           * The provider's reason, where it sent one.
           */
          reason?: string;
        }
      | {
          kind: "providerMissing";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The provider.
           */
          provider: ProviderId;
          /**
           * Where the session runs.
           */
          place?: Place;
        }
      | {
          kind: "distributionRemoved";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The distribution.
           */
          distro: DistroName;
        }
      | {
          kind: "wslNotAnswering";
          /**
           * The session.
           */
          sessionId: SessionId;
        }
      | {
          kind: "distributionRestartFailed";
          /**
           * The session.
           */
          sessionId: SessionId;
          /**
           * The distribution.
           */
          distro: DistroName;
          /**
           * The error the last start gave; absent where it printed nothing before its deadline.
           */
          error?: string;
        }
    );
/**
 * Which of a provider's reviewer signals a flag carries.
 */
export type ModerationReviewSignal = "reviewWarning" | "reviewRequired";

/**
 * The `session.sideQuestion.answered` payload: the person's question and the provider's answer,
 * each as written. The aside never enters the conversation.
 */
export interface SessionSideQuestionAnsweredPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The side question.
   */
  sideQuestionId: SideQuestionId;
  /**
   * The question, as written.
   */
  question: SideQuestionText;
  /**
   * The provider's answer, as written.
   */
  answer: string;
}
/**
 * The `agent.run.stepLimit.reached` payload: a turn reached the step bound and ended there, and
 * the run then ends as interrupted. `count` is the bound reached, drawn beside `Continue`.
 */
export interface AgentRunStepLimitReachedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The bound reached.
   */
  count: number;
}
/**
 * The `session.spendLimit.reached` payload: the session's spend passed its `Spend limit`, so
 * every running turn in it stopped. `spendLimitUsdMicros` is the limit, drawn beside `Raise
 * limit`.
 */
export interface SessionSpendLimitReachedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The limit passed.
   */
  spendLimitUsdMicros: UsdMicros;
}
/**
 * The `agent.run.tokenLimit.reached` payload: the run passed its `Tokens per run` and ended, and
 * the next message starts a new run. `tokenLimit` is the limit, drawn beside `Raise limit`.
 */
export interface AgentRunTokenLimitReachedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The limit passed.
   */
  tokenLimit: TokensPerRun;
}
/**
 * A provider's safety hold on a turn (`active`) or its release, with the faster model the
 * provider names, as sent. Relayed live on the run's state stream and never kept, so a re-opened
 * session does not show it again.
 */
export interface RunSafetyBufferingUpdatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The provider's turn id.
   */
  turnId: ProviderTurnId;
  /**
   * Whether the hold is on.
   */
  active: boolean;
  /**
   * The faster model the provider names, where it names one.
   */
  fasterModel?: string;
}
/**
 * The `approval.reviewer.flagged` payload: a warning or a required review from the provider's own
 * reviewer, drawn as one row in the provider's words. `eventId` names the item the flag is about;
 * `text` is the words the row shows.
 */
export interface ApprovalReviewerFlaggedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * The item the flag is about.
   */
  eventId: string;
  /**
   * Which signal it carries.
   */
  signal: ModerationReviewSignal;
  /**
   * The words the row shows.
   */
  text: string;
}

export {
  validateAgentRunStepLimitReachedPayload,
  validateAgentRunTokenLimitReachedPayload,
  validateApprovalReviewerFlaggedPayload,
  validateModerationReviewSignal,
  validateProviderWarningSource,
  validateSessionNoticePostedPayload,
  validateSessionSideQuestionAnsweredPayload,
  validateSessionSpendLimitReachedPayload,
} from "../../checks/session/controls/events.js";
