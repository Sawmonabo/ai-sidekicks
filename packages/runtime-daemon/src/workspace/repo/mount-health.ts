// A repo mount's health as every surface reads it: the root probed for reachability, then, when
// reachable and anchored, the repository git finds there compared with the attach-time anchor.
// The re-probe recomputes it for attached mounts and tells each session on a mount whose verdict
// changed.
//
// - Health is never stored: the re-probe keeps the last verdict it sent per mount, in memory, and
//   before its first send compares with what each session's log last told it (`healthy` when
//   nothing was ever told), so a change while the daemon was down still reaches the session.
// - Mounts are probed as many at once as the machine has processors, each mount one pass at a
//   time; calls during a mount's pass coalesce into one more pass of that mount.
// - Each probe is bounded by the git command timeout. At service start a probe that runs out of
//   time reads `unreachable`, so a mount that hangs is never left on the assumed `healthy`; after
//   start it is no verdict.
// - A git that could not answer is no verdict: the probe throws it, and the re-probe logs it and
//   keeps the verdict it last sent.
// - The stop ends every pass at once and sends nothing after it; a probe still running cannot be
//   stopped, so it is left to finish unwatched.

import * as nodePath from "node:path";

import type { Statement } from "better-sqlite3";

import {
  RepoMountHealthSchema,
  RepoMountIdSchema,
  type RepoMountHealth,
  type RepoMountId,
} from "@ai-sidekicks/contracts/repo/mount";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";

import { waitWithin } from "../../bounded-wait.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS } from "../../git/process.js";
import { mapWithProcessorBound } from "../../processor-bound.js";
import type { WorkspaceEventEmitter } from "../event-emitter.js";
import { computeRepoMountHealth, type RepoMountHealthRow } from "../projector.js";
import {
  CHECKOUT_ROOT_METADATA_PATH,
  COMMON_DIR_METADATA_PATH,
  createDefaultPathProbe,
  type FilesystemPathProbeFn,
} from "../row-guards.js";
import { componentsEqual, isContainedWithin, toComparableComponents } from "../trust-envelope.js";
import { RepoRootResolutionError } from "./errors.js";
import type { RepoRootResolver } from "./root-resolver.js";

/** What a health read needs besides the mount row. */
export interface RepoMountHealthSeams {
  readonly probePath: FilesystemPathProbeFn;
  readonly resolver: Pick<RepoRootResolver, "readRepositoryIdentity">;
}

/**
 * Probes one mount's health now. Only git's own answer that the root is no repository's top level
 * reads as `isRepository: false`; a git that could not answer throws `RepoRootResolutionError`
 * (`vcs_error`), which changes no verdict.
 */
export async function probeRepoMountHealth(
  mount: RepoMountHealthRow,
  seams: RepoMountHealthSeams,
): Promise<RepoMountHealth> {
  const probe = await seams.probePath(mount.canonicalRoot);
  if (!probe.reachable || mount.commonDirAnchor === null) {
    return computeRepoMountHealth(mount, probe, null);
  }
  const commonDir = await seams.resolver.readRepositoryIdentity(mount.canonicalRoot);
  if (commonDir === null) {
    return computeRepoMountHealth(mount, probe, { repository: "none" });
  }
  const isAnchored = componentsEqual(
    toComparableComponents(commonDir, nodePath),
    toComparableComponents(mount.commonDirAnchor, nodePath),
  );
  return computeRepoMountHealth(mount, probe, { repository: isAnchored ? "anchored" : "other" });
}

// The facts that make two verdicts the same; `checkedAt` changes on every probe.
function verdictOf(health: RepoMountHealth): string {
  return health.status === "identity_mismatch"
    ? `${health.status}:${String(health.isRepository)}`
    : health.status;
}

// A session no health change was ever logged for holds the verdict a session assumes.
const ASSUMED_VERDICT: string = "healthy";

// The health of the last change a session's log holds for a mount, as JSON text.
const SELECT_LAST_LOGGED_HEALTH_SQL = `SELECT json_extract(payload, '$.health') AS health
  FROM session_events
 WHERE session_id = @session_id AND type = 'repo.mount_health_changed'
   AND json_extract(payload, '$.repoMountId') = @repo_mount_id
 ORDER BY sequence DESC
 LIMIT 1`;

