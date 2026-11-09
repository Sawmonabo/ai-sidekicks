// A fake daemon wire for the shell suites: it records each stream it opens, with the ends a case
// drives, and each call, answered from the case's table or with `null`.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import type { DaemonWire } from "#shared/preload-api.js";
import type { PlatformBridge } from "../../platform/bridge.js";
import { TransportReconnectSignal } from "../../transport/reconnect.js";

/** A bridge whose only members in use are a recording daemon wire and the reconnect signal. */
export class RecordedShellWire {
  readonly opens: StreamOpen[] = [];
  readonly calls: RecordedCall[] = [];
  readonly bridge: PlatformBridge;

  /** `answers` serves a method's calls; a method it does not name is served `null`. */
  public constructor(answers: Readonly<Record<string, (params: unknown) => unknown>> = {}) {
    const subscribe = ((
      topic: string,
      params: unknown,
      handler: (payload: unknown, attachments: readonly Uint8Array[]) => void,
      onEnded?: (end: DaemonSubscriptionEnd) => void,
      onOpened?: (subscriptionId: SubscriptionId) => void,
    ) => {
      const open: StreamOpen = {
        topic,
        params,
        deliver: (payload, attachments = []) => {
          handler(payload, attachments);
        },
        end: (end) => onEnded?.(end),
        opened: (subscriptionId) => onOpened?.(subscriptionId),
        isClosed: false,
      };
      this.opens.push(open);
      return () => {
        open.isClosed = true;
      };
    }) as DaemonWire["subscribe"];
    const call = ((method: string, params: unknown) => {
      this.calls.push({ method, params });
      return Promise.resolve({ value: answers[method]?.(params) ?? null });
    }) as DaemonWire["call"];
    this.bridge = {
      daemon: { subscribe, call },
      transportReconnect: new TransportReconnectSignal(),
    } as unknown as PlatformBridge;
  }

  /** The opens of one stream, oldest first. */
  public opensOf(topic: string): readonly StreamOpen[] {
    return this.opens.filter((open) => open.topic === topic);
  }

  /** The newest open of one stream, or a throw. */
  public newestOpenOf(topic: string): StreamOpen {
    const open = this.opensOf(topic).at(-1);
    if (open === undefined) {
      throw new Error(`no ${topic} stream was opened`);
    }
    return open;
  }

  /** The params of every call to one method, oldest first. */
  public paramsOf(method: string): readonly unknown[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }
}

/** One open of a stream: its topic and request, its ends, and whether the page closed it. */
interface StreamOpen {
  readonly topic: string;
  readonly params: unknown;
  readonly deliver: (payload: unknown, attachments?: readonly Uint8Array[]) => void;
  readonly end: (end: DaemonSubscriptionEnd) => void;
  readonly opened: (subscriptionId: SubscriptionId) => void;
  isClosed: boolean;
}

/** One call the page made. */
interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}
