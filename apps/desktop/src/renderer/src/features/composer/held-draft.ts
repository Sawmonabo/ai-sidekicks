// What rides with one session's draft: the daemon's held draft as it last arrived, and the skills
// picked here since. The words live in the window's draft store, which a newer held draft writes
// over, so a message a Stop put back, or a draft saved on another device, shows whole; a draft at
// a revision this composer already took, or the empty draft of revision 0, writes nothing.

import type {
  SessionAttachmentSummary,
  SessionDraftExtras,
} from "@ai-sidekicks/contracts/session/draft";
import type { QueuedSkillPick } from "@ai-sidekicks/contracts/run/queue";

import { Emitter } from "#renderer/lib/emitter.js";
import type { SessionDraftFrame } from "#renderer/services/daemon/session-draft.js";
import type { DraftStore } from "#renderer/store/drafts.js";

/** What the composer draws beside the words: the draft's extras and its staged files. */
export interface HeldDraftReading {
  readonly extras: SessionDraftExtras;
  /** The staged files the extras name, as the daemon found them, in the draft's order. */
  readonly files: readonly SessionAttachmentSummary[];
}

/** One session's held draft, beside the words its draft store holds. */
export class ComposerHeldDraft {
  readonly #draftStore: DraftStore;
  readonly #draftKey: string;
  readonly #changes = new Emitter<void>("composer held draft");
  #reading: HeldDraftReading = NOTHING_HELD;
  #takenRevision = 0;

  /** The reading as it stands. Stable between changes. */
  public snapshot = (): HeldDraftReading => this.#reading;

  /** Watch the reading. */
  public subscribe = (listener: () => void): (() => void) => this.#changes.subscribe(listener);

  /** Take one delivery of the daemon's draft. A lost draft keeps what is shown. */
  public take = (frame: SessionDraftFrame): void => {
    if (frame.kind === "lost" || frame.held.revision <= this.#takenRevision) {
      return;
    }
    this.#takenRevision = frame.held.revision;
    this.#draftStore.write(this.#draftKey, frame.held.draft.text);
    this.#publish({ extras: frame.held.draft.extras, files: frame.files });
  };

  public constructor(draftStore: DraftStore, draftKey: string) {
    this.#draftStore = draftStore;
    this.#draftKey = draftKey;
  }

  /** Add a skill picked from the command list, after the ones picked before it. */
  public addSkillPick(pick: QueuedSkillPick): void {
    const { extras } = this.#reading;
    this.#publish({
      ...this.#reading,
      extras: { ...extras, skills: [...(extras.skills ?? []), pick] },
    });
  }

  /** Drop what rides with the words: the send carried it. */
  public clear(): void {
    this.#publish(NOTHING_HELD);
  }

  #publish(reading: HeldDraftReading): void {
    this.#reading = reading;
    this.#changes.emit();
  }
}

/** A draft with nothing riding with its words. */
const NOTHING_HELD: HeldDraftReading = { extras: {}, files: [] };
