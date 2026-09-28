// The version chain a definition's pinned version belongs to.
//
// ITS OWN MODULE BECAUSE EVERY `.tsx` HOLDS ONE COMPONENT — the module-shape rule in
// `apps/desktop/AGENTS.md`, held in review. It is composed from `DefinitionDetail.tsx`
// and from nothing else.
//
// THE SECOND ARM DRAWS NOTHING. `unaddressable` means the definition read carried no opaque
// version id, so the chain read could not be put at all — the console composes no id from
// the version NUMBER, because no encoding over that pair exists on this wire.

import { WireFigure, formatCount } from "../../../primitives/index.js";
import type { WorkflowVersionChainReading } from "./definition-detail-read.js";

/** The chain reading to draw. An unaddressable chain draws nothing. */
export interface DefinitionChainProps {
  readonly chain: WorkflowVersionChainReading;
}

/** The chain's versions once served, and nothing where the chain is unaddressable. */
export function DefinitionChain(props: DefinitionChainProps): React.JSX.Element {
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
