// What the three halves of the quota suite build their cases out of.
//
// The read's cases, the tail's cases, and the buffering cases were one file, and this
// is what they share: the registry reply shapes, the scripted account plane, the
// probe that reports the hook's reading out of the tree, and the two readers that
// find one chip. Written once so the three files cannot drift into disagreeing about
// what a registry reply looks like — which is the drift this suite exists to catch.

import { act, render } from "@testing-library/react";

import { PROVIDER_ACCOUNT_SUBSCRIBE_STREAM } from "../daemon/daemon-streams.js";
import {
  withRecordedStreamLifecycle,
  type RecordedStreamLifecycle,
} from "../daemon/daemon-streams.test-support.js";
import {
  createFixture,
  withCapturedStream,
  withDaemonCall,
} from "../fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../scheduled-read.test-support.js";
import { useProviderQuotas } from "./provider-quota-feed.js";
import type { ProviderQuotaReading } from "./provider-quota-fold.js";
import type { ConsoleBridge } from "../console-bridge.js";

export const ACCOUNT_ID = "acct-team";
export const OTHER_ACCOUNT_ID = "acct-personal";
export const OBSERVED_AT = "2026-01-01T11:00:00.000Z";

/** One registry row, in the registered shape and nothing narrower. */
export function account(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: OBSERVED_AT,
    observedAuthMode: "oauth_subscription",
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    ...overrides,
  };
}

/** One quota row, in the registered shape and nothing narrower. */
export function usageWindow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    limitId: "weekly-all",
    windowMins: 10_080,
    label: "Weekly, all models",
    usedPercent: 62,
    observedAt: OBSERVED_AT,
    observedCredentialGeneration: 1,
    source: "probe",
    ...overrides,
  };
}

export function listReply(
  accounts: readonly Record<string, unknown>[],
  usageWindows: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return { accounts, usageWindows, readiness: [] };
}

/** How a case wants the registry read to behave. */
export interface AccountPlaneOptions {
  /**
   * Park every read until the case settles it by hand.
   *
   * What the buffering cases are about is the window BETWEEN the tail opening and the
   * read's reply landing, and that window does not exist unless the case owns when the
   * reply lands.
   */
  readonly holdsReads?: boolean;
  /** What the SECOND and later reads answer, where a case makes the reads differ. */
  readonly laterReply?: unknown;
}

/**
 * The shipped fixture answering the registry read, with the case holding the tail.
 *
 * The subscription is captured rather than scripted, because half these cases are
 * about what arrives AFTER the read has settled and a scripted beat would put that
 * moment on the fixture's clock instead of on the case's.
 *
 * COMPOSED FROM THE FAMILY'S OWN WRAPPERS, never a fabricated object. What stood here
 * built `this.bridge` by casting an object literal, which meant this class also
 * decided what every other seam answered and had to mint a hand-made scenario engine
 * so the scheduled read had a clock to arm on — a clock the fixture already carries,
 * and the one `settleScheduledRead` moves.
 *
 * The lifecycle recorder is OUTERMOST, and that ordering is load-bearing: the capture
 * answers the account-plane stream itself rather than forwarding it, so a recorder
 * inside it would see no open at all and report every case compliant at zero.
 */
export class AccountPlaneBridge {
  readonly bridge: ConsoleBridge;
  readonly #parkedReads: (() => void)[] = [];
  readonly #deliverFrame: (payload: unknown) => void;
  readonly #lifecycle: RecordedStreamLifecycle;
  #listCallCount = 0;

