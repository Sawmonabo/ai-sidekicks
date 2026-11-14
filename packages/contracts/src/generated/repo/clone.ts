// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Cloning: project.clone.start makes a project from a repository URL, and its card follows the clone live.

import type { WslPlace } from "../place.js";
import type { ProjectId } from "../project.js";

/** The longest repository URL `project.clone.start` takes. */
export const PROJECT_CLONE_URL_MAX_LEN = 2048 as const;

/** The longest line of git's own words the clone card carries. */
export const PROJECT_CLONE_LINE_MAX_LEN = 1024 as const;

/** The longest answer to one of git's questions. */
export const PROJECT_CLONE_ANSWER_MAX_LEN = 4096 as const;

/** The code `project.clone.start` answers with when it refuses a clone before it starts. */
export const PROJECT_CLONE_REFUSED_CODE = "project.clone.refused" as const;

/**
 * The details of a `project.clone.refused` refusal: `destinationNotEmpty` when the destination
 * holds something, `noDirectoryName` when git can name no folder from the address, with git's
 * own line, which the clone card shows as it shows any clone's failure.
 */
export type ProjectCloneRefusedDetails =
  | {
      reason: "destinationNotEmpty";
    }
  | {
      reason: "noDirectoryName";
      /**
       * Git's own line.
       */
      line: string;
    };
/**
 * One question git is waiting on, minted when git's askpass program asks it.
 */
export type CloneQuestionId = string & { readonly __brand: "CloneQuestionId" };
/**
 * The step a failed clone failed at: `clone` or `largeFiles` with git's own line, or `sessions`
 * when the sessions that waited on the clone could not be started after it attached.
 */
export type ProjectCloneFailedStep = "clone" | "largeFiles" | "sessions";
/**
 * One `project.clone.subscribe` emission, the clone card's whole state. `largeFilesMissing` means
 * the clone finished but the repository keeps large files in Git LFS, which is not installed, so
 * they arrived as placeholders; `canceled` and `done` end the card.
 */
export type ProjectCloneStatus =
  | {
      state: "cloning";
      /**
       * The project.
       */
      projectId: ProjectId;
      /**
       * Git's latest progress, or `null`.
       */
      progress: ProjectCloneProgress | null;
      /**
       * The question git is waiting on, or `null`.
       */
      question: ProjectCloneQuestion | null;
    }
  | {
      state: "pullingLargeFiles";
      /**
       * The project.
       */
      projectId: ProjectId;
      /**
       * Git's latest progress, or `null`.
       */
      progress: ProjectCloneProgress | null;
      /**
       * The question git is waiting on, or `null`.
       */
      question: ProjectCloneQuestion | null;
    }
  | {
      state: "failed";
      /**
       * The project.
       */
      projectId: ProjectId;
      /**
       * The step.
       */
      step: ProjectCloneFailedStep;
      /**
       * Its last error line; `null` only when the service restarted during the clone and git
       * left none.
       */
      failureLine: string | null;
    }
  | {
      state: "largeFilesMissing";
      /**
       * The project.
       */
      projectId: ProjectId;
    }
  | {
      state: "canceled";
      /**
       * The project.
       */
      projectId: ProjectId;
    }
  | {
      state: "done";
      /**
       * The project.
       */
      projectId: ProjectId;
    };
/**
 * The answer to one of git's questions: one line with no NUL, possibly empty (an empty
 * passphrase), since git's askpass program prints it as one line and a break would cut it
 * short or smuggle a second.
 */
export type AskpassAnswer = string;
/**
 * Why a clone goes where it does.
 */
export type ProjectCloneFolderSource = "setting" | "lastProject" | "home";

/**
 * `project.clone.start`: the repository's URL, the folder the clone goes into when it is not the
 * machine's clone folder, and the project whose failed or canceled clone this runs again. The
 * reply names the project, made at once and marked `cloning`; the clone ends in the ordinary
 * attach.
 */
export interface ProjectCloneStartRequest {
  /**
   * The repository's URL, handed to git as typed.
   */
  url: string;
  /**
   * The folder the clone goes into.
   */
  parentFolder?: string;
  /**
   * The distribution the folder is in, given in Linux form; absent wherever the folder's own
   * form says.
   */
  place?: WslPlace;
  /**
   * The project whose clone runs again.
   */
  projectId?: ProjectId;
  /**
   * The key that makes a repeated start one clone, answering the first clone's project.
   */
  clientIdempotencyKey: string;
}
/**
 * The `project.clone.start` result: the project the clone fills.
 */
export interface ProjectCloneStartResponse {
  /**
   * The project.
   */
  projectId: ProjectId;
}
/**
 * `project.clone.subscribe`, `project.clone.cancel` and `project.largeFile.pull`: the project a
 * clone-card request is about.
 */
export interface ProjectCloneRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
}
/**
 * Git's progress in its own words, `Receiving objects` at 42 percent.
 */
export interface ProjectCloneProgress {
  /**
   * The phase, in git's words.
   */
  phase: string;
  /**
   * The whole percent git printed, or `null`.
   */
  percent: number | null;
}
/**
 * A question git asked (a user name, a password or token, a key's passphrase, or whether to trust
 * a host's key), in git's own words. `masked` is true for a password or a passphrase.
 */
export interface ProjectCloneQuestion {
  /**
   * The question.
   */
  questionId: CloneQuestionId;
  /**
   * Git's words.
   */
  prompt: string;
  /**
   * Whether the answer is hidden as it is typed.
   */
  masked: boolean;
}
/**
 * `project.clone.answer`: the answer to one of git's questions. The daemon hands it to git's
 * askpass program and nowhere else; it is never stored, logged or echoed, and a transport that
 * logs request bodies must redact `answer`.
 */
export interface ProjectCloneAnswerRequest {
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * The question.
   */
  questionId: CloneQuestionId;
  /**
   * The answer.
   */
  answer: AskpassAnswer;
}
/**
 * Where a clone goes, and why: the folder the person set, else the folder holding the most
 * recently attached project, else the home folder. The session picker and Settings › Projects
 * both read this one answer.
 */
export interface ProjectCloneFolderReadResponse {
  /**
   * The folder.
   */
  folder: string;
  /**
   * The distribution the folder is in, in Linux form; absent elsewhere.
   */
  place?: WslPlace;
  /**
   * Why.
   */
  source: ProjectCloneFolderSource;
}
