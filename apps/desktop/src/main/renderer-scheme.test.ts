// Plan-023 Phase 1B (T-023p-1B-1 / T-023p-1B-2) — the renderer scheme's
// identity and its Content-Security-Policy, on BOTH documents that can carry it.
//
// `Spec-023 §Security Hardening Baseline` binds every renderer document, not
// merely the packaged one. Two of them exist: the built bundle over
// `sidekicks-renderer://` (headers from `./protocol.ts`) and, under
// `electron-vite dev`, an HTTP document from the Vite dev server, which never
// passes through that handler and would otherwise carry no policy at all. Both
// policies are composed from ONE directive list in `./renderer-scheme.ts`, and
// the parity assertion below is what keeps that true — a directive added to the
// production policy alone would fail here rather than ship a dev renderer that
// is quietly more permissive than the thing it stands in for.

import { describe, expect, it } from "vitest";

import electronViteConfigFactory from "../../electron.vite.config.js";
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
  it("carries every Spec-023 §Security Hardening Baseline directive", () => {
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
    // No `unsafe-eval` and no inline script anywhere: `Spec-023 §Renderer Bundle`
    // names both as the reason the bundle is served over a custom scheme at all.
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe("the dev-server Content-Security-Policy", () => {
  // The whole claim, asserted structurally rather than by string comparison:
  // the dev policy is the production policy plus the HMR socket, and nothing
  // else. A directive relaxed for development convenience fails here.
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
    // `strictPort` is load-bearing rather than tidy: the policy names the port
    // literally, so a silent fallback to the next free one would leave HMR
    // blocked by a policy that no longer matches the server it protects.
    expect(rendererServer?.strictPort).toBe(true);
    expect(rendererServer?.headers).toMatchObject({
      "Content-Security-Policy": RENDERER_DEV_CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
    });
  });
});