interface LoggedHealthRow {
  readonly health: string;
}

function verdictOfLogged(row: LoggedHealthRow | undefined): string {
  if (row === undefined) {
    return ASSUMED_VERDICT;
  }
  return verdictOf(RepoMountHealthSchema.parse(JSON.parse(row.health)));
}

interface AttachedMountRow {
  readonly id: string;
  readonly canonical_root: string;
  readonly common_dir: string | null;
}

interface MountCheckoutRow {
  readonly repo_mount_id: string;
  readonly checkout_root: string;
}

// What a probe that runs out of time reads as: `unreachable` at service start, before any verdict
// was sent, and no verdict after it.
type ProbeTimeoutReading = "unreachable" | "no_verdict";

// A mount's running pass and the one pass queued behind it.
interface MountPasses {
  readonly running: Promise<void>;
  queued: Promise<void> | undefined;
}

/** Constructor dependencies of {@link RepoMountHealthReprobe}. */
export interface RepoMountHealthReprobeDeps {
  /** The daemon database; the re-probe only reads it. */
  readonly database: DatabaseConnections;
  /** Where each changed verdict is appended, once per session on the mount. */
  readonly events: Pick<WorkspaceEventEmitter, "emitMountHealthChanged">;
  readonly resolver: Pick<RepoRootResolver, "readRepositoryIdentity">;
  /** Where a probe git could not answer is recorded. */
  readonly writeServiceLog: ServiceLogWriter;
  /** Reachability probe; defaults to the readability probe. */
  readonly probePath?: FilesystemPathProbeFn;
}

/**
 * Recomputes the health of attached mounts and sends `repo.mount_health_changed` to every session
 * on a mount whose verdict changed: every mount at service start
 * ({@link RepoMountHealthReprobe.startProbe}) and on wake ({@link RepoMountHealthReprobe.reprobe}),
 * only the mounts holding a folder that changed
 * ({@link RepoMountHealthReprobe.reprobeMountsContaining}).
 */
export class RepoMountHealthReprobe {
  readonly #events: Pick<WorkspaceEventEmitter, "emitMountHealthChanged">;
  readonly #seams: RepoMountHealthSeams;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #selectAttachedMountsStmt: Statement<[], AttachedMountRow>;
  readonly #selectAttachedMountStmt: Statement<{ repo_mount_id: string }, AttachedMountRow>;
  readonly #selectMountCheckoutsStmt: Statement<[], MountCheckoutRow>;
  readonly #selectSessionsOnMountStmt: Statement<
    { repo_mount_id: string },
    { readonly session_id: string }
  >;
  readonly #sentVerdicts = new Map<string, string>();
  readonly #selectLastLoggedHealthStmt: Statement<
    { session_id: string; repo_mount_id: string },
    LoggedHealthRow
  >;
  readonly #passesByMount = new Map<string, MountPasses>();
  // A probe that ran out of time, or that the stop left, runs on and cannot be stopped, so the
  // mount's next pass waits on it rather than start another beside it.
  readonly #probesInFlight = new Map<string, Promise<RepoMountHealth>>();
  // Aborted by the stop: a pass waiting on its probe ends at once, and no pass sends after it.
  readonly #stop = new AbortController();

