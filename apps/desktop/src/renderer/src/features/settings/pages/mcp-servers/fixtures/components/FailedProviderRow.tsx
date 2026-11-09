import type { ReactNode } from "react";

import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import { Chip } from "#renderer/components/Chip/Chip.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { useProviderName } from "#renderer/store/providers/hooks/useProviderName.js";

/** What a provider's row says where the service could not read its server list. */
const PROVIDER_READ_FAILED_WORDS = "Couldn't load the servers";

/**
 * A provider whose server list the service could not read, as a row in the server list: its
 * provider where every row names one, the failure, and `Try again` at the right, which asks for
 * the whole list again. The cause stays in the service's log.
 */
export function FailedProviderRow(props: {
  readonly provider: ProviderId;
  readonly onTryAgain: () => void;
}): ReactNode {
  const providerName = useProviderName(props.provider);
  useAnnounceWhenChanged(`${providerName} · ${PROVIDER_READ_FAILED_WORDS}`, "assertive");
  return (
    <li className="meridian-mcp__failed-entry">
      <span className="meridian-mcp__entry-identity">
        <Chip label={providerName} />
        <span>{PROVIDER_READ_FAILED_WORDS}</span>
      </span>
      <TryAgainButton onPress={props.onTryAgain} />
    </li>
  );
}
