import { useId, useState, type ReactNode } from "react";

import type {
  McpRegistrySearchResponse,
  McpRegistryServer,
} from "@ai-sidekicks/contracts/mcp/server";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { useSubjectRead } from "#renderer/hooks/useSubjectRead.js";
import type { Clock } from "#renderer/lib/clock.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import type { DaemonReply } from "#renderer/services/daemon/reply.js";
import { useTypingPause } from "../hooks/useTypingPause.js";
import type { SearchMcpRegistry } from "../mutation.js";
import { registryRunWords } from "../server-draft.js";

/**
 * How long typing must pause before the search is sent: one search per pause rather than one per
 * keystroke, each of which the service turns into a request to the public registry.
 */
const REGISTRY_SEARCH_PAUSE_MS = 300;

/**
 * `Browse servers`: a search over the public MCP Registry, sent through the service only once the
 * person has typed, a newer search replacing the answer an older one would give. Each result reads
 * its title or name, its description, its version and how it runs, and a press on one hands it to
 * `onPick`; `Cancel` hands over to `onCancel`. Only the first page of results is drawn.
 */
export function BrowseServers(props: {
  readonly searchRegistry: SearchMcpRegistry;
  readonly clock: Clock;
  readonly onPick: (server: McpRegistryServer) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { searchRegistry, clock, onPick, onCancel } = props;
  const lineId = useId();
  const [typed, setTyped] = useState("");
  const [readRevision, setReadRevision] = useState(0);
  const query = useTypingPause(clock, typed.trim(), REGISTRY_SEARCH_PAUSE_MS);
  const { value: search } = useSubjectRead<DaemonReply<McpRegistrySearchResponse>, RegistrySearch>(
    searchRegistry,
    query === "" ? undefined : query,
    (key, signal) => (key === undefined ? undefined : searchRegistry({ query: key }, signal)),
    {
      unsettled: (key) => (key === undefined ? { kind: "idle" } : { kind: "searching" }),
      settled: (reply) =>
        reply.status === "served"
          ? { kind: "served", servers: reply.value.servers }
          : { kind: "failed", refusal: reply.refusal },
    },
    readRevision,
  );
  return (
    <section className="meridian-mcp__browse" aria-label="Browse servers">
      <h4 className="meridian-settings-page__section-head">Browse servers</h4>
      <input
        className="meridian-form__input"
        type="search"
        aria-label="Search the MCP Registry"
        aria-describedby={lineId}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(event) => {
          setTyped(event.currentTarget.value);
        }}
      />
      <p id={lineId} className="meridian-settings-page__aside">
        Searches the public MCP Registry. Anyone can publish there; check a server&rsquo;s source
        before adding it.
      </p>
      {search.kind === "searching" ? (
        <LoadingNotice clock={clock} placement="block" title="Loading…" />
      ) : null}
      {search.kind === "failed" ? (
        <InlineRefusal
          code={search.refusal.code}
          detail="Couldn't load servers"
          onTryAgain={() => {
            setReadRevision((revision) => revision + 1);
          }}
        />
      ) : null}
      {search.kind === "served" && search.servers.length === 0 ? (
        <Nothing kind="empty" placement="block" title="No matching servers" />
      ) : null}
      {search.kind === "served" && search.servers.length > 0 ? (
        <ul className="meridian-mcp__entries" aria-label="Registry servers">
          {search.servers.map((server) => (
            <li key={`${server.name} ${server.version}`}>
              <button
                type="button"
                className="meridian-mcp__entry"
                onClick={() => {
                  onPick(server);
                }}
              >
                <span className="meridian-mcp__entry-identity">
                  <span>{server.title ?? server.name}</span>
                  <WireFigure value={server.version} />
                </span>
                <span className="meridian-mcp__entry-note meridian-settings-page__aside">
                  {server.description}
                </span>
                <span className="meridian-mcp__entry-place meridian-settings-page__aside">
                  {registryRunWords(server)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="meridian-mcp__add-actions">
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          onClick={onCancel}
        >
          Cancel
        </button>
      </span>
    </section>
  );
}

/** Where the registry search stands: nothing typed, a search on its way, its page, or refused. */
type RegistrySearch =
  | { readonly kind: "idle" }
  | { readonly kind: "searching" }
  | { readonly kind: "served"; readonly servers: readonly McpRegistryServer[] }
  | { readonly kind: "failed"; readonly refusal: Refusal };
