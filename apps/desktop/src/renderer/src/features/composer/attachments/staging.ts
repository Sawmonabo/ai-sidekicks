// The composer's file staging over the daemon: each file picked, dropped or pasted goes out as one
// `session.attachment.add` item under the token main minted for its path, and the staged set the
// daemon answers with replaces the held draft's files. A file still copying shows as pending, and
// the held draft holds the next send until the copy settles. A file that was not staged becomes
// one refusal line naming it and its cause; a failed copy can be copied again. A pick of several
// files also says how many of them were taken.

import type {
  SessionAttachmentAddResponse,
  SessionAttachmentRefusalCause,
  SessionAttachmentRemoveResponse,
} from "@ai-sidekicks/contracts/session/draft";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";

import { Emitter } from "#renderer/lib/emitter.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import type { DaemonReply } from "#renderer/services/daemon/reply.js";
import type { FilePathRef } from "#shared/preload-api.js";
import type { ComposerHeldDraft } from "../held-draft/holder.js";

/** One file offered for staging: main's token for its path, and the name and size a line draws. */
export interface OfferedFile {
  readonly ref: FilePathRef;
  readonly name: string;
  readonly sizeBytes: number;
}

/** One file of a pick that never reached the daemon, with why. */
export interface UnofferedFile {
  readonly name: string;
  readonly cause: StagingRefusalCause;
}

/** A file whose copy to the daemon has not answered yet. */
export interface PendingCopy {
  readonly clientStagingId: string;
  readonly name: string;
}

/**
 * Why one file was not staged: a session rule, the disk too full for it, other files still taking
 * the room, or the words the provider, the daemon or main gave.
 */
export type StagingRefusalCause =
  | { readonly kind: "countLimit"; readonly limit: number }
  | { readonly kind: "folder" }
  | { readonly kind: "providerTakesNoFiles" }
  | { readonly kind: "cardWaiting" }
  | { readonly kind: "diskFull"; readonly fileBytes: number; readonly availableBytes: number }
  | { readonly kind: "stillCopying" }
  | { readonly kind: "ownWords"; readonly words: string };

/** One file that was not staged: its name, the cause, and whether it can retry. */
export interface StagingRefusalLine {
  readonly clientStagingId: string;
  readonly name: string;
  readonly cause: StagingRefusalCause;
  /** The file to copy again, present only for a copy that failed. */
  readonly retry: OfferedFile | undefined;
}

/** How many files of one pick of several were staged, while any of them was not. */
export interface PickCount {
  readonly attached: number;
  readonly offered: number;
}

/** What the strip draws beside the staged files. */
export interface ComposerStagingSnapshot {
  readonly pending: readonly PendingCopy[];
  readonly refusals: readonly StagingRefusalLine[];
  /** The latest pick's count, present for a pick of several that was not taken whole. */
  readonly pickCount: PickCount | undefined;
  /** Why the system's file picker could not open or answer. */
  readonly pickerRefusal: ExtendedRefusal | undefined;
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
export const NOTHING_STAGING: ComposerStagingSnapshot = {
  pending: [],
  refusals: [],
  pickCount: undefined,
  pickerRefusal: undefined,
};

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

  /**
   * Stage one pick in one call: `files` go to the daemon and `unoffered` are named at once with
   * their causes. The refusal lines and the count an earlier pick left give way.
   */
  public stage(files: readonly OfferedFile[], unoffered: readonly UnofferedFile[] = []): void {
    if (files.length === 0 && unoffered.length === 0) {
      return;
    }
    const offerRefusals = unoffered.map((file) => ({
      clientStagingId: this.#newStagingId(),
      name: file.name,
      cause: file.cause,
      retry: undefined,
    }));
    this.#stage(files, offerRefusals, files.length + unoffered.length);
  }

