// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The composer's daemon-held store for one session: the unsent draft with what rides with its words, the staged files, covering part of a staged picture, and the refusals staging can answer with.

import type { SchemaCheck } from "../../schema-check.js";
import type { AttachmentReferenceList } from "../artifacts/attachment-reference.js";
import type { ArtifactId } from "../artifacts/id.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import {
  validateHeldSessionDraft,
  validateSessionAttachmentAddRequest,
  validateSessionAttachmentAddResponse,
  validateSessionAttachmentCoverRequest,
  validateSessionAttachmentCoverResponse,
  validateSessionAttachmentRemoveRequest,
  validateSessionAttachmentRemoveResponse,
  validateSessionDraftSubscribeRequest,
  validateSessionDraftUpdateRequest,
  validateSessionDraftUpdateResponse,
} from "../checks/session/draft.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { WorkspaceId } from "../repo/mount.js";
import type { QueuedSkillPick } from "../run/queue.js";
import type { SessionId } from "./id.js";

/** A draft save carrying a revision that is no longer the draft's current one. */
export const SESSION_DRAFT_REVISION_STALE_CODE = "session.draft.revisionStale" as const;

/** The code for a file the session cannot stage. */
export const SESSION_ATTACHMENT_REFUSED_CODE = "session.attachment.refused" as const;

/**
 * One thing to stage: a file picked, dropped or pasted, by its path, or a resource a tool server
 * publishes. A path reaches the daemon only from the main process or the command line; a
 * resource's address names it on its server and is never read as a path.
 */
export type SessionAttachmentItem =
  | {
      kind: "file";
      /**
       * The client's id for this one item, so a retried stage never stages it twice.
       */
      clientStagingId: string;
      /**
       * The file's path.
       */
      path: string;
    }
  | {
      kind: "mcpResource";
      /**
       * The client's id for this one item, so a retried stage never stages it twice.
       */
      clientStagingId: string;
      /**
       * The session's name for the server.
       */
      serverName: string;
      /**
       * The resource's own address on the server.
       */
      uri: string;
    };
/**
 * Why the session would not stage a file, by a rule of its own.
 */
export type SessionAttachmentLimitReason =
  | "countLimit"
  | "folder"
  | "providerTakesNoAttachments"
  | "cardWaiting";
/**
 * Why one item was not staged: a session rule, the provider's refusal with its words, a failed
 * copy with the daemon's cause, a disk too full with the room it has, or the ingest being busy.
 */
export type SessionAttachmentRefusalCause =
  | {
      /**
       * Always `session.attachment.refused`.
       */
      code: "session.attachment.refused";
      /**
       * The rule.
       */
      reason: SessionAttachmentLimitReason;
    }
  | {
      /**
       * Always `session.attachment.refused`.
       */
      code: "session.attachment.refused";
      /**
       * Always `providerRefused`.
       */
      reason: "providerRefused";
      /**
       * The provider's own words, shown as given.
       */
      providerMessage: string;
    }
  | {
      /**
       * Always `session.attachment.refused`.
       */
      code: "session.attachment.refused";
      /**
       * Always `copyFailed`.
       */
      reason: "copyFailed";
      /**
       * The daemon's own cause, the text after `·` on the refusal line.
       */
      detail: string;
    }
  | {
      /**
       * Always `artifact.tooLarge`.
       */
      code: "artifact.tooLarge";
      /**
       * The room the disk has, in bytes.
       */
      availableBytes: number;
    }
  | {
      /**
       * Always `artifact.ingest.capacityExhausted`.
       */
      code: "artifact.ingest.capacityExhausted";
    };

/**
 * What rides with a draft's words, in the shapes a send carries them: the files, the skill picks,
 * the output speed of its turn and the repository its run binds to. A message a Stop or an
 * interrupt returns to the composer brings its own here, so it is sent again whole.
 */
