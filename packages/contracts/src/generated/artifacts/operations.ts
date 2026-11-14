// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Listing a session's artifacts and reading one of them, and the refusal codes the artifact calls answer with.

import type { PlanId, PlanState } from "../plan.js";
import type { SessionId } from "../session/id.js";
import type { ArtifactId } from "./id.js";
import type { ArtifactManifest } from "./manifest.js";

/** Every refusal an artifact call answers with. */
export const ARTIFACT_REFUSAL_CODES = [
  "artifact.notFound",
  "artifact.tooLarge",
  "artifact.filePublishRefused",
  "artifact.idempotencyConflict",
  "artifact.ingest.capacityExhausted",
  "artifact.ingest.streamInvalid",
] as const;

/**
 * One artifact in a session's list: a plan the agent finished, with its first heading and the
 * state word its plan record holds, or a file or folder a chat wrote, with its path in the chat's
 * workspace and how many versions it has. Each carries its newest manifest; a folder's media type
 * is `inode/directory`.
 */
export type ArtifactListEntry =
  | {
      kind: "plan";
      /**
       * The plan's manifest.
       */
      manifest: ArtifactManifest;
      /**
       * The plan.
       */
      planId: PlanId;
      /**
       * The plan's first heading.
       */
      title: string;
      /**
       * The state word its plan record holds.
       */
      state: PlanState;
    }
  | {
      kind: "file";
      /**
       * The newest version's manifest.
       */
      manifest: ArtifactManifest;
      /**
       * Its path in the chat's workspace.
       */
      path: string;
      /**
       * How many versions it has; a folder's is 1.
       */
      versionCount: number;
    };
/**
 * How much of the payload a read returns: the handle only, the bytes when they fit in one message
 * (the handle otherwise, so a large payload is read window by window), or one window of `length`
 * bytes from `offset`, counted from 0. A window reaching past the payload's end answers the bytes
 * up to the end.
 */
export type ArtifactPayloadSelection =
  | {
      kind: "none";
    }
  | {
      kind: "whole";
    }
  | {
      kind: "range";
      /**
       * The window's first byte, from 0.
       */
      offset: number;
      /**
       * The window's length in bytes, at most one chunk.
       */
      length: number;
    };
/**
 * What a read answers: the manifest, plus either a handle to fetch the bytes with or the bytes. A
 * read whose payload would not fit one message gets the handle arm, a served answer rather than a
 * refusal.
 */
export type ArtifactReadResponse =
  | {
      /**
       * The manifest of the version in view; its `createdAt` is when that version was
       * written.
       */
      manifest: ArtifactManifest;
      /**
       * The version in view, from 1, oldest first; never above `versionCount`.
       */
      versionNumber: number;
      /**
       * How many versions exist; 1 for a plan and any artifact no chat wrote.
       */
      versionCount: number;
      /**
       * A picture's size; present only on a picture.
       */
      naturalSize?: ArtifactPictureSize;
      /**
       * A PDF's first page; present only on a PDF whose first page could be generated.
       */
      pdfPreview?: ArtifactPdfPreview;
      /**
       * The content-store key or address for the payload.
       */
      payloadHandle: string;
      /**
       * Absent: this arm carries no bytes.
       */
      payload?: never;
    }
  | {
      /**
       * The manifest of the version in view; its `createdAt` is when that version was
       * written.
       */
      manifest: ArtifactManifest;
      /**
       * The version in view, from 1, oldest first; never above `versionCount`.
       */
      versionNumber: number;
      /**
       * How many versions exist; 1 for a plan and any artifact no chat wrote.
       */
      versionCount: number;
      /**
       * A picture's size; present only on a picture.
       */
      naturalSize?: ArtifactPictureSize;
      /**
       * A PDF's first page; present only on a PDF whose first page could be generated.
       */
      pdfPreview?: ArtifactPdfPreview;
      /**
       * The content-store key or address for the payload; a reply may return both.
       */
      payloadHandle?: string;
      /**
       * The bytes.
       */
      payload: Uint8Array;
    };
/**
 * A refusal an artifact call answers with.
 */
export type ArtifactRefusalCode =
  | "artifact.notFound"
  | "artifact.tooLarge"
  | "artifact.filePublishRefused"
  | "artifact.idempotencyConflict"
  | "artifact.ingest.capacityExhausted"
  | "artifact.ingest.streamInvalid";
/**
 * Why an `artifact.ingest.streamInvalid` stream call cannot go on, carried as its `reason`.
 */
export type IngestStreamInvalidReason =
  | "unknownStream"
  | "sequenceBroken"
  | "lifetimeExpired"
  | "alreadyCompleted"
  | "completionRecordMismatch";
/**
 * Why an `artifact.tooLarge` refusal was raised, carried as its `reason`.
 */
export type ArtifactTooLargeReason = "volumeTooSmall" | "declaredSizeExceeded";

/**
 * Asks for the artifacts of one session.
 */
export interface ArtifactListRequest {
  /**
   * The session whose artifacts to list.
   */
  sessionId: SessionId;
}
/**
 * The session's artifacts.
 */
export interface ArtifactListResponse {
  /**
   * The artifacts, each with its newest manifest.
   */
  artifacts: ArtifactListEntry[];
}
/**
 * Asks for one artifact: its manifest, a handle, and as much of the payload as `payloadSelection`
 * picks. `version` counts from 1, oldest first; without it the read answers the newest.
 */
export interface ArtifactReadRequest {
  /**
   * The artifact to read.
   */
  artifactId: ArtifactId;
  /**
   * The version to read, from 1; absent for the newest.
   */
  version?: number;
  /**
   * How much of the payload to answer.
   */
  payloadSelection: ArtifactPayloadSelection;
}
/**
 * A picture's width and height in pixels, read from its header when its bytes were stored, its
 * orientation applied, so it is the size the picture is drawn at.
 */
export interface ArtifactPictureSize {
  /**
   * The width in pixels.
   */
  width: number;
  /**
   * The height in pixels.
   */
  height: number;
}
/**
 * A PDF's first page, generated at ingest and stored as an artifact of its own, and how many
 * pages the PDF has.
 */
export interface ArtifactPdfPreview {
  /**
   * The artifact holding the first page.
   */
  firstPageArtifactId: ArtifactId;
  /**
   * How many pages the PDF has.
   */
  pageCount: number;
}

export {
  validateArtifactListEntry,
  validateArtifactListRequest,
  validateArtifactListResponse,
  validateArtifactPayloadSelection,
  validateArtifactPdfPreview,
  validateArtifactPictureSize,
  validateArtifactReadRequest,
  validateArtifactReadResponse,
} from "../checks/artifacts/operations.js";
