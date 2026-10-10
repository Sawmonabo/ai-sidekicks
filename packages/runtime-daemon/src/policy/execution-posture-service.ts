// A run's execution posture from its request to its `run.running` stamp, and the one curated
// credential deny list every provider process is handed. The posture is checked and its writable
// roots resolved before the provider starts the run; a posture that fails a check refuses the run
// and is never rewritten into one that passes.

import { realpath } from "node:fs/promises";
import path from "node:path";

import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import type {
  RunSetupContext,
  RunSetupGate,
  RunTerminalContext,
} from "../session/run/setup-gates.js";

/** The reference every run's posture carries; it names the daemon's one curated credential list. */
export const CURATED_CREDENTIAL_POLICY_REF = "curated-credentials";

// Relative to the person's home; resolved to canonical absolute paths on each read.
const CURATED_CREDENTIAL_DENY_PATHS: readonly string[] = Object.freeze([".ssh", ".aws"]);

/**
 * The credential variables removed from every provider process's environment and from every
 * Codex conversation's command environment, compared under the host's environment-name rule.
 */
export const CURATED_CREDENTIAL_ENV_VARS: readonly string[] = Object.freeze([
  "GITHUB_TOKEN",
  "NPM_TOKEN",
]);

/**
 * The curated list as it resolves on this machine. Each driver hands `denyPaths` to its provider
 * in the provider's own form; the spawn-environment builder strips `denyEnvVars` itself.
 */
export interface ResolvedCredentialPolicy {
  readonly credentialPolicyRef: string;
  /**
   * Canonical absolute paths, symlinks resolved where the path exists; a path missing on this
   * machine keeps its expanded absolute form. A folder's entry covers everything under it.
   */
  readonly denyPaths: readonly string[];
  readonly denyEnvVars: readonly string[];
}

/** Why a posture was refused. */
export type ExecutionPostureRejection =
  | "unknown_credential_policy"
  | "readonly_writable_roots"
  | "yolo_writable_roots"
  | "relative_writable_root"
  | "unresolvable_writable_root";

/** A posture that fails a check; the run it belongs to is refused, never started on a rewrite. */
export class ExecutionPostureRejectedError extends Error {
  readonly reason: ExecutionPostureRejection;

  constructor(reason: ExecutionPostureRejection, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionPostureRejectedError";
    this.reason = reason;
  }
}

/** What the service resolves paths against. */
export interface ExecutionPostureServiceDeps {
  /** The person's home folder, which the curated paths are relative to. */
  readonly homeDirectory: string;
}

/**
 * Checks and resolves every run's posture as a run setup gate, keeps the resolved posture for the
 * run's `run.running` stamp until the run ends, and resolves the curated credential list.
 */
export class ExecutionPostureService implements RunSetupGate {
  readonly #homeDirectory: string;
  // One entry per run past its gate and not yet ended.
  readonly #resolvedByRun = new Map<RunId, ExecutionPosture>();

  constructor(deps: ExecutionPostureServiceDeps) {
    this.#homeDirectory = deps.homeDirectory;
  }

  /**
   * The posture with every writable root resolved to its canonical path. Throws
   * {@link ExecutionPostureRejectedError} for a reference to any list but the curated one, a
   * `readonly` or `yolo` posture with writable roots, or a root that is relative or does not
   * resolve.
   */
  async resolvePosture(posture: ExecutionPosture): Promise<ExecutionPosture> {
    requireCuratedPolicyRef(posture.credentialPolicyRef);
    // `yolo` with no roots means no enforced limit and `readonly` with none means nothing
    // writable, so a root under either would record a boundary nothing enforces.
    if (posture.mode === "readonly" && posture.writableRoots.length > 0) {
      throw new ExecutionPostureRejectedError(
        "readonly_writable_roots",
        "A read-only posture must carry no writable roots.",
      );
    }
    if (posture.mode === "yolo" && posture.writableRoots.length > 0) {
      throw new ExecutionPostureRejectedError(
        "yolo_writable_roots",
        "A YOLO posture must carry no writable roots.",
      );
    }
    const writableRoots = await Promise.all(posture.writableRoots.map(canonicalWritableRoot));
    return { mode: posture.mode, writableRoots, credentialPolicyRef: posture.credentialPolicyRef };
  }

  /**
   * The curated list `credentialPolicyRef` names, resolved now so a moved symlink is followed.
   * Throws {@link ExecutionPostureRejectedError} for any other reference, and rethrows a path read
   * that fails for any reason but the path being absent.
   */
  async resolveCredentialPolicy(credentialPolicyRef: string): Promise<ResolvedCredentialPolicy> {
    requireCuratedPolicyRef(credentialPolicyRef);
    const denyPaths = await Promise.all(
      CURATED_CREDENTIAL_DENY_PATHS.map((entry) => this.#canonicalDenyPath(entry)),
    );
    return { credentialPolicyRef, denyPaths, denyEnvVars: CURATED_CREDENTIAL_ENV_VARS };
  }

  /**
   * Resolves the posture the run was requested with and keeps it for {@link resolvedPostureFor};
   * a rejection ends the run `failed` before its provider starts it.
   */
  async assertRunReady(context: RunSetupContext): Promise<void> {
    this.#resolvedByRun.set(context.runId, await this.resolvePosture(context.executionPosture));
  }

  /** Forgets the run's resolved posture once the run has ended. */
  onRunTerminal(context: RunTerminalContext): Promise<void> {
    this.#resolvedByRun.delete(context.runId);
    return Promise.resolve();
  }

  /**
   * The complete resolved posture of a run past its gate and not yet ended, `undefined` for any
   * other run; the run engine hands it to the driver and stamps it on `run.running`, and a start
   * that finds `undefined` ends its run `failed`.
   */
  resolvedPostureFor(runId: RunId): ExecutionPosture | undefined {
    return this.#resolvedByRun.get(runId);
  }

  async #canonicalDenyPath(homeRelativePath: string): Promise<string> {
    const expanded = path.join(this.#homeDirectory, homeRelativePath);
    try {
      return await realpath(expanded);
    } catch (error) {
      // An absent path has no link to follow; it is still denied should it appear later.
      if (isErrorWithCode(error, "ENOENT")) {
        return expanded;
      }
      throw error;
    }
  }
}

function requireCuratedPolicyRef(credentialPolicyRef: string): void {
  if (credentialPolicyRef !== CURATED_CREDENTIAL_POLICY_REF) {
    throw new ExecutionPostureRejectedError(
      "unknown_credential_policy",
      `The posture names credential policy '${credentialPolicyRef}', which is not the daemon's ` +
        `curated list '${CURATED_CREDENTIAL_POLICY_REF}'.`,
    );
  }
}

async function canonicalWritableRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root)) {
    throw new ExecutionPostureRejectedError(
      "relative_writable_root",
      `The writable root '${root}' is not an absolute path.`,
    );
  }
  try {
    return await realpath(root);
  } catch (error) {
    throw new ExecutionPostureRejectedError(
      "unresolvable_writable_root",
      `The writable root '${root}' could not be resolved.`,
      { cause: error },
    );
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
