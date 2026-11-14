// One session's draft as the daemon holds it, beside the words the window's draft store holds for
// the line. A held draft at a newer revision lands in the line: whole where nothing typed here is
// unsaved, merged with that typing where something is (`merge.ts`), and a draft at a revision this
// composer already took, or the empty draft of revision 0, writes nothing. The words and what rides
// with them are saved to the daemon one second after typing pauses, at once when asked (the session
// is left, the window closes, Send cleared the draft), one save at a time; a save the daemon
// refuses as stale waits for the newer draft, merges it and saves again. Nothing is kept anywhere
// but the window's memory and the daemon.

import {
  SESSION_DRAFT_REVISION_STALE_CODE,
  type SessionAttachmentSummary,
  type SessionDraft,
  type SessionDraftExtras,
  type SessionDraftUpdateResponse,
} from "@ai-sidekicks/contracts/session/draft";
import type { QueuedSkillPick } from "@ai-sidekicks/contracts/run/queue";

import type { Clock, ScheduledHandle } from "#renderer/lib/clock.js";
import { Emitter } from "#renderer/lib/emitter.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import type { DaemonReply } from "#renderer/services/daemon/reply.js";
import type { SessionDraftFrame } from "#renderer/services/daemon/session-draft.js";
import type { DraftStore } from "#renderer/store/drafts.js";
import { COMPOSER_DRAFT_SAVE_PAUSE_MILLISECONDS } from "../bounds.js";
import { mergeDrafts } from "./merge.js";

/** What the composer draws beside the words: the draft's extras, its files, a refused save. */
export interface HeldDraftReading {
  readonly extras: SessionDraftExtras;
  /** The staged files the extras name, as the daemon found them, in the draft's order. */
  readonly files: readonly SessionAttachmentSummary[];
  /** Why the last save was refused, until a save lands; a stale save is merged, never shown. */
  readonly saveRefusal: ExtendedRefusal | undefined;
}

/** How a holder saves: the daemon call, and the clock the pause is timed on. */
export interface DraftSaving {
  readonly clock: Clock;
  /** Save `draft` over `expectedRevision`; answers the daemon's reply, never rejects. */
  readonly save: (
    draft: SessionDraft,
    expectedRevision: number,
  ) => Promise<DaemonReply<SessionDraftUpdateResponse>>;
}

/** What a holder is built over; without `saving` it follows the held draft and saves nothing. */
export interface ComposerHeldDraftOptions {
  readonly draftStore: DraftStore;
  readonly draftKey: string;
  readonly saving?: DraftSaving;
}

/** One session's held draft, beside the words its draft store holds. */
export class ComposerHeldDraft {
  readonly #draftStore: DraftStore;
  readonly #draftKey: string;
  readonly #saving: DraftSaving | undefined;
  readonly #changes = new Emitter<void>("composer held draft");
  #reading: HeldDraftReading = NOTHING_HELD;
  /** The newest revision taken or saved here: the one the next save is typed over. */
  #revision = 0;
  /** The draft as the daemon last held it to this holder's knowledge. */
  #synced: SessionDraft = EMPTY_DRAFT;
  /** The draft a save in flight carries, which its echo on the stream must not merge. */
  #inFlight: SessionDraft | undefined;
  #saveAgain = false;
  #pause: ScheduledHandle | undefined;
  #stopWatchingLine: (() => void) | undefined;
  /** The copies to the daemon still running, which a send waits for. */
  readonly #copies = new Set<Promise<void>>();
  /** The call each skill picked here wrote into the line, by the pick's key. */
  readonly #callFormByPick = new Map<string, string>();

  /** The reading as it stands. Stable between changes. */
  public snapshot = (): HeldDraftReading => this.#reading;

  /** Watch the reading. */
  public subscribe = (listener: () => void): (() => void) => this.#changes.subscribe(listener);

