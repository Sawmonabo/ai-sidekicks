// Cloning a project from a repository's address. `clone` makes the project's record at once,
// marked `cloning`, then runs `git clone` in the background into the clone folder; the clone ends
// in the ordinary attach. Each project being cloned has a card the person follows: git's progress,
// the question git waits on, a failure in git's words, and the end. The card hears at most four
// updates a second, the latest winning. Git's questions come through the askpass program and their
// answers go back to it alone; no answer is kept. Git clones into a folder the daemon makes beside
// the destination, renamed into place once the clone finishes; that folder is the only one a
// failure, a cancel or a restart ever removes. A clone recorded running when the service stopped
// is found at the next start, its folder removed and it marked interrupted, which the card's own
// words tell; a canceled or failed clone is never touched again.

import * as path from "node:path";

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import {
  REPO_CLONE_LINE_MAX_LEN,
  type CloneQuestionId,
  type RepoCloneFolderReadResponse,
  type RepoCloneProgress,
  type RepoCloneRequest,
  type RepoCloneResponse,
  type RepoCloneStatus,
} from "@ai-sidekicks/contracts/repo/clone";

import { mapWithProcessorBound } from "../../processor-bound.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { describeRejection } from "../../rejection.js";
import { readGitExitStatus, type GitCommand } from "../../git/process.js";
import { KeyedLock } from "../../keyed-lock.js";
import type { ProjectRecords } from "../project/records.js";
import type { CloneEnd, ProjectService } from "../project/service.js";
import {
  ProjectNotFoundError,
  RepoCloneRefusedError,
  RepoFolderUnreachableError,
  RepoRootResolutionError,
} from "../repo/errors.js";
import { canonicalFolderPath } from "../folder/canonical-path.js";
import type { FolderPlace } from "../folder/place.js";
import { CloneOutcome } from "../schema.js";
import type { AskpassBroker, AskpassQuestion } from "./askpass/broker.js";
import {
  makeStagedClone,
  moveStagedCloneIntoPlace,
  readDestinationState,
  removeStagedClone,
  repositoryKeyOf,
  repositoryNameOf,
  type StagedClone,
} from "./destination.js";
import {
  isLargeFilesInstalled,
  keepsLargeFiles,
  LARGE_FILES_CLONE_OPTIONS,
} from "./large-files.js";
import { GitProgressReader, LatestUpdateGate } from "./progress.js";
import {
  CANCEL_STOP_GRACE_MS,
  SHUTDOWN_STOP_GRACE_MS,
  type StreamedGitExit,
  type StreamedGitRunner,
} from "./streamed-git.js";

// One key for every clone start, so two clones never take one destination.
const CLONE_START_LOCK_KEY = "clone-start";

// `git config --get`'s exit status when the key is not set.
const GIT_CONFIG_KEY_MISSING_EXIT_STATUS = 1;

// The card's line when the folder filled between the start's look and git's run.
const DESTINATION_FILLED_LINE = "The folder to clone into is no longer empty";

// Git's own line for an address it can name no folder from, which the refusal carries.
const NO_DIRECTORY_NAME_LINE = "fatal: No directory name could be guessed.";

/** Hears every update of one project's clone card. It must not throw. */
export type CloneStatusListener = (status: RepoCloneStatus) => void;

/** A clone card as it stands when a listener opens it, and the detach that closes it. */
export interface CloneSubscription {
  readonly status: RepoCloneStatus;
  readonly detach: () => void;
}

