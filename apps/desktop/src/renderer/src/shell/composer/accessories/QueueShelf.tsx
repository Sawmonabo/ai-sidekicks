// The queue shelf: what this participant has waiting, and where it is bound.
//
// Hidden until an item exists. That is not a styling choice — an empty shelf and a
// shelf nobody has read yet are both "no rows", and a strip that said so would sit
// above the composer forever announcing the ordinary case. When there IS something
// queued the shelf appears, and its appearing is the signal.
//
// NO REORDER CONTROL EXISTS. Not disabled, not hidden behind a menu: the wire has
// no reorder verb, so offering the gesture at all would be the console promising an
// operation the daemon cannot perform. Priority is the daemon's and is shown as it
// was sent.
//
// AND A PARTIAL READING IS SAID EVEN WHEN NOTHING IS WAITING. A queue delivery this
// build could not read changed no row, which is exactly why the rows alone cannot
// show it: a shelf whose list did not move looks like a queue that did not move. So
// the count and its parse refusal render ABOVE the rows rather than in place of
// them — the rows are still the best reading there is and are no longer offered as a
// complete one — and the hidden-until-an-item-exists rule above yields to it, because
// an empty list beside an unreadable delivery is not the ordinary case the rule
// exists to keep quiet: it is a list whose emptiness is unknown.
//
// A REFUSED SNAPSHOT IS THE SAME CLAIM WITH A DIFFERENT CAUSE, and it yields the
// hidden arm for the same reason. The tail opens BEFORE the snapshot is taken, so a
// refused `run.queueList` leaves the shelf holding whatever the tail happened to
// deliver in that window — nothing at all, or a subset — and neither is the queue.
// An empty shelf would then say "nothing is waiting" about a list nobody managed to
// read, and a subset would present the window's arrivals as the whole of it. So the
// phase and the read's own refusal reach this surface and are said.
//
// BOTH READINGS GO TO ONE PRIMITIVE, AND THE SHELF WRITES NO COPY. `PartialRead`
// (`primitives/PartialRead.tsx`) takes the SET of readings a surface holds and says a
// sentence for every one that did not serve, so the two causes are two notices rather
// than one merged sentence that would have to drop a refusal, and the shelf cannot
// mount a notice for its snapshot while quietly leaving its tail unreported. What
// used to stand here was this family's own notice component and its own two
// sentences, which is how one console came to say "may be stale" about the same fact
// another called "may be behind the registry".
//
// A CANCEL IN FLIGHT DISABLES ITS OWN ROW AND NO OTHER. The shelf renders the state
// the reading publishes rather than holding its own: the same set the runs pane's
// queue reads, so two surfaces over one reading never disagree about which row is
// going. The row is `disabled` and `aria-busy` while its id is pending — the
// authoritative single-flight is the reading's own chokepoint, and this is what a
// person sees of it.

import {
  DerivedFigure,
  PartialRead,
  formatCount,
  unreadableDeliveryReading,
  type ReadingState,
} from "../../../console/primitives/index.js";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";
import type { QueueReadPhase } from "../../../console/bridge/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import { QUEUE_SHELF_ROW_CAP } from "./accessory-bounds.js";
import { QueueShelfRow } from "./QueueShelfRow.js";

