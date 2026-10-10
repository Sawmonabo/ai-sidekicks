// The quiet cover a window draws over itself until the background service first answers: the
// working indicator and one line saying what main is doing, or, once main has given up, the card
// saying the service is not answering with its `Retry`. Nothing is drawn under it until the answer,
// so the console it fades from is never half painted. The window has no frame yet, so the cover
// mounts its own announcer, and the whole cover is the window's drag region.

import "./BootCover.css";

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { FigureSentence } from "#renderer/components/FigureSentence/FigureSentence.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { StandingContent } from "#renderer/components/LiveAnnouncer/StandingContent.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { WorkingIndicator } from "#renderer/components/WorkingIndicator/WorkingIndicator.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import type { FigureSentencePart } from "#renderer/lib/figure-sentence.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import { useDaemonStartAction, type DaemonStartCall } from "./hooks/useDaemonStartAction.js";
import type { DrawnBootCover } from "./hooks/useBootCover.js";

/** What a window hands its boot cover. */
export interface BootCoverProps {
  readonly cover: DrawnBootCover;
  /** Asks main to start the service again with a full set of attempts: the card's `Retry`. */
  readonly requestStart: DaemonStartCall;
}

/** The boot cover, holding the working line or the not-answering card, fading once answered. */
export function BootCover(props: BootCoverProps): React.JSX.Element {
  const { cover } = props;
  const clock = useClock();
  return (
    <div
      ref={cover.coverRef}
      className="meridian-boot-cover"
      data-fading={cover.isFading ? "" : undefined}
      data-not-answering={cover.content.kind === "notAnswering" ? "" : undefined}
      inert={cover.isFading}
      aria-busy={cover.content.kind === "working"}
      onTransitionEnd={cover.onTransitionEnd}
    >
      <LiveAnnouncerProvider clock={clock}>
        {/* Only the cover's first line stands; the card, a failure, is said even when drawn first. */}
        <StandingContent>
          {cover.content.kind === "working" ? (
            <WorkingLine line={cover.content.line} spokenLine={cover.content.spokenLine} />
          ) : null}
        </StandingContent>
        {cover.content.kind === "notAnswering" ? (
          <NotAnsweringCard requestStart={props.requestStart} />
        ) : null}
      </LiveAnnouncerProvider>
    </div>
  );
}

/** The working indicator and the line; a change of what main is doing is said, a new count not. */
function WorkingLine(props: {
  readonly line: readonly FigureSentencePart[] | undefined;
  readonly spokenLine: string | undefined;
}): React.JSX.Element {
  useAnnounceWhenChanged(props.spokenLine, "polite");
  return (
    <>
      <WorkingIndicator />
      {props.line === undefined ? null : (
        <p className="meridian-boot-cover__line">
          <FigureSentence parts={props.line} />
        </p>
      )}
    </>
  );
}

/** The card in place of an empty console: the service is not answering, and `Retry`. */
function NotAnsweringCard(props: { readonly requestStart: DaemonStartCall }): React.JSX.Element {
  const retry = useDaemonStartAction(props.requestStart);
  return (
    <>
      <AnnouncedLine
        element="p"
        className="meridian-boot-cover__card-line"
        words={NOT_ANSWERING_MESSAGE}
        politeness="assertive"
      />
      <span className="meridian-boot-cover__retry">
        <TryAgainButton
          word="Retry"
          onPress={() => {
            retry().catch((failure: unknown) => {
              recordRejectedRequest("layout/AppShell", "service-start-not-requested", failure);
            });
          }}
        />
      </span>
    </>
  );
}
