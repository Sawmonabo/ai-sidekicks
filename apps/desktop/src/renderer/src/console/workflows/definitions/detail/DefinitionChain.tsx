// The version chain a definition's pinned version belongs to, or the reason there is
// none to draw.
//
// ITS OWN MODULE BECAUSE EVERY `.tsx` HOLDS ONE COMPONENT — `apps/desktop/AGENTS.md`
// §Module shape, held in review. It is composed from `DefinitionDetail.tsx` and from
// nothing else.
//
// THE THIRD ARM IS NOT A REFUSAL AND IS NOT AN EMPTY LIST. `unaddressable` means the
// definition read carried no opaque version id, so the chain read could not be put at
// all — the console composes no id from the version NUMBER, because no encoding over
// that pair exists on this wire. "Nobody asked" is what that is, and it is the
// `not-checked` kind of nothing rather than the empty one.

import { Nothing, RefusalBanner, WireFigure, formatCount } from "../../../primitives/index.js";
import type { WorkflowVersionChainReading } from "./definition-detail-read.js";

export interface DefinitionChainProps {
  readonly chain: WorkflowVersionChainReading;
}

/** The chain's three arms: served, refused, or never asked. */
export function DefinitionChain(props: DefinitionChainProps): React.JSX.Element {
  const { chain } = props;
  if (chain.status === "unaddressable") {
    return (
      <Nothing
        kind="not-checked"
        title="This definition's version chain was not asked for."
        detail="The chain read is addressed by an opaque version id, and this definition read carried none."
      />
    );
  }
  if (chain.status === "unavailable") {
    return <RefusalBanner {...chain.refusal} />;
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
