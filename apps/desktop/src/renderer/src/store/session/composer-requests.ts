// What the transcript asks of one session's composer: words handed back to the draft, a waiting
// message put into the draft to edit, and a waiting message sent ahead of the turn. The transcript
// and the composer are separate features, so the composer serves these requests here, on the
// session store both read, and the transcript reads back which waiting message is being edited.

import { Emitter } from "#renderer/lib/emitter.js";

/** A waiting message put into the draft to edit: its row, its item and the words it went with. */
export interface WaitingMessageEdit {
  /** The key the message's row is drawn under. */
  readonly rowKey: string;
  /** The waiting item an edit sent from the draft replaces. */
  readonly queueItemId: string;
  readonly content: string;
}

/** A waiting message the draft is editing, and what the draft held before, which comes back. */
export interface DraftEdit extends WaitingMessageEdit {
  readonly draftBefore: string;
}

/** The acts the composer performs when the transcript asks for them. */
export interface ComposerRequestHandlers {
  /** Puts `content` back into the draft, ahead of anything typed there. */
  readonly returnToDraft: (content: string) => void;
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

  /** The waiting message the draft is editing, or `undefined`. */
  public editSnapshot = (): DraftEdit | undefined => this.#edit;

  /** Watch which waiting message the draft is editing. */
  public subscribe = (listener: () => void): (() => void) => this.#changes.subscribe(listener);

  /** The mounted composer serves the requests until the returned function is called. */
  public serve(handlers: ComposerRequestHandlers): () => void {
    this.#handlers = handlers;
    return () => {
      if (this.#handlers === handlers) {
        this.#handlers = undefined;
      }
    };
  }

  /** Puts `content` back into the draft. Throws when no composer is mounted to take it. */
  public returnToDraft(content: string): void {
    this.#served().returnToDraft(content);
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
