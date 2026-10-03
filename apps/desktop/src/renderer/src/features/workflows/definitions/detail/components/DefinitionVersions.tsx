// The version chain a definition's pinned version belongs to. `unaddressable` draws nothing: the
// definition read carried no opaque version id, and the console composes none from the number.

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import type { WorkflowVersionChainReading } from "../hooks/useWorkflowDefinitionDetail.js";

/** The chain reading to draw. An unaddressable chain draws nothing. */
export interface DefinitionVersionsProps {
  readonly chain: WorkflowVersionChainReading;
}

/** The chain's versions once served, and nothing where the chain is unaddressable. */
export function DefinitionVersions(props: DefinitionVersionsProps): React.JSX.Element {
  const { chain } = props;
  if (chain.status === "unaddressable") {
    return <></>;
  }
  return (
    <section className="meridian-definition-detail__chain">
      <h4 className="meridian-definition-detail__heading">
        Versions <WireFigure value={formatCount(chain.versions.length)} />
      </h4>
      <ol className="meridian-definition-detail__chain-list">
        {chain.versions.map((entry) => (
          <li key={entry.workflowVersionId}>
            <WireFigure value={formatCount(entry.versionNumber)} />
            <WireFigure value={entry.workflowVersionId} />
          </li>
        ))}
      </ol>
    </section>
  );
}
