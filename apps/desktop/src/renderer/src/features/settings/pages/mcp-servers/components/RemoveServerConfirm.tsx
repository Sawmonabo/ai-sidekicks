import type { ReactNode } from "react";

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { useInlineConfirm } from "#renderer/hooks/useInlineConfirm.js";
import { useProviderName } from "#renderer/store/providers/hooks/useProviderName.js";

/**
 * `Remove`'s confirm, drawn in place of the control: what removing the server does, then `Cancel`
 * and `Remove`. It takes focus on `Cancel`, and Escape cancels it.
 */
export function RemoveServerConfirm(props: {
  readonly serverName: string;
  readonly provider: ProviderId;
  readonly onCancel: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  const { serverName, provider, onCancel, onRemove } = props;
  const providerName = useProviderName(provider);
  const confirm = useInlineConfirm(onCancel);
  return (
    <div
      ref={confirm.ref}
      className="meridian-mcp__confirm"
      role="group"
      aria-label="Remove"
      onKeyDown={confirm.onKeyDown}
    >
      <p className="meridian-mcp__confirm-words">
        Remove <WireFigure value={serverName} />? It stops being offered to {providerName}. Nothing
        it wrote is touched.
      </p>
      <span className="meridian-mcp__add-actions">
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={
            "meridian-settings-page__action " +
            "meridian-action-button meridian-action-button--destructive"
          }
          onClick={onRemove}
        >
          Remove
        </button>
      </span>
    </div>
  );
}