export interface SessionDraftExtras {
  /**
   * The files, in staging order, by artifact id. A returned message's files stay here as the
   * artifacts they are and go out as the next send's `attachments`.
   */
  attachments?: AttachmentReferenceList;
  /**
   * The skills picked, in the order picked.
   */
  skills?: QueuedSkillPick[];
  /**
   * The output-speed level its turn alone runs at.
   */
  outputSpeedForTurn?: string;
  /**
   * The repository the run its send starts binds to.
   */
  workspaceId?: WorkspaceId;
}
/**
 * A session's unsent draft, whole: the words and what rides with them. A draft the person saved
 * and one a Stop or an interrupt returned read the same. The text has no length limit of its own:
 * a message's limit is the send's to state, so a draft the send would take is never refused here.
 */
export interface SessionDraft {
  /**
   * The words; empty when none are typed.
   */
  text: string;
  /**
   * What rides with the words.
   */
  extras: SessionDraftExtras;
}
/**
 * Saves a session's draft. `draft` is the whole draft and replaces the one held; an empty draft,
 * no words and no extras, clears it, which is what Send does. A save over a draft that changed
 * since `expectedRevision` is refused rather than overwriting it.
 */
export interface SessionDraftUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The whole draft; an empty one clears it.
   */
  draft: SessionDraft;
  /**
   * The draft revision the save was typed over; 0 when no draft was ever held.
   */
  expectedRevision: number;
}
/**
 * The draft's new revision and when the daemon stored it.
 */
export interface SessionDraftUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The draft's new revision.
   */
  revision: number;
  /**
   * When the draft was stored.
   */
  updatedAt: WireInstant;
}
/**
 * `session.draft.subscribe`: follows a session's draft, the draft held now and again after each
 * change.
 */
export interface SessionDraftSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * A session's draft as the daemon holds it, with its revision: an empty draft at revision 0
 * before any draft was held.
 */
export interface HeldSessionDraft {
  /**
   * The draft, whole.
   */
  draft: SessionDraft;
  /**
   * Its revision.
   */
  revision: number;
}
/**
 * One staged file as the daemon holds it. Every member is what the daemon found in the bytes it
 * copied, never what the caller declared: the name it stored the file under, the media type it
 * read from the bytes, and the size it measured.
 */
export interface SessionAttachmentSummary {
  /**
   * The staged file's artifact.
   */
  artifactId: ArtifactId;
  /**
   * The name the daemon stored it under.
   */
  fileName: string;
  /**
   * The media type read from its bytes.
   */
  mimeType: string;
  /**
   * Its size in bytes, as measured.
   */
  sizeBytes: number;
}
/**
 * Stages files for the next message. The count is not limited here: a pick over the message's
 * limit stages as many as fit and refuses each of the rest by name; an empty list is refused.
 */
export interface SessionAttachmentAddRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The things to stage; at least one.
   *
   * @minItems 1
   */
  items: [SessionAttachmentItem, ...SessionAttachmentItem[]];
}
/**
 * One item the daemon did not stage, by the name the refusal line shows.
 */
export interface SessionAttachmentRefusal {
  /**
   * The client's id for the item.
   */
  clientStagingId: string;
  /**
   * The name the refusal line shows.
   */
  name: string;
  /**
   * Why it was not staged.
   */
  cause: SessionAttachmentRefusalCause;
}
/**
 * The whole staged set after the add, so a client draws what the daemon holds rather than merging
 * its own add, and each item it did not stage with the cause.
 */
export interface SessionAttachmentAddResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The staged set.
   */
  attachments: SessionAttachmentSummary[];
  /**
   * The items not staged.
   */
  refused: SessionAttachmentRefusal[];
}
/**
 * Unstages one file. The artifact itself keeps its own life; only its place in the staged set
 * goes. Removing a file that is no longer staged answers with the set as it is.
 */
export interface SessionAttachmentRemoveRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The staged file's artifact.
   */
  artifactId: ArtifactId;
}
/**
 * The whole staged set left after the removal.
 */
export interface SessionAttachmentRemoveResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The staged set.
   */
  attachments: SessionAttachmentSummary[];
}
/**
 * One box to cover, in the picture's own pixels from its top-left corner; never empty.
 */
