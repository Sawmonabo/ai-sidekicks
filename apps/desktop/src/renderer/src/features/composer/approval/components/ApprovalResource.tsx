// The requested resource as a structured value, which the card shows behind a disclosure. The
// member is required on the wire, so the reachable empty case is a descriptor with no members,
// which is said in words.

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatWireDescriptor } from "@renderer/lib/wire/figures.js";
/** The wire descriptor of what an approval asks to act on. */
export interface ApprovalResourceProps {
  readonly descriptor: Readonly<Record<string, unknown>>;
}
/** The descriptor's members as term/value pairs, or a sentence when it has none. */
export function ApprovalResource(props: ApprovalResourceProps): React.JSX.Element {
  const entries = formatWireDescriptor(props.descriptor);
  if (entries.length === 0) {
    return (
      <p className="meridian-approval-card__resource-empty">
        The reply carried a descriptor with nothing in it, so what will actually run is not shown
        here.
      </p>
    );
  }
  return (
    <dl className="meridian-approval-card__resource">
      {entries.map((entry) => (
        <div className="meridian-approval-card__resource-member" key={entry.key}>
          <dt>
            <WireFigure value={entry.key} />
          </dt>
          <dd>
            <WireFigure value={entry.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