  public constructor(
    private readonly reply: unknown,
    private readonly options: AccountPlaneOptions = {},
  ) {
    const answered = withDaemonCall(createFixture().bridge, async ({ method }) => {
      if (method !== "providerAccount.list") {
        throw new Error(`unexpected daemon call: ${method}`);
      }
      this.#listCallCount += 1;
      const replyForThisCall =
        this.#listCallCount === 1 ? this.reply : (this.options.laterReply ?? this.reply);
      if (this.options.holdsReads !== true) {
        return replyForThisCall;
      }
      return new Promise<unknown>((resolveRead) => {
        this.#parkedReads.push(() => {
          resolveRead(replyForThisCall);
        });
      });
    });
    const captured = withCapturedStream(answered.bridge, PROVIDER_ACCOUNT_SUBSCRIBE_STREAM);
    this.#deliverFrame = captured.deliver;
    this.#lifecycle = withRecordedStreamLifecycle(captured.bridge);
    this.bridge = this.#lifecycle.bridge;
  }

  public get openCount(): number {
    return this.#lifecycle.openCountFor(PROVIDER_ACCOUNT_SUBSCRIBE_STREAM);
  }

  public get closeCount(): number {
    return this.#lifecycle.closeCountFor(PROVIDER_ACCOUNT_SUBSCRIBE_STREAM);
  }

  public get listCallCount(): number {
    return this.#listCallCount;
  }

  /** Push one frame down the tail, exactly as the daemon would. */
  public deliver(payload: unknown): void {
    this.#deliverFrame(payload);
  }

  /**
   * Let one parked read answer, oldest first by default.
   *
   * The ordinal is exposed so a case can settle the NEWEST read before the one it
   * superseded, which is the order that decides whether an abandoned reply can still
   * seat itself over a fresher one.
   */
  public settleRead(readOrdinal = 0): void {
    const parked = this.#parkedReads[readOrdinal];
    if (parked === undefined) {
      throw new Error(
        `no parked read at ordinal ${String(readOrdinal)}; ${String(this.#parkedReads.length)} are parked`,
      );
    }
    parked();
  }
}

/** The partial-read arm as a case reads it — what the rail would render. */
export interface QuotaPartialArm {
  readonly unreadableDeliveryCount: number;
  readonly unreadableRefusalCode: string | undefined;
}

export const NOTHING_UNREADABLE: QuotaPartialArm = {
  unreadableDeliveryCount: 0,
  unreadableRefusalCode: undefined,
};

/** The readings the hook publishes, captured out of a render. */
export interface MountedQuotas {
  readonly readingsNow: () => readonly ProviderQuotaReading[];
  readonly refusalCodeNow: () => string | undefined;
  readonly partialNow: () => QuotaPartialArm;
  readonly unmount: () => void;
}

export async function mountQuotas(bridge: ConsoleBridge): Promise<MountedQuotas> {
  let readings: readonly ProviderQuotaReading[] = [];
  let refusalCode: string | undefined;
  let partial: QuotaPartialArm = NOTHING_UNREADABLE;

  function Probe(): React.JSX.Element {
    const readout = useProviderQuotas(bridge);
    readings = readout.readings;
    refusalCode = readout.readRefusal?.code;
    partial = {
      unreadableDeliveryCount: readout.unreadableDeliveryCount,
      unreadableRefusalCode: readout.unreadableRefusal?.code,
    };
    return <output>{String(readout.readings.length)}</output>;
  }

  let mounted: { unmount: () => void } | undefined;
  await act(async () => {
    mounted = render(<Probe />);
  });
  // The read the mount asks for is taken when the scheduler's window elapses, so
  // every case starts from a reading that has actually been answered.
  await settleScheduledRead(bridge);
  if (mounted === undefined) {
    throw new Error("the probe did not mount");
  }
  const rendered = mounted;
  return {
    readingsNow: () => readings,
    refusalCodeNow: () => refusalCode,
    partialNow: () => partial,
    unmount: () => {
      rendered.unmount();
    },
  };
}

/** One key's reading, or a thrown failure naming what was there instead. */
export function readingAt(
  readings: readonly ProviderQuotaReading[],
  limitId: string,
): ProviderQuotaReading {
  const found = readings.find((reading) => reading.limitId === limitId);
  if (found === undefined) {
    throw new Error(
      `no reading for "${limitId}"; the fold holds ${JSON.stringify(readings.map((r) => r.limitId))}`,
    );
  }
  return found;
}
