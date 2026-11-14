import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import type {
  McpDeclaredConfigMember,
  McpServerConfigInput,
  McpWritableBindingRef,
} from "@ai-sidekicks/contracts/mcp/server";
import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";
import type { ProviderSection } from "@ai-sidekicks/contracts/provider/settings";
import { Switch } from "#renderer/components/Switch/Switch.js";
import { TextBox } from "#renderer/components/TextBox/TextBox.js";
import type { Clock } from "#renderer/lib/clock.js";
import { useProviderSections } from "#renderer/store/providers/hooks/useProviderSections.js";
import type { SessionDirectoryState } from "#renderer/store/session/directory/state.js";
import { takeWriteOnlyValue } from "#renderer/features/settings/write-only-field.js";
import { HeldPairValues } from "../held-pair-values.js";
import type { McpMutationOutcome } from "../mutation.js";
import { MCP_SCOPE_WORDS, WRITABLE_MCP_SCOPES, type McpWritableScope } from "../scope-words.js";
import type { McpAddressTransport, McpServerRunKind, ServerDraft } from "../server-draft.js";
import { SERVER_TRANSPORT_WORDS } from "../transport-words.js";
import { MutationOutcomeLine } from "./MutationOutcomeLine.js";
import { NameValuePairs } from "./NameValuePairs.js";
import {
  attachedProjectsOf,
  ProjectListStatus,
  type ProjectListReading,
} from "./ProjectListStatus.js";

/**
 * `Add a server`: the server's name, provider, where it applies (with the project, for a project's
 * scopes), how it runs and what it runs or reaches, the members the provider's driver takes, and
 * the environment variables or headers as name-and-value pairs; `Add the server` hands the binding
 * and its declaration to `onSend`, and `Cancel` to `onCancel`.
 *
 * A typed value is held only by this form, and only until `Add the server`: each pair's value from
 * its `Add` or in its own field, outside any React state, and the address in its own field. The
 * submit reads every one, a pair row typed whole as though it had been added, clears every field
 * in the same step, and only then sends, so whether the send lands or is refused the form holds
 * none. `Add the server` is not pressable until the form names where the server goes, nor while
 * this form's send or another opening's is on its way. Only what the provider's driver declares is
 * offered; nothing here names a provider.
 */
