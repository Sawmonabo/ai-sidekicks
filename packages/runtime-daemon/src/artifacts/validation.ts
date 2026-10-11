// The ordered pipeline every caller-supplied payload runs before anything of it is kept: the type
// is read from the payload's own leading bytes, then the payload is moved into the
// content-addressed store under its SHA-256, which is the pipeline's last act. A payload refused on
// the way never reaches the store and leaves no row. No file is refused for its type and none is
// rewritten; the type read decides only what the manifest records and whether a picture goes to a
// provider as one.
//
// - The type is read on a thread of its own under a time bound, so a parser that never returns
//   fails its payload, never the daemon. Only the detector refusing the bytes refuses them for
//   good; a check that could not run to an answer is sent again.
// - Bytes whose signature names no type are recorded as text when they are valid UTF-8: as the
//   text type the caller declared, or as plain text when it declared none; anything else is
//   recorded as an unknown binary.
// - The caller's file name is kept as metadata only, bounded in length and characters; the stored
//   payload's path is derived from its digest, so no caller's string is ever part of a path.

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts/free-form-string";

import { useThenClose } from "../disk-flush.js";
import { cutToCodeUnits } from "../text-cut.js";
import { DetectorRejectedBytesError, type MediaTypeDetector } from "./detection/thread.js";
import type { PayloadStore } from "./payload-store.js";
import { ArtifactTypeCheckUnavailableError, ArtifactTypeUnreadableError } from "./refusals.js";

// The media type recorded for bytes that are neither a known signature nor UTF-8 text.
const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

// The media type recorded for UTF-8 text the caller declared no text type for.
const PLAIN_TEXT_MEDIA_TYPE = "text/plain";

// The declared types kept for UTF-8 text: every `text/` type, and two text formats filed elsewhere.
const TEXT_MEDIA_TYPE_PREFIX = "text/";
const TEXT_MEDIA_TYPES_OUTSIDE_TEXT: ReadonlySet<string> = new Set([
  "application/json",
  "image/svg+xml",
]);

// The detector's own sample size: the leading bytes most signatures it knows sit within. Only
// these are handed to it, so it never reads into an archive's interior.
const DETECTION_PREFIX_BYTES = 4100;

// The name kept when nothing of the caller's is left once its invisible characters are taken out.
const FALLBACK_FILE_NAME = "attachment";

// Control and format characters: NUL among the first, the bidirectional overrides among the second.
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** A payload spooled to a file, with the digest counted as it was written. */
export interface SpooledPayload {
  readonly spoolPath: string;
  /** `sha256:<hex>` of the spooled bytes. */
  readonly contentHash: string;
  /** The ingested file's normalized name, which a refusal names; a publish carries none. */
  readonly fileName?: string | undefined;
  /** The type the caller declared, kept only for UTF-8 text whose signature names no type. */
  readonly declaredMediaType?: string | undefined;
}

/** What the pipeline settled for an admitted payload. */
export interface AdmittedPayload<Recorded> {
  readonly derivedMediaType: string;
  /** What the reference recorded inside the store's exclusion resolved with. */
  readonly recorded: Recorded;
}

/** What the pipeline reads with and stores into. */
export interface IngestValidationDeps {
  readonly payloadStore: Pick<PayloadStore, "admit">;
  /** Reads a payload's type from its leading bytes; the daemon's runs each call on a thread. */
  readonly detectMediaType: MediaTypeDetector;
}

/** The ingest validation pipeline over one spooled payload. */
export class IngestValidation {
  readonly #payloadStore: Pick<PayloadStore, "admit">;
  readonly #detectMediaType: MediaTypeDetector;

  constructor(deps: IngestValidationDeps) {
    this.#payloadStore = deps.payloadStore;
    this.#detectMediaType = deps.detectMediaType;
  }

  /**
   * Runs the pipeline over `payload`: reads its type, then moves it into the store and runs
   * `recordReference` with that type inside the store's exclusion. Rejects with
   * `artifact.type_unreadable` when the detector refused the bytes and with
   * `artifact.type_check_unavailable` when the check could not run to an answer, either leaving the
   * spool where it was and nothing in the store, and otherwise with the step that failed.
   */
  async run<Recorded>(
    payload: SpooledPayload,
    recordReference: (derivedMediaType: string) => Promise<Recorded>,
  ): Promise<AdmittedPayload<Recorded>> {
    const leadingBytes = await readLeadingBytes(payload.spoolPath);
    let detectedMediaType: string | undefined;
    try {
      detectedMediaType = await this.#detectMediaType(leadingBytes);
    } catch (error) {
      throw error instanceof DetectorRejectedBytesError
        ? new ArtifactTypeUnreadableError(payload.fileName, error)
        : new ArtifactTypeCheckUnavailableError(payload.fileName, error);
    }
    const derivedMediaType =
      detectedMediaType ??
      ((await isUtf8File(payload.spoolPath))
        ? textMediaTypeOf(payload.declaredMediaType)
        : UNKNOWN_MEDIA_TYPE);
    const recorded = await this.#payloadStore.admit(payload.spoolPath, payload.contentHash, () =>
      recordReference(derivedMediaType),
    );
    return { derivedMediaType, recorded };
  }
}

/**
 * A caller's file name as the manifest keeps it: its last path segment, without control or format
 * characters, in Unicode NFC, trimmed and cut to the wire's path bound. A name with nothing left
 * is kept as `attachment`.
 */
export function normalizeFileName(fileName: string): string {
  const lastSegment = fileName.split(/[/\\]/u).findLast((segment) => segment.trim() !== "") ?? "";
  const normalized = cutToCodeUnits(
    lastSegment.replace(INVISIBLE_CHARACTERS, "").normalize("NFC").trim(),
    FILE_PATH_MAX_LEN,
  );
  return normalized === "" ? FALLBACK_FILE_NAME : normalized;
}

// The declared type's essence when it names text, otherwise plain text.
function textMediaTypeOf(declaredMediaType: string | undefined): string {
  const essence = declaredMediaType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    essence !== undefined &&
    (essence.startsWith(TEXT_MEDIA_TYPE_PREFIX) || TEXT_MEDIA_TYPES_OUTSIDE_TEXT.has(essence))
  ) {
    return essence;
  }
  return PLAIN_TEXT_MEDIA_TYPE;
}

// Whether the whole spool is valid UTF-8, read a block at a time so a large file is never held.
async function isUtf8File(spoolPath: string): Promise<boolean> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const block of createReadStream(spoolPath)) {
      decoder.decode(block as Buffer, { stream: true });
    }
    decoder.decode();
  } catch (error) {
    if (
      error instanceof TypeError &&
      "code" in error &&
      error.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
    ) {
      return false;
    }
    throw error;
  }
  return true;
}

// The spool's first DETECTION_PREFIX_BYTES bytes, fewer when it is shorter.
async function readLeadingBytes(spoolPath: string): Promise<Uint8Array> {
  const file = await open(spoolPath, "r");
  let leadingBytes: Uint8Array = new Uint8Array();
  await useThenClose(
    file,
    async () => {
      const { buffer, bytesRead } = await file.read(
        Buffer.alloc(DETECTION_PREFIX_BYTES),
        0,
        DETECTION_PREFIX_BYTES,
        0,
      );
      leadingBytes = buffer.subarray(0, bytesRead);
    },
    "reading the spool's leading bytes",
  );
  return leadingBytes;
}