/** What the clone service reads, writes and runs. */
export interface CloneServiceDeps {
  /** The project writer that keeps the clone's record and attaches the finished clone. */
  readonly projects: Pick<
    ProjectService,
    | "createCloningProject"
    | "retargetClone"
    | "recordCloneStaged"
    | "recordCloneEnd"
    | "attachClonedProject"
  >;
  /** The project reads, shared with the project writer. */
  readonly records: Pick<
    ProjectRecords,
    "readRow" | "readAttachedProjectFolders" | "readRunningClones"
  >;
  /** Carries git's questions to the card and the answers back. */
  readonly askpass: Pick<AskpassBroker, "register">;
  /** The folder the person set for new clones, or `null` when none is set. */
  readonly readCloneFolderSetting: () => Promise<string | null>;
  /** The home folder of the account the service runs as, the last place a clone goes. */
  readonly homeDirectory: string;
  /** Where a folder sits on a Windows computer with WSL. */
  readonly folderPlace: Pick<FolderPlace, "isInAnotherDistribution">;
  /**
   * Called once a clone is attached, to finish the sessions made while it ran; a rejection puts
   * the card at `failed` with step `sessions`.
   */
  readonly onCloneAttached: (projectId: ProjectId) => Promise<void>;
  /** Where a clone or pull that failed by a throw is written. */
  readonly writeServiceLog: ServiceLogWriter;
  /** The daemon's git entry point, for the short git questions. */
  readonly git: GitCommand;
  /** The `git` the daemon found, run streamed for each clone and pull. */
  readonly streamedGit: StreamedGitRunner;
}

// The steps a failed card can name; `sessions` runs no git, so no activity follows it.
type CloneFailedStep = Extract<RepoCloneStatus, { state: "failed" }>["step"];

// The git run a card follows: a clone, or a large-files pull after one.
interface CloneActivity {
  readonly step: Exclude<CloneFailedStep, "sessions">;
  readonly stop: AbortController;
  readonly questions: PendingQuestion[];
  progress: RepoCloneProgress | null;
  isCanceled: boolean;
  // Settles once the run has ended and its last status is set.
  ended: Promise<void>;
}

// A question git waits on, with the settle of the askpass run asking it.
interface PendingQuestion {
  readonly questionId: CloneQuestionId;
  readonly prompt: string;
  readonly isMasked: boolean;
  readonly answer: (answer: string) => void;
}

// One project's card: its listeners, the status they last heard of, and the run it follows.
interface CloneCard {
  status: RepoCloneStatus;
  readonly listeners: Set<CloneStatusListener>;
  readonly gate: LatestUpdateGate<RepoCloneStatus>;
  activity: CloneActivity | null;
  // The clone's destination, while a clone runs.
  destination: string | null;
}

/** Clones repositories into projects and keeps each clone's card. */
export class CloneService {
  readonly #projects: CloneServiceDeps["projects"];
  readonly #records: CloneServiceDeps["records"];
  readonly #askpass: CloneServiceDeps["askpass"];
  readonly #readCloneFolderSetting: () => Promise<string | null>;
  readonly #homeDirectory: string;
  readonly #folderPlace: CloneServiceDeps["folderPlace"];
  readonly #onCloneAttached: (projectId: ProjectId) => Promise<void>;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #git: GitCommand;
  readonly #streamedGit: StreamedGitRunner;
  readonly #startLock = new KeyedLock<string>();
  readonly #cards = new Map<ProjectId, CloneCard>();
  #isClosing = false;

  constructor(deps: CloneServiceDeps) {
    this.#projects = deps.projects;
    this.#records = deps.records;
    this.#askpass = deps.askpass;
    this.#readCloneFolderSetting = deps.readCloneFolderSetting;
    this.#homeDirectory = deps.homeDirectory;
    this.#folderPlace = deps.folderPlace;
    this.#onCloneAttached = deps.onCloneAttached;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#git = deps.git;
    this.#streamedGit = deps.streamedGit;
  }

