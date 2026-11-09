// A session's unsent draft as the daemon holds it, followed through `session.draft.subscribe`,
// which delivers the draft held now and again after each change: a save from any device, or a
// message a Stop put back. Every delivery is checked with the contract's generated check. A draft
// that names staged files comes with what the daemon found for each, read off `session.read`'s
// staged set, since the draft names a file only by its artifact. An unreadable delivery, a refused
// read and a stream the daemon refuses are handed on as the draft being lost.

import {
  type HeldSessionDraft,
  type SessionAttachmentSummary,
  validateHeldSessionDraft,
} from "@ai-sidekicks/contracts/session/draft";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { checkFaultPaths } from "#shared/daemon/fault-path.js";
import { SESSION_DRAFT_STREAM } from "#shared/daemon/streams.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
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
        this.#takeDraft(payload);
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

  #takeDraft(payload: unknown): void {
    this.#filesRead?.abort();
    this.#filesRead = undefined;
    if (!validateHeldSessionDraft(payload)) {
      recordRefusedMemberPaths({
        source: "services/daemon",
        kind: "notice-unreadable",
        subject: SESSION_DRAFT_STREAM,
        issues: checkFaultPaths(validateHeldSessionDraft, payload),
      });
      this.#onFrame({ kind: "lost" });
      return;
    }
    const named = payload.draft.extras.attachments ?? [];
    if (named.length === 0) {
      this.#onFrame({ kind: "held", held: payload, files: [] });
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
      const files = named.flatMap((artifactId) => {
        const file = staged.find((summary) => summary.artifactId === artifactId);
        return file === undefined ? [] : [file];
      });
      this.#onFrame({ kind: "held", held: payload, files });
    });
  }
}
