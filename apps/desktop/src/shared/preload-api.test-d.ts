// Type-level guard: no property name the page can reach through `PreloadApi` contains "token",
// "dpop" or "secret", so no auth material appears on `window.desktopBridge`. The page reaches a
// name through a member, what a method answers, a value a subscription hands its handler, and
// every daemon result and subscription value the wire carries. The typecheck fails with TS2344 at
// an `AssertNever` line the moment such a name enters the bridge.
//
// `AssertNever<T extends never>` is the guard rather than `const _: Offenders = null as never`,
// because `never` is assignable to any type and that assignment would typecheck regardless.

import type {
  DaemonEvent,
  DaemonEventPayload,
  DaemonMethod,
  DaemonResult,
} from "@ai-sidekicks/contracts/daemon/methods";

import type { MainProcessState } from "./daemon/status-topic.js";
import type { DaemonWire, PreloadApi, ServedDaemonCall, Unsubscribe } from "./preload-api.js";

/**
 * How many levels deep the walk goes, so a recursive type cannot expand forever. A key nested
 * deeper than this is not checked.
 */
type WalkDepthLimit = 12;

/**
 * Every string property name reachable from `T`: an object's keys and their values' keys, an
 * array's element keys, a function's awaited return type's keys, and the keys of what a function
 * hands each callback it takes. Primitives, branded ones included, add nothing. An index
 * signature contributes its value's keys but not `string` itself, which would absorb every
 * literal key in the union and leave nothing to match.
 */
type AllKeys<T, Depth extends readonly unknown[] = []> = Depth["length"] extends WalkDepthLimit
  ? never
  : T extends string | number | boolean | bigint | symbol
    ? never
    : T extends (...args: infer Args) => infer Result
      ?
          | AllKeys<Awaited<Result>, [...Depth, unknown]>
          | HandedKeys<Args[number], [...Depth, unknown]>
      : T extends readonly (infer Element)[]
        ? AllKeys<Element, [...Depth, unknown]>
        : T extends object
          ? {
              [K in keyof T]-?: K extends string
                ? (string extends K ? never : K) | AllKeys<T[K], [...Depth, unknown]>
                : never;
            }[keyof T]
          : never;

/** The keys of what a callback parameter is handed; nothing for a parameter the page sends. */
type HandedKeys<Parameter, Depth extends readonly unknown[]> = Parameter extends (
  ...values: infer Values
) => unknown
  ? AllKeys<Values[number], Depth>
  : never;

/**
 * Every daemon result, one per method. `daemon.call` is generic, so walking its signature reaches
 * only the result of the whole method union, which names no member's keys.
 */
type ResultsOf<Methods extends DaemonMethod> = {
  [M in Methods]: ServedDaemonCall<DaemonResult<M>>;
}[Methods];
type DaemonResults = ResultsOf<DaemonMethod>;

/** Every value the subscriptions named deliver, one per subscription, for the same reason. */
type PayloadsOf<Events extends DaemonEvent> = { [E in Events]: DaemonEventPayload<E> }[Events];
type DaemonPayloads = PayloadsOf<DaemonEvent>;

/**
 * Any key whose lowercased form contains a forbidden substring. The outer `K extends string`
 * makes the conditional distribute over the union; without it `Lowercase<K>` is not a naked
 * type parameter, the check silently yields `never`, and the guard passes vacuously.
 */
type ContainsForbidden<K extends string> = K extends string
  ? Lowercase<K> extends `${string}token${string}`
    ? K
    : Lowercase<K> extends `${string}dpop${string}`
      ? K
      : Lowercase<K> extends `${string}secret${string}`
        ? K
        : never
  : never;

/**
 * Names the daemon's results and values carry that match a forbidden substring and hold no
 * credential: counts of model tokens and the run's token limit, a workflow secret's id and its
 * list (never a value), the path of the service's secrets file, the name of the environment
 * variable a tool server's bearer token is read from, the handle the service mints for a folder
 * it listed, a screencast frame's acknowledgment id, and the dates a webhook token was made and
 * last used.
 */
