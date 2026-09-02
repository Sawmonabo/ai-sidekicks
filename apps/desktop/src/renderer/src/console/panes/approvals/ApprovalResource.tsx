// The requested resource, as the structured value the reply carries.
//
// HOISTED OUT OF `ApprovalCard.tsx` ON ITS SECOND USE. The card shows this behind a
// disclosure, and the provider-ask framing shows the same value inline — for a
// permission ask the resource IS the question, so putting it behind a click would
// ask someone to approve an action they have to expand to read. Two renderings of
// one value, and one implementation of it: a second copy would drift the first time
// one of them grew an arm, and the sentence below — which is copy, not a value —
// would then exist twice in two wordings.
//
// The member is required on the wire, so "no descriptor" is not a state a conformant
// row can be in — a row missing it never parses and is counted unreadable instead.
// What IS reachable is a descriptor carrying no members at all, and that is said in
// as many words rather than rendered as a blank panel.

import { WireFigure, formatWireDescriptor } from "../../primitives/index.js";

export interface ApprovalResourceProps {
  readonly descriptor: Readonly<Record<string, unknown>>;
}

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