  /** Take one delivery of the daemon's draft. A lost draft keeps what is shown. */
  public take = (frame: SessionDraftFrame): void => {
    if (frame.kind === "lost" || frame.held.revision <= this.#revision) {
      return;
    }
    const held = frame.held.draft;
    this.#revision = frame.held.revision;
    if (this.#inFlight !== undefined && sameDraft(held, this.#inFlight)) {
      // This holder's own save, heard on the stream before its reply.
      this.#synced = held;
      return;
    }
    const own = this.#current();
    const hasUnsavedTyping = !sameDraft(own, this.#synced);
    const landed = hasUnsavedTyping ? mergeDrafts(held, own) : held;
    this.#synced = held;
    this.#draftStore.write(this.#draftKey, landed.text);
    this.#publish({ ...this.#reading, extras: landed.extras, files: frame.files });
    if (hasUnsavedTyping) {
      this.saveNow();
    }
  };

  public constructor(options: ComposerHeldDraftOptions) {
    this.#draftStore = options.draftStore;
    this.#draftKey = options.draftKey;
    this.#saving = options.saving;
  }

  /** Follow the line's words, saving after each pause, until `stop` saves what is left. */
  public start(): void {
    this.#stopWatchingLine ??= this.#draftStore.subscribe(this.#draftKey, () => {
      this.#armPause();
    });
  }

  /** Stop following the line and save any unsaved words now: the session is being left. */
  public stop(): void {
    this.#stopWatchingLine?.();
    this.#stopWatchingLine = undefined;
    this.saveNow();
  }

  /**
   * Add a skill picked from the command list after the ones picked before it, once. The pick rides
   * with the words only while `callForm`, the call it wrote into the line, is still in it.
   */
  public addSkillPick(pick: QueuedSkillPick, callForm: string): void {
    const { extras } = this.#reading;
    const picked = extras.skills ?? [];
    this.#callFormByPick.set(skillPickKey(pick), callForm);
    if (picked.some((each) => skillPickKey(each) === skillPickKey(pick))) {
      return;
    }
    this.#publish({
      ...this.#reading,
      extras: { ...extras, skills: [...picked, pick] },
    });
    this.#armPause();
  }

  /**
   * What rides with `text`: the held extras, less each skill picked here whose call the person has
   * since taken out of it. The pick stays held, so it rides again once its call is back.
   */
  public extrasFor(text: string): SessionDraftExtras {
    const { extras } = this.#reading;
    const picked = extras.skills ?? [];
    const kept = picked.filter((pick) => {
      const callForm = this.#callFormByPick.get(skillPickKey(pick));
      return callForm === undefined || text.includes(callForm);
    });
    if (kept.length === picked.length) {
      return extras;
    }
    const { skills: _dropped, ...rest } = extras;
    return kept.length === 0 ? rest : { ...rest, skills: kept };
  }

  /** Take the staged set the daemon answered a stage or an unstage with, in its order. */
  public setStagedFiles(files: readonly SessionAttachmentSummary[]): void {
    const { attachments: _dropped, ...rest } = this.#reading.extras;
    this.#publish({
      ...this.#reading,
      extras:
        files.length === 0 ? rest : { ...rest, attachments: files.map((file) => file.artifactId) },
      files,
    });
    this.#armPause();
  }

  /** Set the output speed the next turn alone runs at, or drop it back to the agent's own. */
  public setOutputSpeedForTurn(level: string | undefined): void {
    const { outputSpeedForTurn: _dropped, ...rest } = this.#reading.extras;
    this.#publish({
      ...this.#reading,
      extras: level === undefined ? rest : { ...rest, outputSpeedForTurn: level },
    });
    this.#armPause();
  }

  /** Hold the next send until `copy`, one file's copy to the daemon, settles. */
  public trackCopy(copy: Promise<void>): void {
    this.#copies.add(copy);
    void copy.finally(() => {
      this.#copies.delete(copy);
    });
  }

  /** Settle once every copy tracked so far, and any tracked while waiting, has settled. */
  public async whenCopied(): Promise<void> {
    while (this.#copies.size > 0) {
      await Promise.allSettled([...this.#copies]);
    }
  }

  /**
   * Drop from what rides with the words what a send carried, and save the draft without it. What
   * was picked or staged after the send left stays for the next message.
   */
  public clearSent(sent: SessionDraftExtras): void {
    const { extras, files } = this.#reading;
    const sentFiles = new Set(sent.attachments ?? []);
    const sentSkills = new Set((sent.skills ?? []).map(skillPickKey));
    const attachments = (extras.attachments ?? []).filter((id) => !sentFiles.has(id));
    const skills = (extras.skills ?? []).filter((pick) => !sentSkills.has(skillPickKey(pick)));
    for (const key of sentSkills) {
      this.#callFormByPick.delete(key);
    }
    const kept: SessionDraftExtras = {
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(skills.length === 0 ? {} : { skills }),
      ...(extras.outputSpeedForTurn === undefined ||
      extras.outputSpeedForTurn === sent.outputSpeedForTurn
        ? {}
        : { outputSpeedForTurn: extras.outputSpeedForTurn }),
      ...(extras.workspaceId === undefined || extras.workspaceId === sent.workspaceId
        ? {}
        : { workspaceId: extras.workspaceId }),
    };
    this.#publish({
      ...this.#reading,
      extras: kept,
      files: files.filter((file) => !sentFiles.has(file.artifactId)),
    });
    this.saveNow();
  }

  /** Save the draft now when it differs from what the daemon holds; one save at a time. */
  public saveNow(): void {
    const saving = this.#saving;
    if (saving === undefined) {
      return;
    }
    this.#cancelPause(saving);
    if (this.#inFlight !== undefined) {
      this.#saveAgain = true;
      return;
    }
    const draft = this.#current();
    if (sameDraft(draft, this.#synced)) {
      return;
    }
    const expectedRevision = this.#revision;
    this.#inFlight = draft;
    void saving.save(draft, expectedRevision).then((reply) => {
      this.#inFlight = undefined;
      this.#settle(draft, expectedRevision, reply);
    });
  }

  #settle(
    draft: SessionDraft,
    expectedRevision: number,
    reply: DaemonReply<SessionDraftUpdateResponse>,
  ): void {
    if (reply.status === "served") {
      this.#revision = Math.max(this.#revision, reply.value.revision);
      this.#synced = draft;
      this.#publishRefusal(undefined);
    } else if (reply.refusal.code === SESSION_DRAFT_REVISION_STALE_CODE) {
      // A newer draft is held. Where the stream has brought it, `take` merged it and the draft is
      // saved again over it now; otherwise its arrival merges and saves.
      this.#saveAgain ||= this.#revision > expectedRevision;
    } else {
      this.#publishRefusal(reply.refusal);
    }
    if (this.#saveAgain) {
      this.#saveAgain = false;
      this.saveNow();
    }
  }

  /** Restart the pause after a change to the words or the extras. */
  #armPause(): void {
    const saving = this.#saving;
    if (saving === undefined) {
      return;
    }
    this.#cancelPause(saving);
    this.#pause = saving.clock.scheduleTimeout(() => {
      this.#pause = undefined;
      this.saveNow();
    }, COMPOSER_DRAFT_SAVE_PAUSE_MILLISECONDS);
  }

  #cancelPause(saving: DraftSaving): void {
    if (this.#pause !== undefined) {
      saving.clock.cancel(this.#pause);
      this.#pause = undefined;
    }
  }

  /** The draft as this composer has it: the line's words and what rides with them. */
  #current(): SessionDraft {
    const text = this.#draftStore.read(this.#draftKey)?.text ?? "";
    return { text, extras: this.extrasFor(text) };
  }

  #publishRefusal(saveRefusal: ExtendedRefusal | undefined): void {
    if (this.#reading.saveRefusal !== saveRefusal) {
      this.#publish({ ...this.#reading, saveRefusal });
    }
  }

  #publish(reading: HeldDraftReading): void {
    this.#reading = reading;
    this.#changes.emit();
  }
}

/** Whether two drafts carry the same words and the same extras. */
function sameDraft(left: SessionDraft, right: SessionDraft): boolean {
  const [leftExtras, rightExtras] = [left.extras, right.extras];
  return (
    left.text === right.text &&
    sameList(leftExtras.attachments ?? [], rightExtras.attachments ?? []) &&
    sameList(
      (leftExtras.skills ?? []).map(skillPickKey),
      (rightExtras.skills ?? []).map(skillPickKey),
    ) &&
    leftExtras.outputSpeedForTurn === rightExtras.outputSpeedForTurn &&
    leftExtras.workspaceId === rightExtras.workspaceId
  );
}

/** Whether two lists hold the same values in the same order. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** One skill pick's identity: its name in its folder. */
function skillPickKey(pick: QueuedSkillPick): string {
  return `${pick.folderPath}\u0000${pick.name}`;
}

/** A draft with no words and nothing riding with them. */
const EMPTY_DRAFT: SessionDraft = { text: "", extras: {} };

/** A draft with nothing riding with its words and no refused save. */
const NOTHING_HELD: HeldDraftReading = { extras: {}, files: [], saveRefusal: undefined };