  /** Name why the file picker could not answer, in place of the lines an earlier pick left. */
  public refusePick(refusal: ExtendedRefusal): void {
    this.#publish({
      ...this.#snapshot,
      refusals: [],
      pickCount: undefined,
      pickerRefusal: refusal,
    });
  }

  /** Copy again the file a failed copy's refusal line names; the other lines stay. */
  public retry(clientStagingId: string): void {
    const line = this.#snapshot.refusals.find((each) => each.clientStagingId === clientStagingId);
    if (line?.retry === undefined) {
      return;
    }
    this.#stage(
      [line.retry],
      this.#snapshot.refusals.filter((each) => each !== line),
      1,
    );
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
              cause: { kind: "ownWords", words: reply.refusal.detail },
              retry: undefined,
            },
          ],
        });
      }
    });
  }

  /** Publish `files` as copying beside `refusals`, then send them in one call. */
  #stage(
    files: readonly OfferedFile[],
    refusals: readonly StagingRefusalLine[],
    offered: number,
  ): void {
    const items = files.map((file) => ({ file, clientStagingId: this.#newStagingId() }));
    this.#publish({
      pending: [
        ...this.#snapshot.pending,
        ...items.map((item) => ({ clientStagingId: item.clientStagingId, name: item.file.name })),
      ],
      refusals,
      pickCount: undefined,
      pickerRefusal: undefined,
    });
    const [first, ...rest] = items;
    if (first === undefined) {
      this.#publish({ ...this.#snapshot, pickCount: pickCountOf(0, offered) });
      return;
    }
    const toItem = (item: (typeof items)[number]): StagingItem => ({
      clientStagingId: item.clientStagingId,
      path: item.file.ref,
    });
    const copy = this.#calls.add([toItem(first), ...rest.map(toItem)]).then((reply) => {
      this.#settle(items, offered, reply);
    });
    this.#heldDraft.trackCopy(copy);
  }

  #settle(
    items: readonly { readonly file: OfferedFile; readonly clientStagingId: string }[],
    offered: number,
    reply: DaemonReply<SessionAttachmentAddResponse>,
  ): void {
    const settledIds = new Set(items.map((item) => item.clientStagingId));
    const pending = this.#snapshot.pending.filter((each) => !settledIds.has(each.clientStagingId));
    if (reply.status === "refused") {
      // The whole call was refused: every file it carried is named with the daemon's words.
      this.#publish({
        ...this.#snapshot,
        pending,
        refusals: [
          ...this.#snapshot.refusals,
          ...items.map((item) => ({
            clientStagingId: item.clientStagingId,
            name: item.file.name,
            cause: { kind: "ownWords", words: reply.refusal.detail } as const,
            retry: item.file,
          })),
        ],
        pickCount: pickCountOf(0, offered),
      });
      return;
    }
    this.#heldDraft.setStagedFiles(reply.value.attachments);
    const byId = new Map(items.map((item) => [item.clientStagingId, item.file]));
    const stagedCount = reply.value.attachments.length;
    this.#publish({
      ...this.#snapshot,
      pending,
      refusals: [
        ...this.#snapshot.refusals,
        ...reply.value.refused.map((refusal) => {
          const file = byId.get(refusal.clientStagingId);
          return {
            clientStagingId: refusal.clientStagingId,
            name: refusal.name,
            cause: causeOf(refusal.cause, file?.sizeBytes ?? 0, stagedCount),
            retry: isCopyFailure(refusal.cause) ? file : undefined,
          };
        }),
      ],
      pickCount: pickCountOf(items.length - reply.value.refused.length, offered),
    });
  }

  #publish(snapshot: ComposerStagingSnapshot): void {
    this.#snapshot = snapshot;
    this.#changes.emit();
  }
}

/**
 * The cause after `·` on a refusal line. A provider that takes no files is named by
 * `providerName`, the name the service's provider list gives the session's provider.
 */
export function stagingRefusalWords(
  cause: StagingRefusalCause,
  providerName: string | undefined,
): string {
  switch (cause.kind) {
    case "countLimit":
      return `Limit is ${String(cause.limit)} ${cause.limit === 1 ? "file" : "files"}`;
    case "folder":
      return "Folder: mention it with @";
    case "providerTakesNoFiles":
      return `${providerName ?? "Provider"} takes no files`;
    case "cardWaiting":
      return "Answer the card above first";
    case "diskFull":
      return (
        `${formatByteQuantity(cause.fileBytes).text}; ` +
        `disk has ${formatByteQuantity(cause.availableBytes).text} free`
      );
    case "stillCopying":
      return "Still copying other files";
    case "ownWords":
      return cause.words;
  }
}

/** The count line's figures, kept only for a pick of several that was not taken whole. */
function pickCountOf(attached: number, offered: number): PickCount | undefined {
  return offered > 1 && attached < offered ? { attached, offered } : undefined;
}

/**
 * The daemon's cause as the line words it. A count refusal leaves the message holding as many
 * files as it takes, so the staged set's size after the add is the limit.
 */
function causeOf(
  cause: SessionAttachmentRefusalCause,
  fileBytes: number,
  stagedCount: number,
): StagingRefusalCause {
  switch (cause.code) {
    case "artifact.tooLarge":
      return { kind: "diskFull", fileBytes, availableBytes: cause.availableBytes };
    case "artifact.ingest.capacityExhausted":
      return { kind: "stillCopying" };
    case "session.attachment.refused":
      switch (cause.reason) {
        case "countLimit":
          return { kind: "countLimit", limit: stagedCount };
        case "folder":
          return { kind: "folder" };
        case "providerTakesNoAttachments":
          return { kind: "providerTakesNoFiles" };
        case "cardWaiting":
          return { kind: "cardWaiting" };
        case "providerRefused":
          return { kind: "ownWords", words: cause.providerMessage };
        case "copyFailed":
          return { kind: "ownWords", words: cause.detail };
      }
  }
}

function isCopyFailure(cause: SessionAttachmentRefusalCause): boolean {
  return "reason" in cause && cause.reason === "copyFailed";
}