  /**
   * Where a clone goes when the person names no folder: the folder set for clones, else the folder
   * holding the most recently attached project, else the home folder.
   */
  async readCloneFolder(): Promise<RepoCloneFolderReadResponse> {
    const setting = await this.#readCloneFolderSetting();
    if (setting !== null) return { folder: setting, source: "setting" };
    const [lastAttached] = this.#records.readAttachedProjectFolders();
    if (lastAttached !== undefined) {
      return { folder: path.dirname(lastAttached.canonicalRoot), source: "lastProject" };
    }
    return { folder: this.#homeDirectory, source: "home" };
  }

  /**
   * Starts a clone of `request.url` and answers its project at once: a new one marked `cloning`,
   * or `request.projectId` run again after a failed or canceled clone. An address whose repository
   * is already an attached project's clones nothing and answers that project. Throws
   * `RepoCloneRefusedError` when the address leaves no folder name, or the destination holds
   * anything or another clone is filling it, before git starts and with nothing written;
   * `RepoRootResolutionError` reason `not_absolute` for a relative folder;
   * `RepoFolderUnreachableError` for one in another WSL distribution; and `ProjectNotFoundError`
   * for a `projectId` no longer cloning.
   */
  async clone(request: RepoCloneRequest): Promise<RepoCloneResponse> {
    const name = repositoryNameOf(request.url);
    if (name === null) {
      throw new RepoCloneRefusedError({
        reason: "no_directory_name",
        line: NO_DIRECTORY_NAME_LINE,
      });
    }
    const attached = await this.#findAttachedProjectOf(request.url);
    if (attached !== null) return { projectId: attached };
    const parentFolder = request.parentFolder ?? (await this.readCloneFolder()).folder;
    if (!path.isAbsolute(parentFolder)) throw new RepoRootResolutionError("not_absolute");
    const destination = path.join(parentFolder, name);
    if (this.#folderPlace.isInAnotherDistribution(destination)) {
      throw new RepoFolderUnreachableError();
    }
    return this.#startLock.run(CLONE_START_LOCK_KEY, async () => {
      if (request.projectId !== undefined && this.#isRunning(request.projectId)) {
        return { projectId: request.projectId };
      }
      if (
        (await this.#isFilledByAnotherClone(destination)) ||
        (await readDestinationState(destination)) === "taken"
      ) {
        throw new RepoCloneRefusedError({ reason: "destination_not_empty" });
      }
      let projectId: ProjectId;
      if (request.projectId === undefined) {
        projectId = await this.#projects.createCloningProject({
          url: request.url,
          folderPath: destination,
          name,
        });
      } else {
        projectId = request.projectId;
        await this.#projects.retargetClone(projectId, {
          url: request.url,
          folderPath: destination,
        });
      }
      const card = this.#cardOf(projectId, {
        projectId,
        state: "cloning",
        progress: null,
        question: null,
      });
      card.destination = destination;
      this.#start(card, projectId, "clone", (activity) =>
        this.#runClone(card, activity, { projectId, url: request.url, destination }),
      );
      return { projectId };
    });
  }

  /**
   * Opens the project's clone card for `listener`: its status now, and every update after, at most
   * four a second. Throws `ProjectNotFoundError` when no such project exists.
   */
  async subscribe(projectId: ProjectId, listener: CloneStatusListener): Promise<CloneSubscription> {
    let card = this.#cards.get(projectId);
    if (card === undefined) {
      const status = await this.#statusFromRecord(projectId);
      // Another subscribe or a clone may have opened the card while the record was read.
      card = this.#cardOf(projectId, status);
    }
    const opened = card;
    opened.listeners.add(listener);
    return {
      status: opened.status,
      detach: () => {
        opened.listeners.delete(listener);
        this.#dropIfIdle(projectId, opened);
      },
    };
  }

  /**
   * Hands `answer` to the git question `questionId` waits on. A question no longer waiting (git
   * gave up on it, or another answer came first) takes nothing. Throws `ProjectNotFoundError`
   * when no such project exists.
   */
  answer(projectId: ProjectId, questionId: CloneQuestionId, answer: string): void {
    const activity = this.#cards.get(projectId)?.activity;
    const question = activity?.questions.find((waiting) => waiting.questionId === questionId);
    if (question !== undefined) {
      question.answer(answer);
      return;
    }
    if (this.#records.readRow(projectId) === undefined) throw new ProjectNotFoundError(projectId);
  }

  /**
   * Stops the project's clone, removes what it made and records it canceled, or stops its
   * large-files pull and leaves the clone; resolves once git has ended. Nothing running takes
   * nothing. Throws `ProjectNotFoundError` when no such project exists.
   */
  async cancel(projectId: ProjectId): Promise<void> {
    const activity = this.#cards.get(projectId)?.activity;
    if (activity === null || activity === undefined) {
      if (this.#records.readRow(projectId) === undefined) throw new ProjectNotFoundError(projectId);
      return;
    }
    activity.isCanceled = true;
    activity.stop.abort();
    await activity.ended;
  }

  /**
   * Fetches an attached project's large files: `git lfs install --local` then `git lfs pull`, the
   * card following it. Without Git LFS the card reads that large files are missing. Throws
   * `ProjectNotFoundError` unless the project is attached.
   */
  async pullLargeFiles(projectId: ProjectId): Promise<void> {
    const row = this.#records.readRow(projectId);
    if (row === undefined || row.repo_mount_id === null) throw new ProjectNotFoundError(projectId);
    const isInstalled = await isLargeFilesInstalled(this.#git);
    // A pull or clone started while Git LFS was looked for is the one that runs.
    if (this.#isRunning(projectId)) return;
    const card = this.#cardOf(projectId, { projectId, state: "done" });
    if (!isInstalled) {
      this.#publish(card, { projectId, state: "large_files_missing" });
      this.#dropIfIdle(projectId, card);
      return;
    }
    this.#start(card, projectId, "large_files", (activity) =>
      this.#runLargeFilesPull(card, activity, projectId, row.folder_path),
    );
  }

  /**
   * At the service's start, before any clone runs: each clone recorded running was cut short by
   * the last stop, so the folder the daemon made for its git is removed, while that path still
   * holds that folder, and it is recorded interrupted. Nothing at the destination is ever touched,
   * and a canceled or failed clone is left alone. A clone whose folder cannot be removed is
   * recorded failed with the reason, and the others go on.
   */
  async recoverInterruptedClones(): Promise<void> {
    for (const clone of this.#records.readRunningClones()) {
      const staged =
        clone.clone_staging_folder === null || clone.clone_staging_identity === null
          ? null
          : { path: clone.clone_staging_folder, identity: clone.clone_staging_identity };
      await this.#endShort(clone.id, staged, { outcome: CloneOutcome.Interrupted });
    }
  }

  /**
   * Stops every running git, for the service's shutdown, and resolves once each has ended. A clone
   * stopped so is recorded as one a restart cut short.
   */
  async close(): Promise<void> {
    this.#isClosing = true;
    const running = [...this.#cards.values()].flatMap((card) =>
      card.activity === null ? [] : [card.activity],
    );
    for (const activity of running) {
      activity.stop.abort();
    }
    await Promise.all(running.map((activity) => activity.ended));
    for (const card of this.#cards.values()) {
      card.gate.close();
      card.listeners.clear();
    }
    this.#cards.clear();
  }

  #isRunning(projectId: ProjectId): boolean {
    return (this.#cards.get(projectId)?.activity ?? null) !== null;
  }

  #cardOf(projectId: ProjectId, status: RepoCloneStatus): CloneCard {
    const existing = this.#cards.get(projectId);
    if (existing !== undefined) return existing;
    const listeners = new Set<CloneStatusListener>();
    const card: CloneCard = {
      status,
      listeners,
      gate: new LatestUpdateGate<RepoCloneStatus>((update) => {
        for (const listener of listeners) {
          listener(update);
        }
      }),
      activity: null,
      destination: null,
    };
    this.#cards.set(projectId, card);
    return card;
  }

  // A card with no listener and nothing running is read again from the record when next opened.
  #dropIfIdle(projectId: ProjectId, card: CloneCard): void {
    if (card.listeners.size > 0 || card.activity !== null) return;
    card.gate.close();
    this.#cards.delete(projectId);
  }

  #publish(card: CloneCard, status: RepoCloneStatus): void {
    card.status = status;
    card.gate.offer(status);
  }

  // The card of a running step: its progress and the first question git waits on.
  #publishActivity(card: CloneCard, projectId: ProjectId, activity: CloneActivity): void {
    const [question] = activity.questions;
    this.#publish(card, {
      projectId,
      state: activity.step === "clone" ? "cloning" : "pulling_large_files",
      progress: activity.progress,
      question:
        question === undefined
          ? null
          : { questionId: question.questionId, prompt: question.prompt, masked: question.isMasked },
    });
  }

  #start(
    card: CloneCard,
    projectId: ProjectId,
    step: CloneActivity["step"],
    run: (activity: CloneActivity) => Promise<RepoCloneStatus>,
  ): void {
    const activity: CloneActivity = {
      step,
      stop: new AbortController(),
      questions: [],
      progress: null,
      isCanceled: false,
      ended: Promise.resolve(),
    };
    card.activity = activity;
    this.#publishActivity(card, projectId, activity);
    activity.ended = run(activity).then(
      (status) => {
        this.#end(card, projectId, status);
      },
      (error: unknown) => {
        this.#writeServiceLog(`clone of project ${projectId}: ${describeRejection(error)}`);
        this.#end(card, projectId, {
          projectId,
          state: "failed",
          step,
          failureLine: failureLineOf(error),
        });
      },
    );
  }

  #end(card: CloneCard, projectId: ProjectId, status: RepoCloneStatus): void {
    card.activity = null;
    card.destination = null;
    this.#publish(card, status);
    this.#dropIfIdle(projectId, card);
  }

  async #runClone(
    card: CloneCard,
    activity: CloneActivity,
    clone: { readonly projectId: ProjectId; readonly url: string; readonly destination: string },
  ): Promise<RepoCloneStatus> {
    const { projectId, destination } = clone;
    let isMissingLargeFiles: boolean;
    // The folder the daemon made for git, once made: the one folder a failure removes.
    let staged: StagedClone | null = null;
    try {
      const hasLargeFiles = await isLargeFilesInstalled(this.#git);
      // The folder may have filled since the start looked; what is there now is not the clone's.
      if ((await readDestinationState(destination)) === "taken") {
        throw new CloneFailure(DESTINATION_FILLED_LINE);
      }
      staged = await makeStagedClone(destination);
      await this.#projects.recordCloneStaged(projectId, staged);
      const exit = await this.#runGitFollowed(card, projectId, activity, [
        ...(hasLargeFiles ? LARGE_FILES_CLONE_OPTIONS : []),
        "clone",
        "--recurse-submodules",
        "--progress",
        "--",
        clone.url,
        staged.path,
      ]);
      if (activity.isCanceled) {
        return cloneStatusOf(
          projectId,
          await this.#endShort(projectId, staged, { outcome: CloneOutcome.Canceled }),
        );
      }
      if (exit.failureLine !== null) {
        // A clone the shutdown stopped reads as one a restart cut short: no line of git's. One
        // that finished as the shutdown began is kept.
        if (this.#isClosing) {
          return cloneStatusOf(
            projectId,
            await this.#endShort(projectId, staged, { outcome: CloneOutcome.Interrupted }),
          );
        }
        throw new CloneFailure(exit.failureLine);
      }
      if (hasLargeFiles) await this.#git(["-C", staged.path, "lfs", "install", "--local"]);
      isMissingLargeFiles = !hasLargeFiles && (await keepsLargeFiles(staged.path));
      const placed = await moveStagedCloneIntoPlace(staged, destination);
      if (placed === null) throw new CloneFailure(DESTINATION_FILLED_LINE);
      staged = placed;
      // The last step that can fail: once attached, the folder is the project's and stays.
      await this.#projects.attachClonedProject(projectId, destination);
    } catch (error) {
      // Git, or a step around it up to and including the attach, failed: the clone is not kept.
      const failureLine = error instanceof CloneFailure ? error.line : failureLineOf(error);
      return cloneStatusOf(
        projectId,
        await this.#endShort(projectId, staged, { outcome: CloneOutcome.Failed, failureLine }),
      );
    }
    // The sessions made while the clone ran finish now. The attached clone stays either way; a
    // session that could not be finished is the card's failure.
    try {
      await this.#onCloneAttached(projectId);
    } catch (error) {
      this.#writeServiceLog(`clone of project ${projectId}: ${describeRejection(error)}`);
      return { projectId, state: "failed", step: "sessions", failureLine: failureLineOf(error) };
    }
    return { projectId, state: isMissingLargeFiles ? "large_files_missing" : "done" };
  }

  /**
   * Removes the folder the daemon made for a clone's git, while that path still holds it, and
   * records how the clone ended; a folder that cannot be removed records the clone failed with
   * the reason instead. Answers the end recorded.
   */
  async #endShort(
    projectId: ProjectId,
    staged: StagedClone | null,
    end: CloneEnd,
  ): Promise<CloneEnd> {
    let recorded = end;
    if (staged !== null) {
      try {
        await removeStagedClone(staged);
      } catch (error) {
        recorded = {
          outcome: CloneOutcome.Failed,
          failureLine: boundedLine(
            `What the clone left could not be removed: ${describeRejection(error)}`,
          ),
        };
      }
    }
    await this.#projects.recordCloneEnd(projectId, recorded);
    return recorded;
  }

  async #runLargeFilesPull(
    card: CloneCard,
    activity: CloneActivity,
    projectId: ProjectId,
    root: string,
  ): Promise<RepoCloneStatus> {
    await this.#git(["-C", root, "lfs", "install", "--local"]);
    const exit = await this.#runGitFollowed(card, projectId, activity, ["-C", root, "lfs", "pull"]);
    if (activity.isCanceled) return { projectId, state: "canceled" };
    if (exit.failureLine !== null) {
      return { projectId, state: "failed", step: "large_files", failureLine: exit.failureLine };
    }
    return { projectId, state: "done" };
  }

  // Runs git with its progress and questions on the card; answers git's failure line, or `null`
  // when git exited 0.
  async #runGitFollowed(
    card: CloneCard,
    projectId: ProjectId,
    activity: CloneActivity,
    argv: readonly string[],
  ): Promise<{ readonly failureLine: string | null }> {
    const owner = this.#askpass.register((question) =>
      this.#ask(card, projectId, activity, question),
    );
    try {
      const reader = new GitProgressReader((progress) => {
        activity.progress = progress;
        this.#publishActivity(card, projectId, activity);
      });
      const exit = await this.#streamedGit(argv, {
        environmentOverrides: owner.environment,
        onStderr: (chunk) => {
          reader.read(chunk);
        },
        signal: activity.stop.signal,
        stopGraceMs: () => (this.#isClosing ? SHUTDOWN_STOP_GRACE_MS : CANCEL_STOP_GRACE_MS),
      });
      if (exit.exitCode === 0) return { failureLine: null };
      return { failureLine: reader.failureLine() ?? describeExit(exit) };
    } finally {
      owner.release();
    }
  }

  // Puts git's question on the card until it is answered or git stops waiting.
  #ask(
    card: CloneCard,
    projectId: ProjectId,
    activity: CloneActivity,
    question: AskpassQuestion,
  ): Promise<string> {
    const prompt = boundedLine(question.prompt.replaceAll("\0", ""));
    if (prompt.trim() === "") {
      return Promise.reject(new Error("git asked a question with no words"));
    }
    return new Promise<string>((resolve, reject) => {
      const questionId = mintUuidV7() as CloneQuestionId;
      const settle = (): void => {
        const index = activity.questions.findIndex((waiting) => waiting.questionId === questionId);
        if (index === -1) return;
        activity.questions.splice(index, 1);
        this.#publishActivity(card, projectId, activity);
      };
      activity.questions.push({
        questionId,
        prompt,
        isMasked: question.isMasked,
        answer: (answer) => {
          settle();
          resolve(answer);
        },
      });
      question.signal.addEventListener(
        "abort",
        () => {
          settle();
          reject(new Error("git stopped waiting for the answer"));
        },
        { once: true },
      );
      this.#publishActivity(card, projectId, activity);
    });
  }

  // The status a card opens with when nothing runs in this service: read from the record.
  async #statusFromRecord(projectId: ProjectId): Promise<RepoCloneStatus> {
    const row = this.#records.readRow(projectId);
    if (row === undefined) throw new ProjectNotFoundError(projectId);
    // Only a project still cloning holds an outcome.
    if (row.clone_outcome !== null) {
      return cloneStatusOf(projectId, {
        outcome: row.clone_outcome,
        failureLine: row.clone_failure,
      });
    }
    const isMissingLargeFiles =
      (await keepsLargeFiles(row.folder_path)) && !(await isLargeFilesInstalled(this.#git));
    return { projectId, state: isMissingLargeFiles ? "large_files_missing" : "done" };
  }

  // Whether a running clone fills `destination`, the folders compared resolved.
  async #isFilledByAnotherClone(destination: string): Promise<boolean> {
    const destinationKey = await canonicalFolderPath(destination);
    for (const card of this.#cards.values()) {
      const cardDestination = card.destination;
      if (
        cardDestination !== null &&
        (await canonicalFolderPath(cardDestination)) === destinationKey
      ) {
        return true;
      }
    }
    return false;
  }

  // The attached project whose repository `url` names, read from each project's `origin`. A
  // project whose origin cannot be read, its folder gone among them, is logged and passed over,
  // so one broken project never stops a clone.
  async #findAttachedProjectOf(url: string): Promise<ProjectId | null> {
    const key = repositoryKeyOf(url);
    const folders = this.#records.readAttachedProjectFolders();
    const origins = await mapWithProcessorBound(folders, async (folder) => {
      try {
        return await this.#readOriginOf(folder.canonicalRoot);
      } catch (error) {
        this.#writeServiceLog(
          `clone: passed over project ${folder.projectId}, whose origin could not be read: ` +
            describeRejection(error),
        );
        return null;
      }
    });
    const index = origins.findIndex((origin) => origin !== null && repositoryKeyOf(origin) === key);
    return index === -1 ? null : (folders[index]?.projectId ?? null);
  }

  // The repository's `origin` address, or `null` when it has none. Any other failure of git's,
  // a broken repository's among them, is thrown.
  async #readOriginOf(root: string): Promise<string | null> {
    try {
      const { stdout } = await this.#git(["-C", root, "config", "--get", "remote.origin.url"]);
      return stdout.toString("utf8").trim();
    } catch (error) {
      if (readGitExitStatus(error) === GIT_CONFIG_KEY_MISSING_EXIT_STATUS) return null;
      throw error;
    }
  }
}

