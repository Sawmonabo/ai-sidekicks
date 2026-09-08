// One node's own declaration, beside the roster row that names it.
//
// WHAT THIS ROW RENDERS, AND WHAT IT DELIBERATELY DOES NOT. The absorbed roster
// already renders five of the wire entry's members — the two health axes, the access
// verdict, the heartbeat instant, and the node id — and this page's own header states
// that it adds chrome and no second projection of any of them. So this row renders the
// two members the roster renders NOWHERE: the capability map the node declared about
// itself, and, for a node below the version floor, the declared client version the
// verdict was computed from.
//
// BOTH ARRIVE THROUGH A SHIPPED COMPONENT RATHER THAN A LOCAL RENDER. `CapabilityDeclaration`
// and `MixedVersionStatus` are Plan-003's, shipped and unmounted since Tier 1, and the
// console absorbs them by import through `seats/absorbed-surfaces.ts` exactly as it
// absorbs the roster itself. Formatting a capability value here would be a second
// implementation of a formatter that already handles the values `JSON.stringify`
// refuses — and deriving a floor verdict here is what that component's own header
// forbids outright.
//
// THE VERSION BLOCK IS CONDITIONAL, AND THE CONDITION IS THE WIRE'S. It renders exactly
// where `readOnly` is true, which is the server's below-floor verdict. Rendering it for
// every node would put "no refused write attempt to surface" under every row on the
// page — true, and noise, and it would bury the one row where the verdict matters.

import type { ReactNode } from "react";

import type { RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

import {
  renderAbsorbedCapabilityDeclaration,
  renderAbsorbedMixedVersionStatus,
} from "../../../seats/index.js";
import { WireFigure } from "../../../primitives/index.js";

export function NodeDeclarationRow(props: { readonly node: RuntimeNodeRosterEntry }): ReactNode {
  const { node } = props;
  return (
    <li className="meridian-node-declarations__row">
      <h4 className="meridian-node-declarations__row-title">
        <WireFigure value={node.nodeId} />
      </h4>
      <div className="meridian-node-declarations__capabilities">
        {renderAbsorbedCapabilityDeclaration(node.capabilities)}
      </div>
      {node.readOnly ? (
        <div className="meridian-node-declarations__version">
          {renderAbsorbedMixedVersionStatus(node)}
        </div>
      ) : null}
    </li>
  );
}
