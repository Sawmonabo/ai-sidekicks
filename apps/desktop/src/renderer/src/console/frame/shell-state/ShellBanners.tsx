// The frame's honest lines about the runtime: the version mismatch, the outage, and
// the catch-up.
//
// THREE BANNERS AND NOT ONE, because they are three different facts and a person
// acts differently on each. `Spec-023 §Daemon Supervision Lifecycle` step 3 makes an
// incompatible handshake its own state — mutating operations blocked, reads
// permitted — and it is emphatically not a disconnect: the runtime is right there
// and answering. Wearing disconnect chrome for it would send a person to restart a
// process that is running fine.
//
// THE READ-ONLY LINE RIDES WHICHEVER BANNER IS UP rather than being a fourth one.
// It is not an independent condition — it is what the state above it costs — and a
// separate banner would let a window show "read-only" with nothing on screen saying
// why, which is exactly the silent disable the design forbids.
//
// NOTHING HERE OFFERS A REMEDY IT CANNOT PERFORM. Updating the console is an
// installer action and updating the runtime is an operator action, so the version
// banner names both and executes neither. The one control on this surface is the
// manual retry, and it is offered only after the ladder is spent, because during the
// backoff window the supervisor owns the reconnect and a second retry would race it.

import { RefusalBanner } from "../../primitives/index.js";
import type { ShellState } from "../../store/index.js";
import {
  connectionLineFor,
  describeVersionPair,
  readOnlyLine,
  recoveryLineFor,
  versionRemedyFor,
} from "./shell-sentences.js";

export interface ShellBannersProps {
  readonly state: ShellState;
  /**
   * The manual retry, offered only where the ladder is spent.
   *
   * Handed in rather than performed here: starting a stopped runtime is a shell
   * spawn and never a call, so the frame that owns the shell owns the act.
   */
  readonly onRetry: (() => void) | undefined;
}

/** Every standing shell banner, in the order a person reads them. */
export function ShellBanners(props: ShellBannersProps): React.JSX.Element | null {
  const versionBanner = renderVersionBanner(props.state);
  const connectionBanner = renderConnectionBanner(props.state, props.onRetry);
  const recoveryBanner = renderRecoveryBanner(props.state);
  if (versionBanner === null && connectionBanner === null && recoveryBanner === null) {
    return null;
  }
  return (
    <div className="meridian-shell-state__banners">
      {versionBanner}
      {connectionBanner}
      {recoveryBanner}
    </div>
  );
}

/**
 * The mismatch banner, rendered from the ack and never from a comparison.
 *
 * The gate is the daemon's; this renders its verdict. The supported set arrives on
 * the refused ack, and it is rendered beside this build's own version because
 * "update something" is not actionable and "the runtime speaks these and this
 * console speaks that" is.
 */
function renderVersionBanner(state: ShellState): React.JSX.Element | null {
  if (state.connection.kind !== "version-incompatible") {
    return null;
  }
  const { negotiation } = state;
  if (negotiation === undefined) {
    // The supervisor reported the refusal without the ack behind it. The state is
    // still true and still blocks mutation, so it is said plainly rather than
    // dropped, and no version is invented to fill the line.
    return (
      <RefusalBanner
        code="shell-version-incompatible"
        detail={`The local runtime refused this console's protocol version and did not say which versions it accepts. ${readOnlyLine()}`}
      />
    );
  }
  const remedy = versionRemedyFor(negotiation.reason);
  const supported =
    negotiation.daemonSupportedProtocols.length === 0
      ? "The runtime did not list the versions it supports."
      : `The runtime supports ${negotiation.daemonSupportedProtocols.join(", ")}.`;
  return (
    <RefusalBanner
      code={negotiation.reason ?? "shell-version-incompatible"}
      detail={`${remedy.headline} ${describeVersionPair(negotiation)} ${supported} ${remedy.remedy} ${readOnlyLine()}`}
    />
  );
}

/** The outage banner: what happened, what is stale, and the retry once it is owed. */
function renderConnectionBanner(
  state: ShellState,
  onRetry: (() => void) | undefined,
): React.JSX.Element | null {
  const line = connectionLineFor(state.connection);
  if (line === undefined) {
    return null;
  }
  const offersRetry = onRetry !== undefined && isRetryable(state);
  return (
    <RefusalBanner
      code={codeForConnection(state)}
      detail={`${line} ${readOnlyLine()}`}
      action={
        offersRetry ? (
          <button
            type="button"
            className="meridian-shell-state__action"
            onClick={() => {
              onRetry();
            }}
          >
            Start the local runtime
          </button>
        ) : undefined
      }
    />
  );
}

/**
 * The catch-up banner.
 *
 * Rendered from the stores' own degraded cause rather than from the connection,
 * because a window can be connected and still be re-reading: reconnect is when
 * catch-up STARTS, and the cause clears when the re-pull lands.
 */
function renderRecoveryBanner(state: ShellState): React.JSX.Element | null {
  if (state.sessionRecovery === undefined) {
    return null;
  }
  return (
    <RefusalBanner code={state.sessionRecovery} detail={recoveryLineFor(state.sessionRecovery)} />
  );
}

/** Whether the supervisor has stopped driving, which is the only time a person may. */
function isRetryable(state: ShellState): boolean {
  return state.connection.kind === "offline" || state.connection.kind === "stopped";
}

/** The banner's code, in the shell's own refusal vocabulary. */
function codeForConnection(state: ShellState): string {
  switch (state.connection.kind) {
    case "offline":
      return "shell-offline";
    case "stopped":
      return "shell-stopped";
    default:
      return "shell-disconnected";
  }
}
