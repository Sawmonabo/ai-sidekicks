// What the transcript and a failed send ask of one session's composer: words handed back to the
// draft, with what a send took from it, a waiting message put into the draft to edit, and a waiting
// message sent ahead of the turn. The transcript and the composer are separate features, so the
// composer serves these requests here, on the session store both read, and the transcript reads
// back which waiting message is being edited. A hand-back made while no composer of the session is
// mounted waits here and reaches the next composer that mounts, once, so it lands whole in its own
// session's draft whichever session is in view.

import type { AttachmentReferenceList } from "@ai-sidekicks/contracts/artifacts/attachment-reference";
import type {
  SessionAttachmentSummary,
  SessionDraftExtras,
} from "@ai-sidekicks/contracts/session/draft";

import { Emitter } from "#renderer/lib/emitter.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";

/**
 * What a send took out of the held draft: the extras it carried, the staged files they name, and
 * the call each skill pick wrote into the line, so a send that comes back puts each back as it was.
 */
export interface SentDraftExtras {
  readonly extras: SessionDraftExtras;
  readonly files: readonly SessionAttachmentSummary[];
  readonly callFormByPick: ReadonlyMap<string, string>;
}

/** What goes back into the draft: words, ahead of anything typed, and what a send took too. */
export interface DraftHandBack {
  readonly words: string;
  /** What a failed send took from the held draft, which goes back with its words. */
  readonly sent?: SentDraftExtras;
}

/** A waiting message put into the draft to edit: its row, its item and the words it went with. */
export interface WaitingMessageEdit {
  /** The key the message's row is drawn under. */
  readonly rowKey: string;
  /** The waiting item an edit sent from the draft replaces. */
  readonly queueItemId: string;
  readonly content: string;
  /** The files the waiting message carries, which the edit sends again unless one is taken off. */
  readonly attachments: AttachmentReferenceList;
}

/** A waiting message the draft is editing, and what the draft held before, which comes back. */
export interface DraftEdit extends WaitingMessageEdit {
  readonly draftBefore: string;
}

/** The acts the composer performs when the transcript asks for them. */
export interface ComposerRequestHandlers {
  /**
   * Puts the words back into the draft, ahead of anything typed there, and what the send took back
   * beside them. Answers the refusal of the save that carries them, or `undefined` once it lands.
   */
  readonly returnToDraft: (handBack: DraftHandBack) => Promise<ExtendedRefusal | undefined>;
  /** Puts a waiting message into the draft to edit, holding what the draft held aside. */
  readonly beginEdit: (edit: WaitingMessageEdit) => void;
  /** Delivers the waiting item first, ahead of the rest. Rejects with the service's refusal. */
  readonly sendNow: (queueItemId: string) => Promise<void>;
}

/** One session's requests to its composer, and the waiting message the draft is editing. */
export class ComposerRequests {
  readonly #changes = new Emitter<void>("composer requests");
  #handlers: ComposerRequestHandlers | undefined = undefined;
  #edit: DraftEdit | undefined = undefined;
  /** Hand-backs made while no composer was mounted, in the order made, each with its answer. */
  #waitingHandBacks: {
    readonly handBack: DraftHandBack;
    readonly answer: (refusal: Promise<ExtendedRefusal | undefined>) => void;
  }[] = [];

  /** The waiting message the draft is editing, or `undefined`. */
  public editSnapshot = (): DraftEdit | undefined => this.#edit;

  /** Watch which waiting message the draft is editing. */
  public subscribe = (listener: () => void): (() => void) => this.#changes.subscribe(listener);

  /**
   * The mounted composer serves the requests until the returned function is called, taking first
   * every hand-back that waited for it.
   */
  public serve(handlers: ComposerRequestHandlers): () => void {
    this.#handlers = handlers;
    const waiting = this.#waitingHandBacks;
    this.#waitingHandBacks = [];
    for (const { handBack, answer } of waiting) {
      answer(handlers.returnToDraft(handBack));
    }
    return () => {
      if (this.#handlers === handlers) {
        this.#handlers = undefined;
      }
    };
  }

  /**
   * Puts `handBack` back into the draft, at once when a composer is mounted and when the next one
   * mounts otherwise. Answers the refusal of the save that carries it, or `undefined`.
   */
  public async returnToDraft(handBack: DraftHandBack): Promise<ExtendedRefusal | undefined> {
    const handlers = this.#handlers;
    if (handlers !== undefined) {
      return await handlers.returnToDraft(handBack);
    }
    return await new Promise<ExtendedRefusal | undefined>((resolve) => {
      this.#waitingHandBacks.push({ handBack, answer: resolve });
    });
  }

  /** Puts a waiting message into the draft to edit. Throws when no composer is mounted. */
  public beginEdit(edit: WaitingMessageEdit): void {
    this.#served().beginEdit(edit);
  }

  /** Sends the waiting item now. Rejects with the refusal, or when no composer is mounted. */
  public async sendNow(queueItemId: string): Promise<void> {
    await this.#served().sendNow(queueItemId);
  }

  /** The composer's record of the edit it holds: `undefined` once it is sent or left. */
  public publishEdit(edit: DraftEdit | undefined): void {
    this.#edit = edit;
    this.#changes.emit();
  }

  #served(): ComposerRequestHandlers {
    if (this.#handlers === undefined) {
      throw new Error("No composer is mounted on this session to take the request");
    }
    return this.#handlers;
  }
}