// A failure whose line the card shows as it is, thrown so the clone's one failure path records it.
class CloneFailure extends Error {
  readonly line: string;

  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

// The card a clone's recorded outcome reads as.
function cloneStatusOf(
  projectId: ProjectId,
  {
    outcome,
    failureLine,
  }: { readonly outcome: CloneOutcome; readonly failureLine?: string | null },
): RepoCloneStatus {
  switch (outcome) {
    case CloneOutcome.Running:
      return { projectId, state: "cloning", progress: null, question: null };
    case CloneOutcome.Canceled:
      return { projectId, state: "canceled" };
    case CloneOutcome.Failed:
      return { projectId, state: "failed", step: "clone", failureLine: failureLine ?? null };
    case CloneOutcome.Interrupted:
      return { projectId, state: "failed", step: "clone", failureLine: null };
  }
}

// Git ended without a word: how it ended.
function describeExit(exit: StreamedGitExit): string {
  return exit.signal === null
    ? `git exited with code ${String(exit.exitCode)}`
    : `git was ended by ${exit.signal}`;
}

function boundedLine(text: string): string {
  return text.slice(0, REPO_CLONE_LINE_MAX_LEN);
}

// The card's line for a failure; an error with no message reads as its name.
function failureLineOf(error: unknown): string {
  const message = describeRejection(error);
  return boundedLine(message.length > 0 ? message : String(error));
}
