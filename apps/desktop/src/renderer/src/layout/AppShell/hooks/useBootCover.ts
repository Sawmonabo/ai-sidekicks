// The boot cover a window draws until the background service first answers: the working line while
// main looks for the service, starts it or waits out its repair, and the not-answering card once
// main has given up. At the first answer the cover fades with what it last held and is then gone
// for the window's life; a window that opens after the answer never draws it. Under reduced motion,
// or where no fade runs, it goes at once.

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { prefersReducedMotion } from "#renderer/lib/reduced-motion.js";
import { useWindowStore } from "#renderer/store/window/hooks/useWindowStore.js";
import { joinFigureSentence, type FigureSentencePart } from "#renderer/lib/figure-sentence.js";
import {
  describeDaemonConnection,
  describeDaemonConnectionSentence,
  serviceBootStageOf,
} from "#renderer/store/window/main-process-state.js";
import type { WindowStore } from "#renderer/store/window/store.js";
import type { DaemonConnection } from "#shared/daemon/status-topic.js";

/**
 * What the cover holds: the working indicator with the line saying what main is doing, absent
 * before main's first report, or the card saying the service is not answering.
 */
export type BootCoverContent =
  | {
      readonly kind: "working";
      /** The line, its figures drawn through the figure components. */
      readonly line: readonly FigureSentencePart[] | undefined;
      /** The line as it is said: a repair's words without its count, which moves every second. */
      readonly spokenLine: string | undefined;
    }
  | { readonly kind: "notAnswering" };

/** The boot cover as a window draws it now, and what its fade is settled through. */
export interface DrawnBootCover {
  readonly content: BootCoverContent;
  /** True once the service has answered: the cover fades and takes no press. */
  readonly isFading: boolean;
  /** The cover's own element, whose fade the hook watches. */
  readonly coverRef: React.RefObject<HTMLDivElement | null>;
  /** The cover's `transitionend` listener, which ends it once its fade has run. */
  readonly onTransitionEnd: (event: React.TransitionEvent<HTMLDivElement>) => void;
}

/**
 * The boot cover for the window `frameStore` holds, or `undefined` once it has gone or when the
 * service had answered before the window opened. `hasServiceAnswered` is the app's own latch:
 * once it is true, the cover never comes back.
 */
export function useBootCover(
  frameStore: WindowStore,
  hasServiceAnswered: boolean,
): DrawnBootCover | undefined {
  const coverRef = useRef<HTMLDivElement | null>(null);
  const connection = useWindowStore(frameStore, (state) => state.mainProcessState.connection);
  const [heldCover, setHeldCover] = useState<HeldCover>(() =>
    hasServiceAnswered ? GONE_COVER : { state: "covering", content: contentOf(connection) },
  );
  // Followed during render, so the cover never draws one commit behind the report.
  const followed = followService(heldCover, hasServiceAnswered, connection);
  if (followed !== heldCover) {
    setHeldCover(followed);
  }

  const settle = useCallback(() => {
    setHeldCover(GONE_COVER);
  }, []);

  const { state } = followed;
  useLayoutEffect(() => {
    const cover = coverRef.current;
    const ownerWindow = cover?.ownerDocument.defaultView;
    if (state !== "fading") {
      return;
    }
    // With no motion wanted, or no fade running, no transition ends to take the cover away.
    if (
      cover == null ||
      ownerWindow == null ||
      prefersReducedMotion(ownerWindow) ||
      !isFadeRunning(cover)
    ) {
      settle();
    }
  }, [state, settle]);

  const onTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && event.propertyName === "opacity") {
        settle();
      }
    },
    [settle],
  );

  if (followed.state === "gone") {
    return undefined;
  }
  return {
    content: followed.content,
    isFading: followed.state === "fading",
    coverRef,
    onTransitionEnd,
  };
}

/** The cover drawn and what it holds, fading with that content, or gone for good. */
type HeldCover =
  | { readonly state: "covering" | "fading"; readonly content: BootCoverContent }
  | { readonly state: "gone" };

const GONE_COVER: HeldCover = { state: "gone" };

/**
 * The cover after the latest report: `held` itself while what it shows is unchanged, fading with
 * its last content at the first answer, and gone for good once gone.
 */
function followService(
  held: HeldCover,
  hasServiceAnswered: boolean,
  connection: DaemonConnection,
): HeldCover {
  if (held.state !== "covering") {
    return held;
  }
  if (hasServiceAnswered) {
    return { state: "fading", content: held.content };
  }
  const content = contentOf(connection);
  return contentsAreEqual(held.content, content) ? held : { state: "covering", content };
}

/**
 * What the cover holds for a connection. A report main has not made yet, or an answer the app's
 * latch is still to take, holds the indicator alone. A link this window never saw up is still
 * being connected to, so it reads as connecting rather than reconnecting.
 */
function contentOf(connection: DaemonConnection): BootCoverContent {
  switch (serviceBootStageOf(connection)) {
    case "notAnswering":
      return { kind: "notAnswering" };
    case "answered":
      return { kind: "working", line: undefined, spokenLine: undefined };
    case "awaitingAnswer": {
      if (connection.kind === "unreported") {
        return { kind: "working", line: undefined, spokenLine: undefined };
      }
      const awaited: DaemonConnection =
        connection.kind === "transient_disconnect" ? { kind: "connecting" } : connection;
      return {
        kind: "working",
        line: describeDaemonConnectionSentence(awaited),
        spokenLine: describeDaemonConnection(
          awaited.kind === "repairing" ? { kind: "repairing", progress: undefined } : awaited,
        ),
      };
    }
  }
}

function contentsAreEqual(left: BootCoverContent, right: BootCoverContent): boolean {
  return left.kind === "working" && right.kind === "working"
    ? lineWords(left.line) === lineWords(right.line)
    : left.kind === right.kind;
}

function lineWords(line: readonly FigureSentencePart[] | undefined): string | undefined {
  return line === undefined ? undefined : joinFigureSentence(line);
}

/**
 * Whether the cover's fade is running; a DOM shim with no animations runs none. Read by property
 * rather than by `CSSTransition`, since the cover is drawn in its window's own document, whose
 * constructors are not this realm's; reading it starts a fade that is due.
 */
function isFadeRunning(cover: HTMLElement): boolean {
  if (typeof cover.getAnimations !== "function") {
    return false;
  }
  return cover
    .getAnimations()
    .some(
      (animation) =>
        (animation as Partial<Pick<CSSTransition, "transitionProperty">>).transitionProperty ===
        "opacity",
    );
}