export function AddServerForm(props: {
  /** What the form opens with. */
  readonly draft: ServerDraft;
  /** The last send's outcome, drawn under the form's buttons. */
  readonly outcome: McpMutationOutcome;
  /** The service's projects, which the project chooser offers. */
  readonly projects: ProjectListReading;
  /** True while a send from an earlier opening of the form is on its way. */
  readonly isAnotherSendInFlight: boolean;
  readonly onSend: (binding: McpWritableBindingRef, config: McpServerConfigInput) => void;
  readonly onCancel: () => void;
  readonly sessionDirectory: SessionDirectoryState;
  readonly clock: Clock;
}): ReactNode {
  const { draft, outcome, projects, onSend, onCancel, sessionDirectory, clock } = props;
  const providerSections = useProviderSections();
  const fieldIdPrefix = useId();
  const [serverName, setServerName] = useState(draft.name);
  const [providerId, setProviderId] = useState<ProviderId | undefined>(undefined);
  const [scope, setScope] = useState<McpWritableScope>("user");
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [chosenRunKind, setRunKind] = useState<McpServerRunKind>(draft.runKind);
  const [command, setCommand] = useState(draft.command);
  const [argumentLines, setArgumentLines] = useState(draft.argumentLines);
  const [startupTimeout, setStartupTimeout] = useState("");
  const [mustStart, setMustStart] = useState(false);
  const [addedEnvironmentNames, setAddedEnvironmentNames] = useState<readonly string[]>([]);
  const [addedHeaderNames, setAddedHeaderNames] = useState<readonly string[]>([]);
  // The pairs' values: never React state, so no render or inspection of it holds one.
  const [heldValues] = useState(() => ({
    environment: new HeldPairValues(),
    headers: new HeldPairValues(),
  }));
  const addressInput = useRef<HTMLInputElement>(null);

  const section =
    providerSections.find((candidate) => candidate.provider === providerId) ?? providerSections[0];
  const runKinds = section === undefined ? [] : runKindsOf(section);
  const runKind = runKinds.includes(chosenRunKind) ? chosenRunKind : runKinds[0];
  const addressTransport = section === undefined ? undefined : addressTransportOf(section, draft);
  const declares = (member: McpDeclaredConfigMember): boolean =>
    section?.mcp.configMembers.includes(member) === true;
  const attachedProjects = attachedProjectsOf(projects.state);
  const project =
    attachedProjects.find((candidate) => candidate.projectId === projectId) ?? attachedProjects[0];
  const binding =
    section === undefined
      ? undefined
      : bindingOf(section.provider, scope, serverName.trim(), project);
  // A command runs over `stdio`; an address over the transport the provider takes for one.
  const transport =
    runKind === "command" ? "stdio" : runKind === "address" ? addressTransport : undefined;
  const isSendHeld =
    binding === undefined ||
    transport === undefined ||
    outcome.kind === "sending" ||
    props.isAnotherSendInFlight;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // `Add the server` is not pressable while the send is held, so the form is never sent then.
    if (isSendHeld || binding === undefined || transport === undefined) {
      return;
    }
    // Every typed value is read and cleared here, before anything is sent, so no path out of this
    // handler leaves one in the form.
    const environment = heldValues.environment.take();
    const headers = heldValues.headers.take();
    const address = takeWriteOnlyValue(addressInput.current).trim();
    setAddedEnvironmentNames([]);
    setAddedHeaderNames([]);
    const memberValues = {
      ...(declares("startupTimeoutSec") && startupTimeout !== ""
        ? { startupTimeoutSec: Number(startupTimeout) }
        : {}),
      ...(declares("required") ? { required: mustStart } : {}),
    };
    if (transport === "stdio") {
      const commandArguments = argumentLines
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      onSend(binding, {
        transport: "stdio",
        command: command.trim(),
        ...(commandArguments.length === 0 ? {} : { args: commandArguments }),
        ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
        ...memberValues,
      });
      return;
    }
    onSend(binding, {
      transport,
      url: address,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...memberValues,
    });
  };

  const fieldId = (field: string): string => `${fieldIdPrefix}-${field}`;
  return (
    <form className="meridian-mcp__add-form" onSubmit={onSubmit}>
      <label className="meridian-form__field">
        <span className="meridian-form__label">Name</span>
        <input
          className="meridian-form__input meridian-form__input--wire"
          type="text"
          required
          autoComplete="off"
          spellCheck={false}
          value={serverName}
          onChange={(event) => {
            setServerName(event.currentTarget.value);
          }}
        />
      </label>
      <label className="meridian-form__field">
        <span className="meridian-form__label">Provider</span>
        <select
          className="meridian-form__input"
          required
          value={section?.provider ?? ""}
          onChange={(event) => {
            const picked = providerSections.find(
              (candidate) => candidate.provider === event.currentTarget.value,
            );
            setProviderId(picked?.provider);
          }}
        >
          {providerSections.map((candidate) => (
            <option key={candidate.provider} value={candidate.provider}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label className="meridian-form__field">
        <span className="meridian-form__label">Where it applies</span>
        <select
          className="meridian-form__input"
          value={scope}
          onChange={(event) => {
            const picked = WRITABLE_MCP_SCOPES.find(
              (candidate) => candidate === event.currentTarget.value,
            );
            if (picked !== undefined) {
              setScope(picked);
            }
          }}
        >
          {WRITABLE_MCP_SCOPES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {MCP_SCOPE_WORDS[candidate]}
            </option>
          ))}
        </select>
      </label>
      {scope === "user" ? null : (
        <div className="meridian-form__field">
          <label className="meridian-form__label" htmlFor={fieldId("project")}>
            Project
          </label>
          <ProjectListStatus projects={projects} clock={clock} />
          {projects.state.status === "served" ? (
            <select
              id={fieldId("project")}
              className="meridian-form__input"
              required
              value={project?.projectId ?? ""}
              onChange={(event) => {
                setProjectId(event.currentTarget.value);
              }}
            >
              {attachedProjects.map((candidate) => (
                <option key={candidate.projectId} value={candidate.projectId}>
                  {candidate.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      )}
      <label className="meridian-form__field">
        <span className="meridian-form__label">How it runs</span>
        <select
          className="meridian-form__input"
          value={runKind ?? ""}
          onChange={(event) => {
            const picked = runKinds.find((candidate) => candidate === event.currentTarget.value);
            if (picked !== undefined) {
              setRunKind(picked);
            }
          }}
        >
          {runKinds.map((candidate) => (
            <option key={candidate} value={candidate}>
              {RUN_KIND_WORDS[candidate]}
            </option>
          ))}
        </select>
      </label>
      {runKind === "command" ? (
        <>
          <label className="meridian-form__field">
            <span className="meridian-form__label">Command</span>
            <input
              className="meridian-form__input meridian-form__input--wire"
              type="text"
              required
              autoComplete="off"
              spellCheck={false}
              value={command}
              onChange={(event) => {
                setCommand(event.currentTarget.value);
              }}
            />
          </label>
          <div className="meridian-form__field">
            <label className="meridian-form__label" htmlFor={fieldId("arguments")}>
              Arguments
            </label>
            <TextBox
              id={fieldId("arguments")}
              className="meridian-form__input meridian-form__input--wire"
              fieldClassName="meridian-form__text-area"
              rows={2}
              maxRows={8}
              placeholder="One per line, in order"
              spellCheck={false}
              value={argumentLines}
              onChange={(event) => {
                setArgumentLines(event.currentTarget.value);
              }}
            />
          </div>
        </>
      ) : null}
      {runKind === "address" ? (
        <label className="meridian-form__field">
          <span className="meridian-form__label">Address</span>
          <input
            ref={addressInput}
            className="meridian-form__input meridian-form__input--wire"
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            defaultValue={draft.address}
          />
        </label>
      ) : null}
      {declares("startupTimeoutSec") ? (
        <label className="meridian-form__field">
          <span className="meridian-form__label">Start-up timeout</span>
          <span className="meridian-mcp__figure-field">
            <input
              className="meridian-form__input"
              type="number"
              min={1}
              step={1}
              value={startupTimeout}
              onChange={(event) => {
                setStartupTimeout(event.currentTarget.value);
              }}
            />
            <span className="meridian-settings-page__aside">seconds</span>
          </span>
        </label>
      ) : null}
      {declares("required") ? (
        <div className="meridian-form__field">
          <Switch
            label="Must start for a run to start"
            checked={mustStart}
            aria-describedby={fieldId("must-start")}
            onCheckedChange={setMustStart}
          />
          <span id={fieldId("must-start")} className="meridian-settings-page__aside">
            A run does not begin until this server is up.
          </span>
        </div>
      ) : null}
      {runKind === "command" ? (
        <NameValuePairs
          kind="environment"
          askedNames={draft.environmentVariables}
          addedNames={addedEnvironmentNames}
          heldValues={heldValues.environment}
          onNameAdded={(name) => {
            setAddedEnvironmentNames((held) => (held.includes(name) ? held : [...held, name]));
          }}
        />
      ) : (
        <NameValuePairs
          kind="headers"
          askedNames={draft.headers}
          addedNames={addedHeaderNames}
          heldValues={heldValues.headers}
          onNameAdded={(name) => {
            setAddedHeaderNames((held) => (held.includes(name) ? held : [...held, name]));
          }}
        />
      )}
      <p className="meridian-settings-page__aside">
        Values are stored by the provider and are never shown here again. Type a new one to replace
        it.
      </p>
      <span className="meridian-mcp__add-actions">
        <button
          type="submit"
          className={
            "meridian-settings-page__action " +
            "meridian-settings-page__action--primary meridian-action-button"
          }
          disabled={isSendHeld}
        >
          Add the server
        </button>
        <button
          type="button"
          className="meridian-settings-page__action meridian-action-button"
          onClick={onCancel}
        >
          Cancel
        </button>
      </span>
      <MutationOutcomeLine outcome={outcome} sessionDirectory={sessionDirectory} clock={clock} />
    </form>
  );
}

/** The words `How it runs` offers each run kind in. */
const RUN_KIND_WORDS: Readonly<Record<McpServerRunKind, string>> = {
  command: SERVER_TRANSPORT_WORDS.stdio,
  address: SERVER_TRANSPORT_WORDS.http,
};

/** How a provider's servers may run, by the transports its driver declares. */
function runKindsOf(section: ProviderSection): readonly McpServerRunKind[] {
  const { transports } = section.mcp;
  return [
    ...(transports.includes("stdio") ? (["command"] as const) : []),
    ...(transports.some((transport) => transport !== "stdio") ? (["address"] as const) : []),
  ];
}

/**
 * The transport an address is reached over: the one a registry result names where the provider
 * takes it, otherwise `http` where the provider takes it, otherwise the provider's other one.
 */
function addressTransportOf(
  section: ProviderSection,
  draft: ServerDraft,
): McpAddressTransport | undefined {
  const offered = section.mcp.transports.filter(
    (transport): transport is McpAddressTransport => transport !== "stdio",
  );
  if (draft.addressTransport !== undefined && offered.includes(draft.addressTransport)) {
    return draft.addressTransport;
  }
  return offered.includes("http") ? "http" : offered[0];
}

/** The binding the form writes: none for a project's scope until a project is attached. */
function bindingOf(
  provider: ProviderId,
  scope: McpWritableScope,
  serverName: string,
  project: ProjectListEntry | undefined,
): McpWritableBindingRef | undefined {
  if (scope === "user") {
    return { scope, provider, serverName };
  }
  if (project === undefined) {
    return undefined;
  }
  return {
    scope,
    provider,
    scopeRef: project.folderPath,
    ...(typeof project.place === "object" ? { place: project.place } : {}),
    serverName,
  };
}