type CredentialFreeKeys =
  | "tokens"
  | "tokensPerRun"
  | "tokenLimit"
  | "tokensReceived"
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningTokens"
  | "usedTokens"
  | "windowTokens"
  | "secretId"
  | "secrets"
  | "secretsFile"
  | "bearerTokenEnvVar"
  | "folderToken"
  | "ackToken"
  | "webhookTokenCreatedAt"
  | "webhookTokenLastUsedAt";

/** Every key matching a forbidden substring in `T`, the credential-free names aside. */
type Offenders<T> = Exclude<ContainsForbidden<AllKeys<T>>, CredentialFreeKeys>;

/**
 * The methods that answer one of the two credentials shown to the person once, to copy into the
 * receiver or caller they authenticate: the notification web address's signing secret,
 * and a workflow webhook's token. Each is allowed only on these methods' results.
 */
type ShownOnceMethod =
  | "attention.webAddressSave"
  | "attention.webAddressSecretRotate"
  | "workflow.webhookTokenRotate";

/**
 * The bridge with the daemon wire's generic `call` and `subscribe` left out: what they hand the
 * page is walked per method and per subscription instead, with main's status state beside it.
 */
type BridgeOutsideTheDaemonWire =
  | Omit<PreloadApi, "daemon">
  | Omit<DaemonWire, "call" | "subscribe">;

/** The subscriptions that deliver a question, whose `secret` flag says it takes a masked answer. */
type QuestionEvent = "session.subscribe" | "driver.subscribeEvents";

/** Fails to compile (TS2344) when `T` is anything other than `never`. */
type AssertNever<T extends never> = T;

/** `true` when the walk found `T`, and a message `AssertTrue` refuses when it found nothing. */
type AssertCaught<T> = [T] extends [never] ? "the walk missed a planted key" : true;

/** Fails to compile (TS2344) unless `T` is `true`. */
type AssertTrue<T extends true> = T;

/** Fails the typecheck when the bridge, a daemon result or a delivered value grows such a name. */
type _NoForbiddenKeysOnBridge = AssertNever<
  Offenders<
    | BridgeOutsideTheDaemonWire
    | MainProcessState
    | ResultsOf<Exclude<DaemonMethod, ShownOnceMethod>>
    | PayloadsOf<Exclude<DaemonEvent, QuestionEvent>>
  >
>;

/** The shown-once results carry their credential and nothing else that matches. */
type _OnlyTheShownCredential = AssertNever<
  Exclude<Offenders<ResultsOf<ShownOnceMethod>>, "signingSecret" | "token">
>;

/** The question streams carry the masked-answer flag and nothing else that matches. */
type _OnlyTheQuestionFlag = AssertNever<Exclude<Offenders<PayloadsOf<QuestionEvent>>, "secret">>;

// Negative controls: each line fails the typecheck if the walk stops finding what it must.
/** A key planted deep in what a method answers, inside a list. */
type _CatchesAResult = AssertTrue<
  AssertCaught<
    Offenders<{ call(): Promise<ServedDaemonCall<{ rows: { sessionToken: string }[] }>> }>
  >
>;
/** A key planted in what a subscription hands its handler. */
type _CatchesADeliveredValue = AssertTrue<
  AssertCaught<Offenders<{ subscribe(handler: (value: { dpopKey: string }) => void): Unsubscribe }>>
>;
/** The walk reaches the contract's own daemon results and delivered values: real keys in each. */
type _ReachesTheDaemonResults = AssertTrue<
  AssertCaught<Extract<ContainsForbidden<AllKeys<DaemonResults>>, "signingSecret">>
>;
type _ReachesTheDaemonPayloads = AssertTrue<
  AssertCaught<Extract<ContainsForbidden<AllKeys<DaemonPayloads>>, "tokenLimit">>
>;
