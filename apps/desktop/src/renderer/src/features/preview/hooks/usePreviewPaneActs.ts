// Decides which of the pane's acts may still render its answer. Acts overlap (reload can be
// pending when stop is pressed), so each takes a token and a completion writes only while its
// token is newest, else an older completion would show or clear the wrong refusal. Local refusals
// take a token too; dismissal takes none, since an in-flight act's failure is still news. A
// refusal belongs to the `(bridge, paneId)` it was raised under, so a swap cannot inherit it.

import { useCallback } from "react";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { normalizeWireRejection, type RejectionFallback } from "@renderer/lib/wire-rejection.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { PreviewPaneRefusalCode } from "../pane-refusals.js";

/** The subsystem name every refusal this pane raises itself carries. */
const PREVIEW_PANE_REFUSAL_ORIGIN = "preview-pane";

/**
 * Which dispatched act is the newest. A monotonic counter behind two calls, so no call site
 * compares a bare number its own way.
 */
class PreviewActSequence {
  #newestToken = 0;

  /** Take the token for an act being dispatched now. Every later act outranks it. */
  public begin(): number {
    this.#newestToken += 1;
    return this.#newestToken;
  }

  /** Whether this token still names the newest act, and so may write. */
  public isNewest(token: number): boolean {
    return token === this.#newestToken;
  }

  /**
   * Retire every token taken so far, so nothing in flight may write. The counter advances
   * rather than resets: a reset would give the replacement subject's first act the number an
   * outstanding act already holds, letting that stale act write against the new pane.
   */
  public supersedeOutstanding(): void {
    this.#newestToken += 1;
  }
}

/**
 * How the holder releases a sequence when the subject moves or the pane unmounts. A release, not
 * a terminal disposal: the object keeps working. Module-level for a stable identity.
 */
const PREVIEW_ACT_SEQUENCE_DISPOSAL: SubjectScopedDisposal<PreviewActSequence> = {
  release: (retired) => {
    retired.supersedeOutstanding();
  },
};

/** The pane's acts, and the one refusal they report between them. */
export interface PreviewPaneActs {
  /** The newest act's refusal, or `undefined` where the newest act did not refuse. */
  readonly refusal: Refusal | undefined;
  /**
   * Dispatch one act. The thunk answers with the refusal to render, or `undefined` where the act
   * was served; a rejection is normalized through the wire-rejection reader, so a code the
   * other side sent survives.
   */
  run(act: () => Promise<Refusal | undefined>, fallback: RejectionFallback): void;
  /**
   * Refuse here and now, without crossing the boundary. Outranks anything in flight. The code
   * is one of the pane's own closed set, so a new one is a decision.
   */
  refuseLocally(code: PreviewPaneRefusalCode, detail: string): void;
  /** Clear what is on screen. Starts nothing, and supersedes nothing. */
  dismiss(): void;
}

/**
 * Hold one pane's act ordering and the one refusal it renders. The refusal is held for its
 * subject, so the first pass for a replacement subject already shows none; the sequence is a
 * resource whose retirement supersedes in-flight acts, on a subject change and on unmount.
 */
export function usePreviewPaneActs(bridge: PlatformBridge, paneId: string): PreviewPaneActs {
  const { value: sequence } = useSubjectScopedResource(
    bridge,
    paneId,
    () => new PreviewActSequence(),
    PREVIEW_ACT_SEQUENCE_DISPOSAL,
  );
  const { value: refusal, publish } = useSubjectScopedState<Refusal | undefined>(
    bridge,
    paneId,
    () => undefined,
  );

  const run = useCallback(
    (act: () => Promise<Refusal | undefined>, fallback: RejectionFallback): void => {
      const token = sequence.begin();
      void act().then(
        (outcome) => {
          if (sequence.isNewest(token)) {
            publish(outcome);
          }
        },
        (failure: unknown) => {
          if (sequence.isNewest(token)) {
            publish(normalizeWireRejection(PREVIEW_PANE_REFUSAL_ORIGIN, failure, fallback));
          }
        },
      );
    },
    [publish, sequence],
  );

  const refuseLocally = useCallback(
    (code: PreviewPaneRefusalCode, detail: string): void => {
      sequence.begin();
      publish(refuse(PREVIEW_PANE_REFUSAL_ORIGIN, code, detail));
    },
    [publish, sequence],
  );

  const dismiss = useCallback((): void => {
    publish(undefined);
  }, [publish]);

  return { refusal, run, refuseLocally, dismiss };
}
