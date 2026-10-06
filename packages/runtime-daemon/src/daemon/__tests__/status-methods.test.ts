// A status read whose processor and memory reading fails still answers, with both readings `null`
// and the failure in the service log, so Settings › Runtime keeps the service's other facts.

import { describe, expect, it } from "vitest";

import { MethodRegistryImpl } from "../../ipc/registry.js";
import { registerStatusMethods } from "../status-methods.js";

describe("the status read", () => {
  it("answers with no processor or memory reading when the reading fails, and logs why", async () => {
    const registry = new MethodRegistryImpl();
    const serviceLog: string[] = [];
    const startedAt = new Date("2026-04-30T09:00:00.000Z");
    registerStatusMethods(registry, {
      processIdentity: { processId: 4242, bootId: "boot-1", processStartTime: "start-1" },
      readProcessState: () => "running",
      version: "0.0.0-test",
      transportEndpoint: "/run/sidekicks.sock",
      dataDirectory: "/data",
      startedAt,
      now: () => new Date(startedAt.getTime() + 1_000),
      readProcessTreeUsage: () => Promise.reject(new Error("the process table is unreadable")),
      writeServiceLog: (line) => {
        serviceLog.push(line);
      },
    });

    const reply = await registry.dispatch("daemon.status.read", {}, {});

    expect(reply).toMatchObject({ processState: "running", uptimeMs: 1_000 });
    expect(reply).toHaveProperty("processor", null);
    expect(reply).toHaveProperty("memory", null);
    expect(serviceLog).toStrictEqual([
      "The processor and memory reading failed: the process table is unreadable",
    ]);
  });
});
