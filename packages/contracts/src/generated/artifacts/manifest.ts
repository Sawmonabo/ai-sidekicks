// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The manifest the daemon keeps for every artifact in a session, and the closed set of its kinds.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";
import type { DeviceId } from "../trust-statement.js";
import type { ArtifactId } from "./id.js";

/**
 * The kind of an artifact: a file, a diff, a summary, a log, a design, or the output of one
 * workflow phase.
 */
export type ArtifactType = "file" | "diff" | "summary" | "log" | "design" | "workflowOutput";

/**
 * One artifact as the daemon records it: `id` names the manifest and `digest` the content, so two
 * manifests can share one payload. `metadata` is the artifact's freeform provenance and holds its
 * file name and media type. A member a newer daemon adds is kept in `rest`.
 */
export interface ArtifactManifest {
  /**
   * The manifest's id.
   */
  id: ArtifactId;
  /**
   * The session the artifact belongs to.
   */
  sessionId: SessionId;
  /**
   * The run that produced the artifact; absent when no run did.
   */
  runId?: RunId;
  /**
   * The device the publishing request came from; absent when the daemon produced it itself.
   */
  createdBy?: DeviceId;
  /**
   * The artifact's kind.
   */
  artifactType: ArtifactType | string;
  /**
   * The payload's SHA-256 digest; a content-addressed manifest always has one.
   */
  digest: string;
  /**
   * The payload's length in bytes, measured by the daemon rather than declared by the caller.
   */
  size: number;
  /**
   * The artifact's freeform provenance.
   */
  metadata: {
    [k: string]: unknown | undefined;
  };
  /**
   * When the manifest was written.
   */
  createdAt: WireInstant;
  [k: string]: unknown | undefined;
}
