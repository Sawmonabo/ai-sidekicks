import type { AttentionItem } from "@ai-sidekicks/contracts/attention";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatAge, formatZonedDateTime } from "#renderer/lib/wire/figures.js";
import type { AppRoute } from "#renderer/routing/routes.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { attentionEntryPlace } from "./entry-place.js";
import { ReleaseNotesButton } from "./ReleaseNotesButton.js";

/**
 * One entry, one line: a dot (waiting amber, done a hollow ring, failed a red mark), the name, the
 * daemon's state word verbatim and the age, whose hover label is the time it stands for. A button
 * when the caller supplied a way to open it, plain text otherwise, so the list never offers a
 * press that goes nowhere. A provider's update ends in `What's new`, which opens the provider's
 * release notes for the new build.
 */
export function NotificationEntry(props: {
  readonly item: AttentionItem;
  readonly nowMilliseconds: number;
  readonly onOpen: ((place: AppRoute) => void) | undefined;
}): React.JSX.Element {
  const { item, onOpen } = props;
  const clockLocale = useClockLocale();
  const body = (
    <>
      <span
        className={`meridian-attention__dot meridian-attention__dot--${entryState(item)}`}
        aria-hidden="true"
      />
      <span className="meridian-attention__name">{item.displayName}</span>
      <span className="meridian-attention__state">{item.stateWord}</span>
      <WireFigure
        value={formatAge(item.createdAt, props.nowMilliseconds)}
        hoverLabel={formatZonedDateTime(item.createdAt, clockLocale)}
      />
    </>
  );
  const row =
    onOpen === undefined ? (
      <div className="meridian-attention__row">{body}</div>
    ) : (
      <button
        type="button"
        className="meridian-attention__row meridian-attention__row--open"
        onClick={() => {
          onOpen(attentionEntryPlace(item));
        }}
      >
        {body}
      </button>
    );
  const releaseNotesAddress =
    item.trigger === "providerBuild" ? item.providerBuild.releaseNotesAddress : undefined;
  if (releaseNotesAddress === undefined) {
    return row;
  }
  return (
    <div className="meridian-attention__line">
      {row}
      <ReleaseNotesButton address={releaseNotesAddress} />
    </div>
  );
}

/** Which of the three dots an entry wears: actionable waits on the person, a failed run failed. */
function entryState(item: AttentionItem): "waiting" | "done" | "failed" {
  if (item.severity === "actionable") {
    return "waiting";
  }
  return item.trigger === "runFailed" ? "failed" : "done";
}
