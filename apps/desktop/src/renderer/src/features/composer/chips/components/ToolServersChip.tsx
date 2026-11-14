// The composer's tool-servers chip: `MCP N` for the session's servers switched on, `MCP` with
// none, opening the list above it: the working servers by name, a faint rule, then the dimmed ones
// needing a sign-in or failed with that word and its reason in the word's hover title, each row
// with its session-level switch, and `Manage in Settings` last.

import { Popover } from "@base-ui/react/popover";
import { useState } from "react";

import type { SessionMcpServer } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { OverlayPopoverPopup } from "#renderer/components/OverlayPopups/OverlayPopoverPopup.js";
import { Switch } from "#renderer/components/Switch/Switch.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { MCP_SERVER_STATUS_WORDS } from "#renderer/lib/mcp-server-status-words.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { WindowStore } from "#renderer/store/window/store.js";
import { useSessionMcpServers } from "../hooks/useSessionMcpServers.js";
import { updateSessionMcpServerEnabled } from "#renderer/services/daemon/session-mcp-servers.js";
import { readToolServersChip } from "../tool-servers.js";

/** What the chip reads and where its link goes. */
export interface ToolServersChipProps {
  readonly bridge: PlatformBridge;
  readonly sessionId: SessionId;
  readonly frameStore: WindowStore;
}

/** The tool-servers chip, always drawn. */
export function ToolServersChip(props: ToolServersChipProps): React.JSX.Element {
  const clock = useClock();
  const { frame, readAgain } = useSessionMcpServers(props.bridge, props.sessionId);
  const [isOpen, setIsOpen] = useState(false);
  const [refusal, setRefusal] = useState<ExtendedRefusal | undefined>(undefined);
  const chip = readToolServersChip(frame?.kind === "listed" ? frame.servers : []);
  const setEnabled = (serverName: string, enabled: boolean): void => {
    void updateSessionMcpServerEnabled(props.bridge, props.sessionId, serverName, enabled).then(
      (reply) => {
        setRefusal(reply.status === "refused" ? reply.refusal : undefined);
      },
    );
  };
  const row = (server: SessionMcpServer, isWorking: boolean): React.JSX.Element => (
    <li
      key={server.serverName}
      className={
        isWorking && server.enabled
          ? "meridian-composer-tool-server"
          : "meridian-composer-tool-server meridian-composer-tool-server--dim"
      }
    >
      <span className="meridian-composer-tool-server__name">{server.serverName}</span>
      {isWorking ? null : (
        <HoverLabel text={server.reason} textRole="description">
          <span className="meridian-composer-tool-server__state">
            {MCP_SERVER_STATUS_WORDS[server.status]}
          </span>
        </HoverLabel>
      )}
      <Switch
        checked={server.enabled}
        label={server.serverName}
        onCheckedChange={(enabled) => {
          setEnabled(server.serverName, enabled);
        }}
      />
      {server.pendingUntilNextTurn ? (
        <span className="meridian-composer-tool-server__pending">Applies at the next turn.</span>
      ) : null}
    </li>
  );
  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger className="meridian-composer-chip">{chip.label}</Popover.Trigger>
      <OverlayPopoverPopup className="meridian-composer-tool-servers" sideOffset={4}>
        {frame === undefined ? (
          <LoadingNotice title="Loading tool servers…" placement="block" clock={clock} />
        ) : frame.kind === "lost" ? (
          <p className="meridian-composer-tool-servers__empty">
            Couldn't load tool servers <TryAgainButton onPress={readAgain} />
          </p>
        ) : chip.working.length === 0 && chip.notWorking.length === 0 ? (
          <p className="meridian-composer-tool-servers__empty">No tool servers on this session.</p>
        ) : (
          <ul className="meridian-composer-tool-servers__list">
            {chip.working.map((server) => row(server, true))}
            {chip.working.length > 0 && chip.notWorking.length > 0 ? (
              <li role="separator" className="meridian-composer-tool-servers__rule" />
            ) : null}
            {chip.notWorking.map((server) => row(server, false))}
          </ul>
        )}
        {refusal === undefined ? null : (
          <InlineRefusal code={refusal.code} detail={refusal.detail} />
        )}
        <button
          type="button"
          className="meridian-clickable-word"
          onClick={() => {
            setIsOpen(false);
            props.frameStore.navigate({ kind: "settings", page: "mcp-servers" });
          }}
        >
          Manage in Settings
        </button>
      </OverlayPopoverPopup>
    </Popover.Root>
  );
}