export interface QueueShelfProps {
  readonly items: readonly QueueItemSummary[];
  /**
   * How the session's snapshot read has gone, straight off the one reading.
   *
   * Required rather than optional, unlike the partial-read pair below: every caller
   * of this shelf reads the feed that carries it, so a caller with nothing to pass
   * is a caller that has stopped reading the queue — and defaulting it would make
   * this surface answer "read" for a snapshot nobody asked about.
   */
  readonly phase: QueueReadPhase;
  /** Why the snapshot could not be read. Rendered rather than swallowed. */
  readonly readRefusal: ConsoleRefusal | undefined;
  /** The ids whose cancel is in flight, straight off the session's one reading. */
  readonly pendingCancelIds: ReadonlySet<string>;
  readonly cancelRefusalByItemId: ReadonlyMap<string, ConsoleRefusal>;
  readonly onCancel: (queueItemId: string) => void;
  /**
   * Queue deliveries that parsed as no registered row since the newest snapshot.
   *
   * The shelf derives whether it is partial FROM this count rather than taking a
   * second flag beside it, exactly as the session queue reading derives its own, so
   * the two can never disagree about whether the rows are complete.
   *
   * Optional at this branch point and nowhere else: the member lands on `QueueFeed`
   * in the session-queue reading's own lane, and `ComposerAccessoryRail` supplies it
   * the moment both are in one tree. Absent means the caller passed no partial
   * reading at all — which this surface renders as the complete arm, because there
   * is no count from which to claim otherwise.
   */
  readonly unreadableDeliveryCount?: number | undefined;
  /** The newest unreadable delivery's own parse refusal, rendered beside the count. */
  readonly unreadableRefusal?: ConsoleRefusal | undefined;
}

export function QueueShelf(props: QueueShelfProps): React.JSX.Element | null {
  const unreadableDeliveryCount = props.unreadableDeliveryCount ?? 0;
  const isPartial = unreadableDeliveryCount > 0;
  const isSnapshotRefused = props.phase === "refused";
  if (props.items.length === 0 && !isPartial && !isSnapshotRefused) {
    return null;
  }
  const rendered = props.items.slice(0, QUEUE_SHELF_ROW_CAP);
  const foldedCount = props.items.length - rendered.length;
  return (
    <section className="meridian-queue-shelf" aria-label="Queued messages">
      <PartialRead
        states={[snapshotReading(props.phase, props.readRefusal), deliveryReading(props)]}
        subject="the queue"
      />
      <ul className="meridian-queue-shelf__rows">
        {rendered.map((item) => (
          <QueueShelfRow
            key={item.id}
            item={item}
            isCancelPending={props.pendingCancelIds.has(item.id)}
            refusal={props.cancelRefusalByItemId.get(item.id)}
            onCancel={props.onCancel}
          />
        ))}
      </ul>
      {foldedCount > 0 ? (
        <p className="meridian-queue-shelf__fold">
          <DerivedFigure text={`+${formatCount(foldedCount)} more waiting`} />
        </p>
      ) : null}
    </section>
  );
}

/**
 * The snapshot read, in the console's one reading vocabulary.
 *
 * `beside-an-answer` and never `whole-answer`: the tail opens BEFORE the snapshot is
 * taken, so a refused `run.queueList` leaves the shelf holding whatever the tail
 * delivered in that window, and the rows on screen are a fragment of unknown size
 * rather than nothing at all.
 *
 * A cause is REQUIRED by that arm and the reading's sole refusing writer takes one,
 * so the pairing is proved where it is produced and only the type is loose here. The
 * unstated-cause constant below is what keeps this total without claiming a
 * completeness the phase has just denied.
 */
function snapshotReading(
  phase: QueueReadPhase,
  readRefusal: ConsoleRefusal | undefined,
): ReadingState {
  switch (phase) {
    case "read":
      return { kind: "served" };
    case "reading":
      return { kind: "reading" };
    case "refused":
      // A cause was carried, which is the ordinary arm and the only one the reading
      // produces: its single refusing writer takes a `ConsoleRefusal` and sets the
      // phase in the same act.
      //
      // A cause was NOT carried — unreachable from that writer, and answered anyway,
      // because the alternative at this branch is `served`, which is the shelf
      // claiming to be the whole queue on the strength of a read that was refused.
      // `stale` is the one kind that withdraws the completeness claim while inventing
      // NO cause: it renders its sentence with nothing beneath it, which is exactly
      // what a refusal nobody sent should look like.
      return readRefusal === undefined
        ? { kind: "stale", refusal: undefined }
        : { kind: "refused", scope: "beside-an-answer", refusal: readRefusal };
  }
}

/** The tail's deliveries, as the count-bearing reading the model already owns. */
function deliveryReading(props: QueueShelfProps): ReadingState {
  return unreadableDeliveryReading(props.unreadableDeliveryCount ?? 0, props.unreadableRefusal);
}
