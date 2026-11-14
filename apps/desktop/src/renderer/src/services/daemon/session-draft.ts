// A session's unsent draft as the daemon holds it, followed through `session.draft.subscribe`,
// which delivers the draft held now and again after each change: a save from any device, or a
// message a Stop put back. A draft that names staged files comes with what the daemon found for each, read off `session.read`'s
// staged set, since the draft names a file only by its artifact; a draft naming only files the
// last read answered for, as the echo of this window's own save does, reuses its answer, a file it
// did not find included, so an id the staged set never holds is not read again. A refused read
// and a stream the daemon refuses are handed on as the draft being lost.

import type {
  HeldSessionDraft,
  SessionAttachmentSummary,
} from "@ai-sidekicks/contracts/session/draft";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { SESSION_DRAFT_STREAM } from "#shared/daemon/streams.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";
import { callDaemon } from "./reply.js";

/**
 * One delivery: the draft as held, with each staged file it names in the draft's order, or word
 * that the draft could not be read.
 */
export type SessionDraftFrame =
  | {
      readonly kind: "held";
      readonly held: HeldSessionDraft;
      readonly files: readonly SessionAttachmentSummary[];
    }
  | { readonly kind: "lost" };

/** Follow one session's held draft, handing each frame on, until the handle releases it. */
export function followSessionDraft(
  bridge: PlatformBridge,
  sessionId: SessionId,
  onFrame: (frame: SessionDraftFrame) => void,
): Unsubscribe {
  return new SessionDraftFollower(bridge, sessionId, onFrame).open();
}

/** One open of the stream, and the staged-file read each draft that names files takes. */
class SessionDraftFollower {
  readonly #bridge: PlatformBridge;
  readonly #sessionId: SessionId;
  readonly #onFrame: (frame: SessionDraftFrame) => void;
  // The staged-file read in flight, aborted when a newer draft arrives or the stream is released.
  #filesRead: AbortController | undefined;
  // What the last completed staged-file read found for each file, by artifact.
  #found: ReadonlyMap<string, SessionAttachmentSummary> = new Map();
  // Every artifact the last completed read answered for, the ones it did not find included.
  #answered: ReadonlySet<string> = new Set();

  public constructor(
    bridge: PlatformBridge,
    sessionId: SessionId,
    onFrame: (frame: SessionDraftFrame) => void,
  ) {
    this.#bridge = bridge;
    this.#sessionId = sessionId;
    this.#onFrame = onFrame;
  }

  public open(): Unsubscribe {
    const bridge = this.#bridge;
    const releaseStream = openReopeningSubscription({
      signal: bridge.transportReconnect,
      subject: SESSION_DRAFT_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) =>
        bridge.daemon.subscribe(
          SESSION_DRAFT_STREAM,
          { sessionId: this.#sessionId },
          deliver,
          onEnded,
        ),
      onFrame: (payload) => {
        this.#takeDraft(payload as HeldSessionDraft);
      },
      onReopenRefusal: (refusal) => {
        if (refusal !== undefined) {
          this.#onFrame({ kind: "lost" });
        }
      },
    });
    return () => {
      this.#filesRead?.abort();
      this.#filesRead = undefined;
      releaseStream();
    };
  }

  #takeDraft(payload: HeldSessionDraft): void {
    this.#filesRead?.abort();
    this.#filesRead = undefined;
    const named = payload.draft.extras.attachments ?? [];
    if (named.every((artifactId) => this.#answered.has(artifactId))) {
      this.#onFrame({ kind: "held", held: payload, files: this.#filesNamed(named) });
      return;
    }
    const filesRead = new AbortController();
    this.#filesRead = filesRead;
    void callDaemon(
      this.#bridge,
      "session.read",
      { sessionId: this.#sessionId },
      { signal: filesRead.signal },
    ).then((reply) => {
      if (filesRead.signal.aborted) {
        return;
      }
      if (reply.status === "refused") {
        this.#onFrame({ kind: "lost" });
        return;
      }
      const staged = reply.value.session.attachments;
      this.#found = new Map(staged.map((summary) => [summary.artifactId, summary]));
      this.#answered = new Set([...this.#found.keys(), ...named]);
      this.#onFrame({ kind: "held", held: payload, files: this.#filesNamed(named) });
    });
  }

  #filesNamed(named: readonly string[]): readonly SessionAttachmentSummary[] {
    return named.flatMap((artifactId) => {
      const file = this.#found.get(artifactId);
      return file === undefined ? [] : [file];
    });
  }
}
