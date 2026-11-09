// The composer's file staging over the daemon: each file picked, dropped or pasted goes out as one
// `session.attachment.add` item under the token main minted for its path, and the staged set the
// daemon answers with replaces the held draft's files. A file still copying shows as pending, and
// the held draft holds the next send until the copy settles. A file the daemon would not stage
// becomes one refusal line naming it and the daemon's cause; a failed copy can be copied again.

import type {
  SessionAttachmentAddResponse,
  SessionAttachmentRefusalCause,
  SessionAttachmentRemoveResponse,
} from "@ai-sidekicks/contracts/session/draft";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

import { codeWords } from "#renderer/lib/code-words.js";
import { Emitter } from "#renderer/lib/emitter.js";
import type { DaemonReply } from "#renderer/services/daemon/reply.js";
import type { FilePathRef } from "#shared/preload-api.js";
import type { ComposerHeldDraft } from "../held-draft/holder.js";

/** One file offered for staging: main's token for its path and the name a chip draws. */
export interface OfferedFile {
  readonly ref: FilePathRef;
  readonly name: string;
}

/** A file whose copy to the daemon has not answered yet. */
export interface PendingCopy {
  readonly clientStagingId: string;
  readonly name: string;
}

/** One file the daemon would not stage: its name, the cause in words, and whether it can retry. */
export interface StagingRefusalLine {
  readonly clientStagingId: string;
  readonly name: string;
  readonly cause: string;
  /** The file to copy again, present only for a copy that failed. */
  readonly retry: OfferedFile | undefined;
}

/** What the strip draws beside the staged files. */
export interface ComposerStagingSnapshot {
  readonly pending: readonly PendingCopy[];
  readonly refusals: readonly StagingRefusalLine[];
}

/** The two daemon calls staging makes, each answering a checked reply and never rejecting. */
export interface StagingCalls {
  readonly add: (
    items: readonly [StagingItem, ...StagingItem[]],
  ) => Promise<DaemonReply<SessionAttachmentAddResponse>>;
  readonly remove: (
    artifactId: ArtifactId,
  ) => Promise<DaemonReply<SessionAttachmentRemoveResponse>>;
}

/** One file as a stage call carries it: the client's id for it and main's token for its path. */
export interface StagingItem {
  readonly clientStagingId: string;
  readonly path: FilePathRef;
}

/** Nothing copying and nothing refused. */
export const NOTHING_STAGING: ComposerStagingSnapshot = { pending: [], refusals: [] };

/** One session's file staging, publishing what is copying and what was refused. */
export class ComposerStaging {
  readonly #calls: StagingCalls;
  readonly #heldDraft: ComposerHeldDraft;
  readonly #newStagingId: () => string;
  readonly #changes = new Emitter<void>("composer staging");
  #snapshot: ComposerStagingSnapshot = NOTHING_STAGING;

  /** The staging as it stands. Stable between changes. */
  public snapshot = (): ComposerStagingSnapshot => this.#snapshot;

  /** Watch the staging. */
  public subscribe = (listener: () => void): (() => void) => this.#changes.subscribe(listener);

  public constructor(
    calls: StagingCalls,
    heldDraft: ComposerHeldDraft,
    newStagingId: () => string,
  ) {
    this.#calls = calls;
    this.#heldDraft = heldDraft;
    this.#newStagingId = newStagingId;
  }

  /** Stage `files` in one call; the refusal lines an earlier stage left give way. */
  public stage(files: readonly OfferedFile[]): void {
    const items = files.map((file) => ({ file, clientStagingId: this.#newStagingId() }));
    const [first, ...rest] = items;
    if (first === undefined) {
      return;
    }
    this.#publish({
      pending: [
        ...this.#snapshot.pending,
        ...items.map((item) => ({ clientStagingId: item.clientStagingId, name: item.file.name })),
      ],
      refusals: [],
    });
    const toItem = (item: (typeof items)[number]): StagingItem => ({
      clientStagingId: item.clientStagingId,
      path: item.file.ref,
    });
    const copy = this.#calls.add([toItem(first), ...rest.map(toItem)]).then((reply) => {
      this.#settle(items, reply);
    });
    this.#heldDraft.trackCopy(copy);
  }

  /** Name a file that never reached the daemon, with why, on its own refusal line. */
  public refuseOffer(name: string, cause: string): void {
    this.#publish({
      ...this.#snapshot,
      refusals: [
        ...this.#snapshot.refusals,
        { clientStagingId: crypto.randomUUID(), name, cause, retry: undefined },
      ],
    });
  }

  /** Copy again the file a failed copy's refusal line names. */
  public retry(clientStagingId: string): void {
    const line = this.#snapshot.refusals.find((each) => each.clientStagingId === clientStagingId);
    if (line?.retry === undefined) {
      return;
    }
    const others = this.#snapshot.refusals.filter((each) => each !== line);
    this.stage([line.retry]);
    this.#publish({ ...this.#snapshot, refusals: others });
  }

  /** Take one staged file off the next message. */
  public unstage(artifactId: ArtifactId): void {
    void this.#calls.remove(artifactId).then((reply) => {
      if (reply.status === "served") {
        this.#heldDraft.setStagedFiles(reply.value.attachments);
      } else {
        const file = this.#heldDraft
          .snapshot()
          .files.find((each) => each.artifactId === artifactId);
        this.#publish({
          ...this.#snapshot,
          refusals: [
            ...this.#snapshot.refusals,
            {
              clientStagingId: artifactId,
              name: file?.fileName ?? artifactId,
              cause: reply.refusal.detail,
              retry: undefined,
            },
          ],
        });
      }
    });
  }

  #settle(
    items: readonly { readonly file: OfferedFile; readonly clientStagingId: string }[],
    reply: DaemonReply<SessionAttachmentAddResponse>,
  ): void {
    const settledIds = new Set(items.map((item) => item.clientStagingId));
    const pending = this.#snapshot.pending.filter((each) => !settledIds.has(each.clientStagingId));
    if (reply.status === "refused") {
      // The whole call was refused: every file it carried is named with the daemon's words.
      this.#publish({
        pending,
        refusals: [
          ...this.#snapshot.refusals,
          ...items.map((item) => ({
            clientStagingId: item.clientStagingId,
            name: item.file.name,
            cause: reply.refusal.detail,
            retry: item.file,
          })),
        ],
      });
      return;
    }
    this.#heldDraft.setStagedFiles(reply.value.attachments);
    const byId = new Map(items.map((item) => [item.clientStagingId, item.file]));
    this.#publish({
      pending,
      refusals: [
        ...this.#snapshot.refusals,
        ...reply.value.refused.map((refusal) => ({
          clientStagingId: refusal.clientStagingId,
          name: refusal.name,
          cause: refusalCauseWords(refusal.cause),
          retry: isCopyFailure(refusal.cause) ? byId.get(refusal.clientStagingId) : undefined,
        })),
      ],
    });
  }

  #publish(snapshot: ComposerStagingSnapshot): void {
    this.#snapshot = snapshot;
    this.#changes.emit();
  }
}

/** The cause after `·` on a refusal line: the daemon's or provider's own words where it gave any. */
function refusalCauseWords(cause: SessionAttachmentRefusalCause): string {
  if (!("reason" in cause)) {
    return codeWords(cause.code);
  }
  switch (cause.reason) {
    case "providerRefused":
      return cause.providerMessage;
    case "copyFailed":
      return cause.detail;
    default:
      return codeWords(cause.reason);
  }
}

function isCopyFailure(cause: SessionAttachmentRefusalCause): boolean {
  return "reason" in cause && cause.reason === "copyFailed";
}
