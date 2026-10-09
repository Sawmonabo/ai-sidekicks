// The Codex services of one driver, one per credential home: a session on an account the app
// manages shares that account's service, and sessions on the person's own Codex folder share the
// service already running there.

import path from "node:path";

import type { CodexServiceDependencies, CodexServiceHome } from "./dependencies.js";
import { CodexService } from "./supervisor.js";

/** The socket a service listens on when its listen address names no path. */
const CODEX_CONTROL_SOCKET = path.join("app-server-control", "app-server-control.sock");

/** Resolves which Codex home a session's account runs in, wired by the daemon. */
export interface CodexHomeResolver {
  /** The home for `providerAccountId`; `undefined` names the node's default account. */
  codexHomeFor(providerAccountId: string | undefined): Promise<CodexServiceHome>;
}

/** What every service the registry makes shares. */
export type CodexServiceRegistryDependencies = Omit<
  CodexServiceDependencies,
  "home" | "listenAddress" | "socketPath"
> & { readonly homes: CodexHomeResolver };

/** One service per credential home, made on first use and kept while the driver lives. */
export class CodexServiceRegistry {
  readonly #homes: CodexHomeResolver;
  readonly #shared: Omit<CodexServiceDependencies, "home" | "listenAddress" | "socketPath">;
  readonly #servicesByHome = new Map<string, CodexService>();
  // Services a replacement took over from, kept until their conversations moved off and they
  // stopped, so a shutdown meanwhile stops them too.
  readonly #replaced = new Set<CodexService>();
  #replacementCount = 0;

  constructor({ homes, ...shared }: CodexServiceRegistryDependencies) {
    this.#homes = homes;
    this.#shared = shared;
  }

  /** The service for an account's home, made but not started when it is the home's first use. */
  async serviceFor(providerAccountId: string | undefined): Promise<CodexService> {
    const home = await this.#homes.codexHomeFor(providerAccountId);
    const existing = this.#servicesByHome.get(home.codexHome);
    if (existing !== undefined) {
      return existing;
    }
    const service = this.#create(home, "unix://", path.join(home.codexHome, CODEX_CONTROL_SOCKET));
    this.#servicesByHome.set(home.codexHome, service);
    return service;
  }

  /** Every service the registry holds. */
  services(): CodexService[] {
    return [...this.#servicesByHome.values()];
  }

  /**
   * Makes a second service on `service`'s home, on a socket of its own, which becomes the home's
   * service from now on; the first stays until its conversations have moved off it.
   */
  replace(service: CodexService): CodexService {
    this.#replacementCount += 1;
    const socketPath = path.join(
      service.home.codexHome,
      "app-server-control",
      `sidekicks-${this.#replacementCount}.sock`,
    );
    const replacement = this.#create(service.home, `unix://${socketPath}`, socketPath);
    this.#servicesByHome.set(service.home.codexHome, replacement);
    this.#replaced.add(service);
    return replacement;
  }

  /** Stops a service a replacement took over from, once no conversation is left on it. */
  async retire(service: CodexService): Promise<void> {
    await service.stop();
    this.#replaced.delete(service);
  }

  /**
   * Shuts every service down for good, the replaced ones included: the daemon's own are stopped
   * and the person's own only disconnected. Throws an `AggregateError` of the stops that failed,
   * once every stop settled.
   */
  async shutdown(): Promise<void> {
    const services = [...this.#servicesByHome.values(), ...this.#replaced];
    const outcomes = await Promise.allSettled(
      services.map(async (service) => {
        await service.shutdown();
      }),
    );
    this.#replaced.clear();
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Some Codex services did not stop.");
    }
  }

  #create(home: CodexServiceHome, listenAddress: string, socketPath: string): CodexService {
    return new CodexService({ ...this.#shared, home, listenAddress, socketPath });
  }
}
