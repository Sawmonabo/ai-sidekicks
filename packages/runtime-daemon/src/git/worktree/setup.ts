// The setup card of a new tree: the tree made, the project's own setup steps run in place, then the
// warm step. The project's steps are the person's own list, files copied from the repository's
// checkout and commands run in order, each given up on after the project's time limit; they run
// with the repository's own git config and raise no approval. The warm step is one `git status` in
// the new tree while nothing else runs there, then the tree's watches started and held until the
// setup ends, by when a live session holds its own; it reads nothing else ahead of time.
//
// The card is kept for each tree until the tree is removed, so a client that leaves the session and
// comes back reads it as it stood; a failed step stands until a retry runs it and the steps after.
// A running command is kept on its card, so a removal can end it before its tree moves and a
// daemon stop can end every one; a card dropped once its tree is retired ends its command too.

import { spawn, type ChildProcess } from "node:child_process";
import { cp, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import { DAEMON_STOP_TERMINAL_DRAIN_MS } from "@ai-sidekicks/contracts/daemon/lifecycle";
import type { ProjectSetup } from "@ai-sidekicks/contracts/project";
import type { WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";
import {
  WORKTREE_SETUP_OUTPUT_MAX_LEN,
  type WorktreeSetupStage,
  type WorktreeSetupStatus,
  type WorktreeSetupStep,
} from "@ai-sidekicks/contracts/worktree/setup";

import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { describeRejection } from "../../rejection.js";
import { endProcessTree } from "../../process-tree.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import { lstatOptional } from "../filesystem.js";
import type { GitCommand } from "../process.js";
import { WorktreeNotFoundError } from "./errors.js";

// Each fixed step's label is the command it runs.
const MAKE_TREE_LABEL = "git worktree add";
const WARM_LABEL = "git status";

// How long a command ended because its tree is being removed has to exit after SIGTERM before
// SIGKILL: the grace terminal programs give a process they close.
const REMOVAL_END_GRACE_MS = 5_000;

// What a command's step says when the daemon ended it.
const REMOVED_END_REASON = "Ended because its worktree was removed";
const STOPPED_END_REASON = "Ended because the background service stopped";

/** Where a new tree is and the repository it was made from. */
export interface MadeWorktree {
  readonly worktreeId: WorktreeId;
  readonly treePath: string;
  /** The repository's own checkout, which the files to copy are read from. */
  readonly repositoryRoot: string;
  readonly repoMountId: string;
}

/** What the setup runner runs with. */
export interface WorktreeSetupRunnerDeps {
  /** The daemon's git entry point, running with the repository's own config. */
  readonly git: GitCommand;
  /** Throws `WorktreeNotFoundError` for an id with no worktree row. */
  readonly requireWorktree: (worktreeId: WorktreeId) => void;
  /** Whether the tree's retirement is recorded; `false` while its row is not yet written. */
  readonly isRetired: (worktreeId: WorktreeId) => boolean;
  /** The setup steps of the project the tree belongs to, as the projects page stores them. */
  readonly readProjectSetup: (worktreeId: WorktreeId) => Promise<ProjectSetup>;
  /** Starts the tree's watches, held until the returned release runs. */
  readonly startWatches: (target: {
    readonly folder: string;
    readonly repoMountId: string;
  }) => Promise<() => void>;
  /** The person's login shell the commands run under; `null` takes the platform's own. */
  readonly commandShell: string | null;
  /** The environment a command in the tree starts with, its project's own rows included. */
  readonly commandEnvironment: (worktreeId: WorktreeId) => Promise<NodeJS.ProcessEnv>;
  /** Where a retired tree's card that could not be dropped, or its command ended, is written. */
  readonly writeServiceLog: ServiceLogWriter;
  /** Monotonic clock in milliseconds for each step's elapsed time; injectable for tests. */
  readonly monotonicNow?: () => number;
}

// A project step is a file to copy or a command to run; the fixed steps carry no action.
type StepAction =
  | { readonly kind: "make_tree" }
  | { readonly kind: "copy"; readonly path: string }
  | {
      readonly kind: "command";
      readonly command: string;
      /** `undefined` sets no limit. */
      readonly timeLimitSeconds: number | undefined;
    }
  | { readonly kind: "warm" };

interface CardStep {
  step: WorktreeSetupStep;
  action: StepAction;
}

interface SetupCard {
  readonly worktreeId: WorktreeId;
  made: MadeWorktree | null;
  // A card exists only once a setup has begun.
  state: Exclude<WorktreeSetupStatus["state"], "not_run">;
  steps: CardStep[];
  readonly listeners: Set<(status: WorktreeSetupStatus) => void>;
  // The run in progress, so a retry while one runs does nothing.
  running: Promise<WorktreeSetupStatus> | null;
  // The command step running now, so a removal or a stop can end it.
  runningCommand: RunningCommand | null;
  releaseWatches: (() => void) | null;
}

interface RunningCommand {
  readonly child: ChildProcess;
  // Settles once the child and its output have closed.
  readonly closed: Promise<void>;
  // Why the daemon ended it, for the step's error; `null` while nothing has.
  endReason: string | null;
}

/** The setup card of every tree being set up, its runs and its retries. */
export class WorktreeSetupRunner {
  readonly #deps: WorktreeSetupRunnerDeps;
  readonly #monotonicNow: () => number;
  readonly #cardByWorktree = new Map<WorktreeId, SetupCard>();
  // When the tree being made started, by tree.
  readonly #treeStartedAt = new Map<WorktreeId, number>();
  // The commands of dropped cards still being ended, so the daemon's stop reaches them too.
  readonly #endingCommands = new Set<RunningCommand>();
  // Set by the stop, after which no command starts.
  #isStopped = false;

  constructor(deps: WorktreeSetupRunnerDeps) {
    this.#deps = deps;
    this.#monotonicNow = deps.monotonicNow ?? (() => performance.now());
  }

  /** Opens the card of a tree about to be made, its first stage running. */
  begin(worktreeId: WorktreeId): void {
    this.#treeStartedAt.set(worktreeId, this.#monotonicNow());
    this.#cardByWorktree.set(worktreeId, {
      worktreeId,
      made: null,
      state: "running",
      steps: [
        {
          step: { stage: "make_tree", label: MAKE_TREE_LABEL, state: "running" },
          action: { kind: "make_tree" },
        },
      ],
      listeners: new Set(),
      running: null,
      runningCommand: null,
      releaseWatches: null,
    });
  }

  /** Marks the tree's making failed with git's error; the card stands failed. */
  treeFailed(worktreeId: WorktreeId, error: string): void {
    const card = this.#requireCard(worktreeId);
    const makeTree = card.steps[0];
    if (makeTree !== undefined) {
      makeTree.step = {
        ...makeTree.step,
        state: "failed",
        elapsedMs: this.#treeElapsedMs(worktreeId),
        error,
      };
    }
    card.state = "failed";
    this.#emit(card);
  }

  /**
   * Marks the tree made and runs the project's steps and the warm step; resolves with the card as
   * it ends, `succeeded` or stopped at its failed step. Throws `WorktreeNotFoundError` when no card
   * was begun for the tree.
   */
  async treeMade(made: MadeWorktree): Promise<WorktreeSetupStatus> {
    const card = this.#requireCard(made.worktreeId);
    card.made = made;
    const makeTree = card.steps[0];
    if (makeTree !== undefined) {
      makeTree.step = {
        ...makeTree.step,
        state: "succeeded",
        elapsedMs: this.#treeElapsedMs(made.worktreeId),
      };
    }
    let setup: ProjectSetup;
    try {
      setup = await this.#deps.readProjectSetup(made.worktreeId);
    } catch (error) {
      // With no steps read there is nothing to retry; the card says the setup stopped.
      card.state = "failed";
      this.#emit(card);
      throw error;
    }
    card.steps = [...card.steps, ...projectStepsOf(setup), warmStep()];
    return this.#runFrom(card, made, 1);
  }

  /**
   * Calls `listener` with the card now and on every change, until the returned detach runs. A tree
   * with no card, one whose setup did not run since the daemon started, is called back once with
   * `not_run` and no steps. Throws `WorktreeNotFoundError` for an id with no worktree.
   */
  subscribe(worktreeId: WorktreeId, listener: (status: WorktreeSetupStatus) => void): () => void {
    const card = this.#cardByWorktree.get(worktreeId);
    if (card === undefined) {
      this.#deps.requireWorktree(worktreeId);
      listener({ worktreeId, state: "not_run", steps: [] });
      return () => {};
    }
    // A wrapper, so one function attached twice detaches once per attach.
    const attached = (status: WorktreeSetupStatus): void => {
      listener(status);
    };
    card.listeners.add(attached);
    attached(statusOf(card));
    return () => {
      card.listeners.delete(attached);
    };
  }

  /**
   * Runs the failed step again with the project's steps as now saved, then the steps after it;
   * resolves with the card as it ends. The steps are matched by what they do, not their place, so
   * an edited list resumes at its first step that has not succeeded. A card that is not failed is
   * left as it is. Throws `WorktreeNotFoundError` when the tree has no card, and an `Error` when
   * the tree itself was never made, which a new preparation does instead.
   */
  async retry(worktreeId: WorktreeId): Promise<WorktreeSetupStatus> {
    const card = this.#requireCard(worktreeId);
    if (card.running !== null) {
      return card.running;
    }
    const failedIndex = card.steps.findIndex((entry) => entry.step.state === "failed");
    const failed = card.steps[failedIndex];
    if (card.state !== "failed" || failed === undefined) {
      return statusOf(card);
    }
    const made = card.made;
    if (failed.action.kind === "make_tree" || made === null) {
      throw new Error("The tree was never made, so its setup cannot be retried; prepare it again");
    }
    if (failed.action.kind === "warm") {
      return this.#runFrom(card, made, failedIndex);
    }
    // The person may have fixed the step since, so the project's steps are read again.
    const setup = await this.#deps.readProjectSetup(worktreeId);
    const [makeTree] = card.steps;
    const kept = keepSucceededSteps(card.steps, projectStepsOf(setup));
    card.steps = [...(makeTree === undefined ? [] : [makeTree]), ...kept.steps, warmStep()];
    return this.#runFrom(card, made, 1 + kept.succeededCount);
  }

  /**
   * Ends every running setup command whose working folder is `folder` or inside it, with SIGTERM
   * and then SIGKILL after a grace, and resolves once each has exited; its step fails saying why.
   * Run before the folder is moved or deleted.
   */
  async endProcessesInFolder(folder: string): Promise<void> {
    const folderKey = await canonicalFolderPath(folder);
    const ending: Promise<void>[] = [];
    for (const card of this.#cardByWorktree.values()) {
      const running = card.runningCommand;
      if (running === null || card.made === null) {
        continue;
      }
      const treeKey = await canonicalFolderPath(card.made.treePath);
      if (treeKey === folderKey || treeKey.startsWith(`${folderKey}${sep}`)) {
        ending.push(
          endRunningCommand(running, REMOVED_END_REASON, {
            graceMs: REMOVAL_END_GRACE_MS,
            awaitsExit: true,
          }),
        );
      }
    }
    await Promise.all(ending);
  }

  /**
   * Ends every running setup command, with SIGTERM and then SIGKILL within the daemon's stop
   * window, and starts no command after; run when the daemon stops. A command that cannot be
   * signaled is thrown.
   */
  async stop(): Promise<void> {
    this.#isStopped = true;
    const running = [
      ...[...this.#cardByWorktree.values()].map((card) => card.runningCommand),
      ...this.#endingCommands,
    ];
    await Promise.all(
      running.flatMap((command) =>
        command === null
          ? []
          : [
              endRunningCommand(command, STOPPED_END_REASON, {
                graceMs: DAEMON_STOP_TERMINAL_DRAIN_MS,
                awaitsExit: false,
              }),
            ],
      ),
    );
  }

  /**
   * Drops the tree's card, stops the watches its warm step started and ends its running command
   * with the removal's grace; run when the tree is removed or was never recorded. A command that
   * cannot be ended is written to the service log.
   */
  forget(worktreeId: WorktreeId): void {
    const card = this.#cardByWorktree.get(worktreeId);
    this.#cardByWorktree.delete(worktreeId);
    this.#treeStartedAt.delete(worktreeId);
    if (card === undefined) {
      return;
    }
    card.releaseWatches?.();
    card.releaseWatches = null;
    const running = card.runningCommand;
    if (running === null) {
      return;
    }
    this.#endingCommands.add(running);
    void endRunningCommand(running, REMOVED_END_REASON, {
      graceMs: REMOVAL_END_GRACE_MS,
      awaitsExit: true,
    })
      .catch((error: unknown) => {
        this.#deps.writeServiceLog(
          `A removed worktree's setup command could not be ended: ${describeRejection(error)}`,
        );
      })
      .finally(() => {
        this.#endingCommands.delete(running);
      });
  }

  /**
   * Forgets the card of every tree whose retirement is recorded. Every path that retires a tree
   * calls it once the retirement is written, so nothing here can undo one; a failed read of the
   * rows is written to the service log.
   */
  forgetRetired(): void {
    try {
      for (const worktreeId of [...this.#cardByWorktree.keys()]) {
        if (this.#deps.isRetired(worktreeId)) {
          this.forget(worktreeId);
        }
      }
    } catch (error) {
      this.#deps.writeServiceLog(
        `The setup cards of retired worktrees could not be dropped: ${describeRejection(error)}`,
      );
    }
  }

  #isHeld(card: SetupCard): boolean {
    return this.#cardByWorktree.get(card.worktreeId) === card;
  }

  #requireCard(worktreeId: WorktreeId): SetupCard {
    const card = this.#cardByWorktree.get(worktreeId);
    if (card === undefined) {
      throw new WorktreeNotFoundError(worktreeId);
    }
    return card;
  }

  #treeElapsedMs(worktreeId: WorktreeId): number {
    const startedAt = this.#treeStartedAt.get(worktreeId) ?? this.#monotonicNow();
    this.#treeStartedAt.delete(worktreeId);
    return Math.round(this.#monotonicNow() - startedAt);
  }

  #runFrom(card: SetupCard, made: MadeWorktree, firstIndex: number): Promise<WorktreeSetupStatus> {
    const running = this.#runSteps(card, made, firstIndex).finally(() => {
      card.running = null;
      card.releaseWatches?.();
      card.releaseWatches = null;
    });
    card.running = running;
    return running;
  }

  async #runSteps(
    card: SetupCard,
    made: MadeWorktree,
    firstIndex: number,
  ): Promise<WorktreeSetupStatus> {
    card.state = "running";
    card.steps = card.steps.map((entry, index) => (index < firstIndex ? entry : resetStep(entry)));
    this.#emit(card);
    for (let index = firstIndex; index < card.steps.length; index += 1) {
      // A dropped card runs no further step, so nothing starts in a tree being removed.
      if (!this.#isHeld(card)) {
        return statusOf(card);
      }
      const entry = card.steps[index];
      if (entry === undefined) {
        break;
      }
      entry.step = { ...entry.step, state: "running" };
      this.#emit(card);
      const startedAt = this.#monotonicNow();
      const outcome = await this.#runStep(card, made, entry.action);
      const elapsedMs = Math.round(this.#monotonicNow() - startedAt);
      if (outcome.error !== null) {
        entry.step = {
          ...entry.step,
          state: "failed",
          elapsedMs,
          error: outcome.error,
          ...(outcome.output.length > 0 ? { output: outcome.output } : {}),
        };
        card.state = "failed";
        this.#emit(card);
        return statusOf(card);
      }
      entry.step = { ...entry.step, state: "succeeded", elapsedMs };
      this.#emit(card);
    }
    card.state = "succeeded";
    this.#emit(card);
    return statusOf(card);
  }

  async #runStep(card: SetupCard, made: MadeWorktree, action: StepAction): Promise<StepOutcome> {
    switch (action.kind) {
      // The create function made the tree before the card's later steps run.
      case "make_tree":
        return { error: null, output: "" };
      case "copy":
        return copySetupFile(made, action.path, this.#deps.writeServiceLog);
      case "command":
        return this.#runCommand(card, made, action.command, action.timeLimitSeconds);
      case "warm":
        return this.#warm(card, made);
    }
  }

  async #warm(card: SetupCard, made: MadeWorktree): Promise<StepOutcome> {
    try {
      await this.#deps.git(["-C", made.treePath, "status", "--porcelain"]);
      // A card dropped while this step ran starts no watch, and one dropped while its watch
      // started releases it at once.
      if (card.releaseWatches === null && this.#isHeld(card)) {
        const releaseWatches = await this.#deps.startWatches({
          folder: made.treePath,
          repoMountId: made.repoMountId,
        });
        if (this.#isHeld(card)) {
          card.releaseWatches = releaseWatches;
        } else {
          releaseWatches();
        }
      }
    } catch (error) {
      return { error: describeRejection(error), output: "" };
    }
    return { error: null, output: "" };
  }

  async #runCommand(
    card: SetupCard,
    made: MadeWorktree,
    command: string,
    timeLimitSeconds: number | undefined,
  ): Promise<StepOutcome> {
    let environment: NodeJS.ProcessEnv;
    try {
      environment = await this.#deps.commandEnvironment(made.worktreeId);
    } catch (error) {
      return { error: describeRejection(error), output: "" };
    }
    // Checked after the last await, so no command starts on a dropped card, which nothing would
    // end, or after the stop has collected the running ones.
    if (this.#isStopped) {
      return { error: STOPPED_END_REASON, output: "" };
    }
    if (!this.#isHeld(card)) {
      return { error: REMOVED_END_REASON, output: "" };
    }
    return new Promise<StepOutcome>((settle) => {
      const output = new OutputTail();
      const child = spawn(command, {
        cwd: made.treePath,
        env: environment,
        shell: this.#deps.commandShell ?? true,
        // Its own process group, so ending it ends every process the command started.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let markClosed = (): void => {};
      const running: RunningCommand = {
        child,
        closed: new Promise<void>((resolveClosed) => {
          markClosed = resolveClosed;
        }),
        endReason: null,
      };
      card.runningCommand = running;
      const finish = (outcome: StepOutcome): void => {
        if (card.runningCommand === running) {
          card.runningCommand = null;
        }
        markClosed();
        settle(outcome);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output.append(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output.append(chunk);
      });
      let hasGivenUp = false;
      // No limit set, no timer: the command runs until it exits or is ended.
      const limit =
        timeLimitSeconds === undefined
          ? undefined
          : setTimeout(() => {
              hasGivenUp = true;
              // No pid means the spawn failed, and its `error` settles the step.
              if (child.pid !== undefined) {
                // The step settles on the failure; the child stays on the card until it closes.
                endProcessTree(child.pid, "SIGKILL").catch((error: unknown) => {
                  settle({
                    error:
                      "Could not end the command at its time limit: " + describeRejection(error),
                    output: output.text(),
                  });
                });
              }
            }, timeLimitSeconds * 1000);
      child.once("error", (error: Error) => {
        clearTimeout(limit);
        finish({ error: error.message, output: output.text() });
      });
      child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(limit);
        if (running.endReason !== null) {
          finish({ error: running.endReason, output: output.text() });
        } else if (hasGivenUp) {
          finish({
            error: `Gave up after ${String(timeLimitSeconds)} seconds`,
            output: output.text(),
          });
        } else if (exitCode === 0) {
          finish({ error: null, output: output.text() });
        } else {
          finish({
            error:
              exitCode === null
                ? `Ended by ${String(signal)}`
                : `Exited with code ${String(exitCode)}`,
            output: output.text(),
          });
        }
      });
    });
  }

  #emit(card: SetupCard): void {
    const status = statusOf(card);
    for (const listener of card.listeners) {
      listener(status);
    }
  }
}

