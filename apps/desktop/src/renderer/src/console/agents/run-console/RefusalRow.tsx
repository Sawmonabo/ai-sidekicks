import { WireFigure, formatCount } from "../../primitives/index.js";
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
