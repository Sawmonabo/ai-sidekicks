// The scheme's identity and its Content-Security-Policy on both documents that carry it: the
// built bundle over `sidekicks-renderer://` (headers from `./renderer-protocol.ts`) and, under
// `electron-vite dev`, the Vite dev server's HTTP document, which never passes through that
// handler. Both policies come from one directive list, and the parity assertion fails if a
// directive is added to the production policy alone.

import { describe, expect, it } from "vitest";

import electronViteConfigFactory from "../../../electron.vite.config.js";
import {
  RENDERER_CONTENT_SECURITY_POLICY,
  RENDERER_DEV_CONTENT_SECURITY_POLICY,
  RENDERER_DEV_SERVER_PORT,
  RENDERER_HOST,
  RENDERER_INDEX_URL,
  RENDERER_ORIGIN,
  RENDERER_SCHEME,
} from "./renderer-scheme.js";

/** `a; b; c` → `{ a: "…", b: "…" }`, keyed by directive name. */
function parsePolicy(policy: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const directive of policy.split(";")) {
    const trimmed = directive.trim();
    if (trimmed === "") continue;
    const firstSpace = trimmed.indexOf(" ");
    const name = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    directives.set(name, firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1));
  }
  return directives;
}

describe("the renderer scheme's identity", () => {
  it("composes the origin and index URL from the scheme and host", () => {
    expect(RENDERER_ORIGIN).toBe(`${RENDERER_SCHEME}://${RENDERER_HOST}`);
    expect(RENDERER_INDEX_URL).toBe(`${RENDERER_ORIGIN}/index.html`);
  });
});

describe("the production Content-Security-Policy", () => {
  it("carries every security-hardening directive", () => {
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(RENDERER_CONTENT_SECURITY_POLICY).toContain(directive);
    }
    // No `unsafe-eval` and no inline script anywhere.
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe("the dev-server Content-Security-Policy", () => {
  // Asserted structurally: the dev policy is the production policy plus the HMR socket.
  it("differs from the production policy in connect-src and nothing else", () => {
    const productionDirectives = parsePolicy(RENDERER_CONTENT_SECURITY_POLICY);
    const developmentDirectives = parsePolicy(RENDERER_DEV_CONTENT_SECURITY_POLICY);

    expect([...developmentDirectives.keys()].sort()).toStrictEqual(
      [...productionDirectives.keys()].sort(),
    );
    for (const [name, productionValue] of productionDirectives) {
      if (name === "connect-src") continue;
      expect(developmentDirectives.get(name)).toBe(productionValue);
    }

    const developmentConnectSrc = developmentDirectives.get("connect-src") ?? "";
    expect(developmentConnectSrc.startsWith("'self' ")).toBe(true);
    expect(
      developmentConnectSrc
        .replace(/^'self' /, "")
        .split(" ")
        .sort(),
    ).toStrictEqual([
      `ws://127.0.0.1:${String(RENDERER_DEV_SERVER_PORT)}`,
      `ws://localhost:${String(RENDERER_DEV_SERVER_PORT)}`,
    ]);
  });

  it("keeps script-src closed even though the socket is admitted", () => {
    expect(RENDERER_DEV_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(RENDERER_DEV_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(RENDERER_DEV_CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline'; script-src");
  });
});

describe("the dev server the renderer is loaded from", () => {
  it("emits the policy on every document it serves, on the port the policy names", async () => {
    const resolvedConfig = await electronViteConfigFactory({
      command: "serve",
      mode: "development",
    });

    const rendererServer = resolvedConfig.renderer?.server;
    expect(rendererServer?.port).toBe(RENDERER_DEV_SERVER_PORT);
    // `strictPort` is load-bearing: the policy names the port, so a silent fallback would leave
    // HMR blocked by a policy that no longer matches the server.
    expect(rendererServer?.strictPort).toBe(true);
    expect(rendererServer?.headers).toMatchObject({
      "Content-Security-Policy": RENDERER_DEV_CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
    });
  });
});