interface StepOutcome {
  readonly error: string | null;
  readonly output: string;
}

// The tail of a step's combined output, bounded to what a failed step carries.
class OutputTail {
  #text = "";

  append(chunk: Buffer): void {
    this.#text = (this.#text + chunk.toString("utf8")).slice(-WORKTREE_SETUP_OUTPUT_MAX_LEN);
  }

  text(): string {
    return this.#text;
  }
}

function projectStepsOf(setup: ProjectSetup): CardStep[] {
  const stage: WorktreeSetupStage = "project_steps";
  return [
    ...setup.filesToCopy.map(
      (path): CardStep => ({
        step: { stage, label: path, state: "pending" },
        action: { kind: "copy", path },
      }),
    ),
    ...setup.commands.map(
      (command): CardStep => ({
        step: { stage, label: command, state: "pending" },
        action: { kind: "command", command, timeLimitSeconds: setup.timeLimitSeconds },
      }),
    ),
  ];
}

function warmStep(): CardStep {
  return {
    step: { stage: "warm_caches", label: WARM_LABEL, state: "pending" },
    action: { kind: "warm" },
  };
}

function resetStep(entry: CardStep): CardStep {
  return { ...entry, step: { stage: entry.step.stage, label: entry.step.label, state: "pending" } };
}