export interface SessionAttachmentCoverBox {
  /**
   * The left edge.
   */
  x: number;
  /**
   * The top edge.
   */
  y: number;
  /**
   * The width; at least one.
   */
  width: number;
  /**
   * The height; at least one.
   */
  height: number;
}
/**
 * Covers parts of a staged picture before Send. The daemon draws the boxes into the pixels, stores
 * the covered copy as a new artifact that takes the old one's place in the staged set, and deletes
 * the uncovered copy, so the provider only ever receives the covered picture. A picture already
 * sent cannot be covered; an empty box list is refused.
 */
export interface SessionAttachmentCoverRequest {
  /**
   * The staged picture.
   */
  attachmentId: ArtifactId;
  /**
   * The boxes to cover; at least one.
   *
   * @minItems 1
   */
  boxes: [SessionAttachmentCoverBox, ...SessionAttachmentCoverBox[]];
}
/**
 * The covered copy, which is now the staged attachment.
 */
export interface SessionAttachmentCoverResponse {
  /**
   * The covered copy.
   */
  attachment: SessionAttachmentSummary;
}

export {
  validateHeldSessionDraft,
  validateSessionAttachmentAddRequest,
  validateSessionAttachmentAddResponse,
  validateSessionAttachmentCoverBox,
  validateSessionAttachmentCoverRequest,
  validateSessionAttachmentCoverResponse,
  validateSessionAttachmentItem,
  validateSessionAttachmentLimitReason,
  validateSessionAttachmentRefusal,
  validateSessionAttachmentRefusalCause,
  validateSessionAttachmentRemoveRequest,
  validateSessionAttachmentRemoveResponse,
  validateSessionAttachmentSummary,
  validateSessionDraft,
  validateSessionDraftExtras,
  validateSessionDraftSubscribeRequest,
  validateSessionDraftUpdateRequest,
  validateSessionDraftUpdateResponse,
} from "../checks/session/draft.js";

/** The methods of {@link SESSION_DRAFT_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionDraftMethodDescriptors {
  readonly "session.draft.update": {
    readonly method: "session.draft.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionDraftUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionDraftUpdateResponse>;
  };
  readonly "session.draft.subscribe": {
    readonly method: "session.draft.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionDraftSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<HeldSessionDraft>;
  };
  readonly "session.attachment.add": {
    readonly method: "session.attachment.add";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAttachmentAddRequest>;
    readonly responseCheck: SchemaCheck<SessionAttachmentAddResponse>;
  };
  readonly "session.attachment.remove": {
    readonly method: "session.attachment.remove";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAttachmentRemoveRequest>;
    readonly responseCheck: SchemaCheck<SessionAttachmentRemoveResponse>;
  };
  readonly "session.attachment.cover": {
    readonly method: "session.attachment.cover";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionAttachmentCoverRequest>;
    readonly responseCheck: SchemaCheck<SessionAttachmentCoverResponse>;
  };
}
/** The composer store's methods, each with its types. */
export const SESSION_DRAFT_METHOD_DESCRIPTORS: SessionDraftMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.draft.update": /* @__PURE__ */ Object.freeze({
      method: "session.draft.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionDraftUpdateRequest,
      responseCheck: validateSessionDraftUpdateResponse,
    }),
    "session.draft.subscribe": /* @__PURE__ */ Object.freeze({
      method: "session.draft.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateSessionDraftSubscribeRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateHeldSessionDraft,
    }),
    "session.attachment.add": /* @__PURE__ */ Object.freeze({
      method: "session.attachment.add",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionAttachmentAddRequest,
      responseCheck: validateSessionAttachmentAddResponse,
    }),
    "session.attachment.remove": /* @__PURE__ */ Object.freeze({
      method: "session.attachment.remove",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionAttachmentRemoveRequest,
      responseCheck: validateSessionAttachmentRemoveResponse,
    }),
    "session.attachment.cover": /* @__PURE__ */ Object.freeze({
      method: "session.attachment.cover",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionAttachmentCoverRequest,
      responseCheck: validateSessionAttachmentCoverResponse,
    }),
  });