  constructor(deps: RepoMountHealthReprobeDeps) {
    this.#events = deps.events;
    this.#seams = {
      probePath: deps.probePath ?? createDefaultPathProbe(),
      resolver: deps.resolver,
    };
    this.#writeServiceLog = deps.writeServiceLog;
    const reader = deps.database.reader;
    const attachedMountColumns = `SELECT id, canonical_root,
              json_extract(metadata, '${COMMON_DIR_METADATA_PATH}') AS common_dir
         FROM repo_mounts`;
    this.#selectAttachedMountsStmt = reader.prepare(
      `${attachedMountColumns} WHERE state = 'attached' ORDER BY id ASC`,
    );
    this.#selectAttachedMountStmt = reader.prepare(
      `${attachedMountColumns} WHERE id = @repo_mount_id AND state = 'attached'`,
    );
    // The checkouts the live workspaces on attached mounts work in.
    this.#selectMountCheckoutsStmt = reader.prepare(
      `SELECT DISTINCT workspace.repo_mount_id,
              json_extract(workspace.metadata, '${CHECKOUT_ROOT_METADATA_PATH}') AS checkout_root
         FROM workspaces AS workspace
         JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
        WHERE mount.state = 'attached' AND workspace.state <> 'archived'
          AND json_extract(workspace.metadata, '${CHECKOUT_ROOT_METADATA_PATH}') IS NOT NULL`,
    );
    this.#selectLastLoggedHealthStmt = reader.prepare<
      { session_id: string; repo_mount_id: string },
      LoggedHealthRow
    >(SELECT_LAST_LOGGED_HEALTH_SQL);
    this.#selectSessionsOnMountStmt = reader.prepare(
      `SELECT DISTINCT session_id
         FROM workspaces
        WHERE repo_mount_id = @repo_mount_id AND state <> 'archived'
        ORDER BY session_id ASC`,
    );
  }

  /**
   * Probes every attached mount at service start; a mount whose probe runs out of time reads
   * `unreachable`. Rejects as {@link reprobe} does.
   */
  async startProbe(): Promise<void> {
    await this.#probeEach(
      this.#selectAttachedMountsStmt.all().map((mount) => mount.id),
      "unreachable",
    );
  }

  /**
   * Re-probes every attached mount. Rejects with an `AggregateError` when any mount's change could
   * not be sent; that mount is sent again on its next pass.
   */
  async reprobe(): Promise<void> {
    const mounts = this.#selectAttachedMountsStmt.all();
    const attachedIds = new Set(mounts.map((mount) => mount.id));
    for (const mountId of this.#sentVerdicts.keys()) {
      if (!attachedIds.has(mountId)) {
        this.#sentVerdicts.delete(mountId);
      }
    }
    await this.#probeEach(
      mounts.map((mount) => mount.id),
      "no_verdict",
    );
  }

  /**
   * Re-probes only the attached mounts whose root, or a checkout a live workspace on it works in,
   * holds `folder`, an absolute symlink-resolved path as the stored roots are. Rejects as
   * {@link reprobe} does.
   */
  async reprobeMountsContaining(folder: string): Promise<void> {
    const folderComponents = toComparableComponents(folder, nodePath);
    const holds = (root: string): boolean =>
      isContainedWithin(folderComponents, toComparableComponents(root, nodePath));
    const mountIds = new Set<string>();
    for (const mount of this.#selectAttachedMountsStmt.all()) {
      if (holds(mount.canonical_root)) {
        mountIds.add(mount.id);
      }
    }
    for (const checkout of this.#selectMountCheckoutsStmt.all()) {
      if (holds(checkout.checkout_root)) {
        mountIds.add(checkout.repo_mount_id);
      }
    }
    await this.#probeEach([...mountIds], "no_verdict");
  }

  /**
   * Ends every pass: none starts after this, one waiting on its probe ends at once and leaves the
   * probe running unwatched, and one sending a change ends after that send. Settles once every pass
   * has ended, after which nothing is sent.
   */
  async stop(): Promise<void> {
    this.#stop.abort();
    // Each pass's failure already reached the call that requested it.
    await Promise.allSettled(
      [...this.#passesByMount.values()].flatMap((passes) =>
        passes.queued === undefined ? [passes.running] : [passes.running, passes.queued],
      ),
    );
  }

  async #probeEach(mountIds: readonly string[], onTimeout: ProbeTimeoutReading): Promise<void> {
    const outcomes = await mapWithProcessorBound(mountIds, async (mountId) => {
      try {
        await this.#requestPass(mountId, onTimeout);
        return null;
      } catch (error) {
        return { error };
      }
    });
    const failures = outcomes.flatMap((outcome) => (outcome === null ? [] : [outcome.error]));
    if (failures.length > 0) {
      throw new AggregateError(failures, "repo mount health re-probe could not send every change");
    }
  }

  // Starts the mount's pass, or joins the one queued behind its running pass.
  #requestPass(mountId: string, onTimeout: ProbeTimeoutReading): Promise<void> {
    const passes = this.#passesByMount.get(mountId);
    if (passes === undefined) {
      return this.#startPass(mountId, onTimeout);
    }
    const startQueuedPass = (): Promise<void> => this.#startPass(mountId, onTimeout);
    passes.queued ??= passes.running.then(startQueuedPass, startQueuedPass);
    return passes.queued;
  }

  // The mount's probe still running from an earlier pass, or a new one.
  #probeOnce(mountId: string, mountRow: RepoMountHealthRow): Promise<RepoMountHealth> {
    const inFlight = this.#probesInFlight.get(mountId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const probe = probeRepoMountHealth(mountRow, this.#seams);
    this.#probesInFlight.set(mountId, probe);
    const forget = (): void => {
      this.#probesInFlight.delete(mountId);
    };
    // The pass that awaits the probe receives its rejection; this branch only forgets it.
    void probe.then(forget, forget);
    return probe;
  }

  #startPass(mountId: string, onTimeout: ProbeTimeoutReading): Promise<void> {
    const running: Promise<void> = this.#probeMount(mountId, onTimeout).finally(() => {
      // A queued pass replaces this entry when it starts; with none, the mount goes idle.
      const passes = this.#passesByMount.get(mountId);
      if (passes?.running === running && passes.queued === undefined) {
        this.#passesByMount.delete(mountId);
      }
    });
    this.#passesByMount.set(mountId, { running, queued: undefined });
    return running;
  }

  async #probeMount(mountId: string, onTimeout: ProbeTimeoutReading): Promise<void> {
    if (this.#stop.signal.aborted) {
      return;
    }
    // Read at the pass, so a mount detached while the pass was queued is skipped.
    const mount = this.#selectAttachedMountStmt.get({ repo_mount_id: mountId });
    if (mount === undefined) {
      this.#sentVerdicts.delete(mountId);
      return;
    }
    const mountRow: RepoMountHealthRow = {
      canonicalRoot: mount.canonical_root,
      commonDirAnchor: mount.common_dir,
    };
    let health: RepoMountHealth;
    try {
      const probe = this.#probeOnce(mount.id, mountRow);
      if (await waitWithin(probe, DEFAULT_GIT_COMMAND_TIMEOUT_MS, this.#stop.signal)) {
        health = await probe;
      } else if (this.#stop.signal.aborted) {
        // The stop left the probe running unwatched.
        return;
      } else if (onTimeout === "no_verdict") {
        this.#writeServiceLog(
          `repo mount ${mount.id}: the health probe got no answer within ` +
            `${DEFAULT_GIT_COMMAND_TIMEOUT_MS} ms; its verdict is unchanged`,
        );
        return;
      } else {
        this.#writeServiceLog(
          `repo mount ${mount.id}: the health probe at start got no answer within ` +
            `${DEFAULT_GIT_COMMAND_TIMEOUT_MS} ms; it reads unreachable`,
        );
        health = computeRepoMountHealth(
          mountRow,
          {
            probedPath: mount.canonical_root,
            reachable: false,
            checkedAt: new Date().toISOString(),
          },
          null,
        );
      }
    } catch (error) {
      if (!(error instanceof RepoRootResolutionError)) {
        throw error;
      }
      // No answer is no verdict: the sessions keep the one they last heard.
      this.#writeServiceLog(
        `repo mount ${mount.id}: the health probe got no answer from git (${error.reason}); ` +
          "its verdict is unchanged",
      );
      return;
    }
    const verdict = verdictOf(health);
    const sentVerdict = this.#sentVerdicts.get(mount.id);
    if (verdict === sentVerdict) {
      return;
    }
    const repoMountId: RepoMountId = RepoMountIdSchema.parse(mount.id);
    for (const session of this.#selectSessionsOnMountStmt.all({ repo_mount_id: mount.id })) {
      // Cut short by the stop, the verdict stays unrecorded, as for a failed send.
      if (this.#stop.signal.aborted) {
        return;
      }
      // Before this run's first send, each session holds the verdict its log last told it.
      const heardVerdict =
        sentVerdict ??
        verdictOfLogged(
          this.#selectLastLoggedHealthStmt.get({
            session_id: session.session_id,
            repo_mount_id: mount.id,
          }),
        );
      if (verdict === heardVerdict) {
        continue;
      }
      await this.#events.emitMountHealthChanged({
        sessionId: SessionIdSchema.parse(session.session_id),
        repoMountId,
        health,
      });
    }
    // Recorded only once every session heard it, so a failed send is retried next pass.
    this.#sentVerdicts.set(mount.id, verdict);
  }
}