// Ends a running command's process tree: SIGTERM, then SIGKILL once `graceMs` passes without it
// exiting. With `awaitsExit`, resolves only once it has exited.
async function endRunningCommand(
  running: RunningCommand,
  endReason: string,
  options: { readonly graceMs: number; readonly awaitsExit: boolean },
): Promise<void> {
  const pid = running.child.pid;
  if (pid === undefined) {
    return;
  }
  running.endReason = endReason;
  await endProcessTree(pid, "SIGTERM");
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceEnded = new Promise<"grace_ended">((resolveGrace) => {
    graceTimer = setTimeout(() => {
      resolveGrace("grace_ended");
    }, options.graceMs);
  });
  const outcome = await Promise.race([running.closed.then(() => "exited" as const), graceEnded]);
  clearTimeout(graceTimer);
  if (outcome === "exited") {
    return;
  }
  await endProcessTree(pid, "SIGKILL");
  if (options.awaitsExit) {
    await running.closed;
  }
}

// What a step does, so a re-read list is matched to the card's steps by action, not place.
function identityOf(action: StepAction): string {
  switch (action.kind) {
    case "copy":
      return `copy\0${action.path}`;
    case "command":
      return `command\0${action.command}`;
    case "make_tree":
    case "warm":
      return action.kind;
  }
}

