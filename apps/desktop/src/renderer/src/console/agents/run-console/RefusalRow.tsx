// One refusal, rendered verbatim, with the depth limit taken from its own payload.
//
// WHY THE ROW CARRIES A TIME. A refusal is zero-residue — no run, no queue entry, no
// link row — so this fold is the only record that the work was ever asked for. A
// record with no instant on it cannot be placed against anything else that happened:
// two refusals of the same reason read as one repeated fact, and a refusal that
// preceded a link is indistinguishable from one that followed it. The instant is on
// the payload (`ChildRunRejection.occurredAt`, folded from `orchestration.rejected`)
// and was being dropped.
//
// It renders through the family's own instant reading rather than verbatim: a bare
// ISO stamp beside four prose clauses is unreadable at a glance, and `WireFigure`'s
// `title` carries the exact wire value so the formatted reading hides nothing. An
// unparseable stamp answers the em dash `formatDateTime` gives every figure it cannot
// stand behind, which is the honest reading — never the raw string re-presented as
// though it had been understood.

import { WireFigure, formatCount, formatDateTime } from "../../primitives/index.js";
import { type ChildRunRejection } from "../../bridge/index.js";

/** One refusal, rendered verbatim, with the depth limit taken from its own payload. */
export function RefusalRow(props: { readonly rejection: ChildRunRejection }): React.JSX.Element {
  const { rejection } = props;
  return (
    <li className="meridian-linkage__refusal">
      <WireFigure value={rejection.reason} />
      {rejection.maxDepth === undefined ? null : (
        <span className="meridian-linkage__refusal-depth">
          {" "}
          The runtime allows {formatCount(rejection.maxDepth)} layer of nesting.
        </span>
      )}
      {rejection.detail === undefined ? null : (
        <span className="meridian-linkage__refusal-detail"> {rejection.detail}</span>
      )}
      {rejection.occurredAt === undefined ? null : (
        <span className="meridian-linkage__refusal-when">
          {" "}
          Refused{" "}
          <WireFigure value={formatDateTime(rejection.occurredAt)} title={rejection.occurredAt} />.
        </span>
      )}
      {rejection.targetAgentId === undefined ? null : (
        <span className="meridian-linkage__refusal-target">
          {" "}
          Asked of <WireFigure value={rejection.targetAgentId} />.
        </span>
      )}
      {rejection.targetChannelId === undefined ? null : (
        <span className="meridian-linkage__refusal-target">
          {" "}
          In <WireFigure value={rejection.targetChannelId} />.
        </span>
      )}
    </li>
  );
}