// The re-read project steps with the leading ones that already succeeded kept as they stood, each
// earlier success matched once, and the rest pending from the first that has not succeeded.
function keepSucceededSteps(
  current: readonly CardStep[],
  reread: readonly CardStep[],
): { readonly steps: CardStep[]; readonly succeededCount: number } {
  const succeededByIdentity = new Map<string, CardStep[]>();
  for (const entry of current) {
    if (entry.step.stage === "project_steps" && entry.step.state === "succeeded") {
      const identity = identityOf(entry.action);
      succeededByIdentity.set(identity, [...(succeededByIdentity.get(identity) ?? []), entry]);
    }
  }
  const steps: CardStep[] = [];
  let succeededCount = 0;
  for (const entry of reread) {
    const earlier = succeededByIdentity.get(identityOf(entry.action));
    const match = steps.length === succeededCount ? earlier?.shift() : undefined;
    if (match === undefined) {
      steps.push(entry);
    } else {
      steps.push(match);
      succeededCount += 1;
    }
  }
  return { steps, succeededCount };
}

function statusOf(card: SetupCard): WorktreeSetupStatus {
  return {
    worktreeId: card.worktreeId,
    state: card.state,
    steps: card.steps.map((entry) => entry.step),
  };
}

// A file to copy names a path inside the repository; one that leads outside the checkout or the
// tree is refused rather than read or written. A file the tree already has is kept and skipped,
// and the service log names it: carried work, a file its branch tracks, or one written since a
// failed step, is never overwritten by a retry. A folder both have is copied into.
async function copySetupFile(
  made: MadeWorktree,
  path: string,
  writeServiceLog: ServiceLogWriter,
): Promise<StepOutcome> {
  const source = resolve(made.repositoryRoot, path);
  const destination = resolve(made.treePath, path);
  if (!isInside(made.repositoryRoot, source) || !isInside(made.treePath, destination)) {
    return { error: "The file to copy is outside the repository", output: "" };
  }
  try {
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: false,
      verbatimSymlinks: true,
      filter: async (sourceEntry, destinationEntry) => {
        const existing = await lstatOptional(destinationEntry);
        if (existing === undefined) {
          return true;
        }
        if (existing.isDirectory() && (await lstat(sourceEntry)).isDirectory()) {
          return true;
        }
        writeServiceLog(
          `Worktree setup kept ${destinationEntry}, which the tree already has, rather than ` +
            "copying over it",
        );
        return false;
      },
    });
  } catch (error) {
    return { error: describeRejection(error), output: "" };
  }
  return { error: null, output: "" };
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}
