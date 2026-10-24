# ADR-038: MCP Credential Custody

| Field         | Value                                    |
| ------------- | ---------------------------------------- |
| **Status**    | `accepted`                               |
| **Type**      | `Type 2 (one-way door)`                  |
| **Domain**    | Auth, MCP Governance, Credential Custody |
| **Date**      | 2026-09-29                               |
| **Author(s)** | Claude (AI-assisted)                     |
| **Reviewers** | Sawmon Abo                               |

> **Type guidance:** Type 2. This record has the background service hold, renew and hand out credentials for the MCP servers a person signs in to. Once refresh tokens live in the operating system's credential store under the service's own items and every provider reaches signed-in servers through the service, taking custody back out means signing the person out of every server and moving every session's server connections back to each provider's own sign-in.

---

## Context

**What the person needs.** A tool server that wants a sign-in is signed in to once, with one press of `Sign in to this server` and one consent, and that one sign-in serves its tools, resources and prompts on Claude Code and on Codex alike, in every account, whichever way a session moves: a session that moves from one provider to another needs no new sign-in. [Spec-024 §OAuth Orchestration](../specs/024-mcp-server-configuration-and-governance.md#oauth-orchestration) states the requirement; this record decides who holds the credential that meets it.

**Why the providers' own sign-ins cannot meet it.**

- **Codex never asks a server for its prompts.** Codex 0.156.0 has no prompt verb on its app-server and none on `main`; its MCP client methods are `mcpServerStatus/list`, `mcpServer/oauth/login`, `config/mcpServer/reload`, `mcpServer/resource/read`, `mcpServer/tool/call` and an event stream that serves only hosted apps. An upstream request asks for one ([openai/codex#5059](https://github.com/openai/codex/issues/5059)). So on a Codex session the service lists and reads a server's prompts through its own MCP client, and that client needs a credential for a server behind a sign-in.
- **Codex has no MCP Tasks and cannot move a long call to the background** ([openai/codex#48617](https://github.com/openai/codex/issues/48617)). So the service fronts every tool server a Codex session reaches, on its own route, with its own MCP client holding the real connection ([Spec-024 §Long tool calls and the fronted route](../specs/024-mcp-server-configuration-and-governance.md#long-tool-calls-and-the-fronted-route)). A fronted server behind a sign-in needs a credential the service can present.
- **A second party cannot share a provider's sign-in.** The MCP authorization specification registers each client itself (a Client ID Metadata Document, pre-registration, or dynamic registration), requires clients to "implement secure token storage", and requires an authorization server to rotate refresh tokens for public clients ([MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [Security considerations §Token Theft](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)). Measured against a server that rotates on every renewal, on Codex 0.156.0 and on Claude Code 2.1.283: once a second party renewed the provider's saved sign-in, the provider's own renewal was refused (400), its next tool call failed, and the server read `needs-auth` / `notLoggedIn` on that provider.
- **A server that demands proof-of-possession (DPoP) tokens cannot be reached by Claude Code or Codex.** The draft DPoP extension for MCP (SEP-1932) binds a token to the client's signing key and needs a fresh signed proof on every request. The only DPoP code in Codex 0.156.0 and Claude Code 2.1.283 serves their own AWS sign-in.

**What each provider offers to reach a server through the service.** Claude Code takes an in-process (`type: "sdk"`) server from the host that started it: named in `initialize`'s `sdkMcpServers` or added later with `mcp_set_servers`, its JSON-RPC messages carried as `mcp_message` control requests, which flow in both directions on the process's own standard streams (`@anthropic-ai/claude-agent-sdk` 0.3.302 `sdk.d.ts`); Claude Code's own desktop app registers its connectors that way ([Claude Code MCP §How connectors reach Claude Code](https://code.claude.com/docs/en/mcp)). Codex takes a `url` entry in a conversation's `thread/start` configuration. Each provider can also run a command of the server's entry that prints a request header, and the service never uses one: the provider runs it in a shell, so any command at the same place in the process tree can run it again and print a live token, and on Windows a same-user process can name any parent it likes. The MCP specification makes a proxy an OAuth client in its own right: a server "MUST NOT pass through the token it received" ([MCP security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)).

**What each provider does with its own sign-in.** Codex keeps an MCP sign-in in the operating system's keyring under the service `Codex MCP Credentials`, falling back to `$CODEX_HOME/.credentials.json`, and in its own words "Credentials stored in the keyring will only be readable by Codex unless the user explicitly grants access"; `mcp_oauth_credentials_store = "file"` makes it write the file. Claude Code keeps its MCP sign-ins in its credential blob (`mcpOAuth`), a keychain item on macOS and a mode-0600 file elsewhere. Both saved entries carry the server, the issuer, the client id, the access and refresh tokens and the expiry. Run in a throwaway home with no provider sign-in, each provider's own flow completed against a server that admits only that provider's client (Codex through `mcpServer/oauth/login`, Claude Code through its `mcp_authenticate` control request), and the saved sign-in renewed under the same client id from outside the provider, after which the server answered `initialize`, `prompts/list` and `prompts/get` on the new token.

**The MCP client library.** `rmcp` 3.5.1 runs the sign-in's discovery, registration, PKCE and `resource` (`AuthorizationManager`) and signs no DPoP proof. Measured with a client that signs DPoP (`@modelcontextprotocol/client` 2.1.0) against a local server that issues only DPoP-bound tokens and verifies every proof: the client signed in, listed and read the server's prompt in 77 ms from the first connect; the same token sent as `Bearer`, or as `DPoP` with no proof, was refused; with every access token expired, the client renewed with a signed proof on its own and the call succeeded.

## Problem Statement

Who holds the credential for an MCP server a person signs in to, where is it kept, and how does it reach Claude Code, Codex and the service's own MCP client without any of them holding a second sign-in?

### Trigger

Codex prompts, long calls moved to the background on Codex, and DPoP servers on Claude Code and Codex alike all need a credential the service can present, and the requirement of one sign-in for every provider cannot be met by any provider's own store.

---

## Decision

**The background service holds one OAuth sign-in per MCP server, used by every provider and by its own MCP client. It keeps the refresh token in the operating system's credential store under its own item, renews it itself under the client id it was issued to, and fronts every signed-in server for the provider processes it launched, so no provider holds a token. `mcp.server.signOut {serverId}` removes the sign-in. It never reads or renews a sign-in the person's own Claude Code or Codex holds.**

1. **How the service signs in.** By default as its own OAuth client: discovery from the server's protected-resource metadata, client registration by the server's metadata document or by dynamic registration, PKCE, and `resource` set to the server's address. A server whose entry names a client the server's owner issued (Codex's `oauth.client_id` and `oauth.callback_url`) is signed in as that client. A server that publishes no sign-in route (no protected-resource or authorization-server metadata, or metadata the service cannot read) is refused with `mcp.server.signInUnsupported`.
2. **A server that admits only a provider's own client.** The service runs that provider's own flow in a throwaway home it makes for this one sign-in: Codex's `mcpServer/oauth/login` with `mcp_oauth_credentials_store = "file"`, which needs no ChatGPT sign-in, or Claude Code's own flow in a credential folder of its own. It takes the saved sign-in (the server, the issuer, the client id, the access and refresh tokens, the expiry) into its own item, deletes the home, and from then on renews the sign-in under that client id and fronts the server for each provider like any other signed-in server. It learns which client a server admits before the browser opens wherever the server says so: a refused dynamic registration, or a refusal from the server's pushed-authorization endpoint. Where the server says nothing, the first sign-in opens with the service's own client, and when that one ends as `Sign-in did not finish.`, the next press goes through the admitted provider's client. The service remembers which client each server admitted, so every later sign-in is one press.
3. **Where the credential lives.** The refresh token is kept in the operating system's credential store, under an item the service created, never in a file of its own; on Linux the item goes in the service's one file readable by this account alone, sealed through systemd's credential service where it can seal, as every daemon secret does ([ADR-020 §The Credential Store](020-cli-identity-key-storage-custody.md#the-credential-store)). Access tokens are held in the service's memory. Nothing is logged, relayed, shown, placed on any event, error or wire payload, or given to the renderer.
4. **How a provider reaches a signed-in server.** The service fronts every signed-in server and adds the token, and for a DPoP server a fresh proof, on the way out, so no provider process holds a token. Fronting keeps the MCP allow and deny lists: an in-process server is beyond every MCP setting and `managed-mcp.json`, so the daemon applies `deniedMcpServers` and `allowedMcpServers`, the organization's and the person's, to each server's real address or command before fronting it, reading them as it reads a server sent as declared, and never fronts one they keep out; on a machine whose organization deployed `managed-mcp.json` the person's own servers do not apply ([Plan-022](../plans/022-mcp-server-configuration-and-governance.md) T22.2.1), so the daemon fronts none of them. On Claude Code each signed-in server is an in-process (`type: "sdk"`) server, named in `initialize`'s `sdkMcpServers` or added with `mcp_set_servers`, its messages carried by `mcp_message` on the standard streams the service already holds; where a probe shows that route lacks something a server needs, that server goes on the service's loopback route instead, gated by the per-session secret. On Codex every server rides the service's route as a `url` entry in the conversation's `thread/start` configuration. A provider process the service did not launch gets nothing. A rejected token never reaches a provider as HTTP 401, which would start the provider's own sign-in: the service renews it, answers a call it cannot authorize with a tool error, and sets the server's leg to `needsAuth` itself, so a renewal never reaches the person.
5. **The service's own MCP client uses the same sign-in.** It lists and reads a server's prompts for a Codex session and holds the real connection for every server it fronts.
6. **A server that demands DPoP tokens.** The service signs in as its own client with a signing key made for that one sign-in, one key per server and never the machine's own control-plane key, kept in the operating system's credential store beside the refresh token. The service fronts it as it fronts every signed-in server, and signs a fresh proof for every request.
7. **Sign-out.** `mcp.server.signOut {serverId}` deletes the service's refresh token for that server, and its signing key where the server demands DPoP, and ends the access tokens it handed out: each provider's next call to that server gets no token, and the server reads `Needs sign-in` in every session on every provider until the next sign-in.
8. **The person's own provider sign-ins stay theirs.** The service never reads or renews a sign-in held by the person's own Claude Code or Codex outside the app. A server replaces a public client's refresh token on every renewal, so a second party renewing it would sign the person's own provider out.
9. **The sign-in page's address** is held only while the sign-in uses it, written to no storage and no log, and dropped when the sign-in settles.

**Provider accounts and MCP servers.** [ADR-026](026-provider-credential-custody-posture.md) governs the credentials of the provider accounts themselves (Claude Code's and Codex's own sign-ins). This record governs the credentials of MCP servers, and only those: for an MCP server the service is an OAuth client in its own right and speaks the server's token endpoint for its own sign-ins. Nothing here widens what the service may do with a provider account's credential, and nothing in ADR-026 governs an MCP server's.

**Library.** The service's MCP client is `rmcp` 3.5.1 with a small bridge of the service's own: its `StreamableHttpClient` over `reqwest` signs a DPoP proof with `p256` on every request, keeps the server's `DPoP-Nonce` and retries once, and keeps each raw result by request id. A 2026-07-28 server's tasks run on `rmcp`'s own types; a 2025-11-25 server's task calls go out as `CustomRequest`s through the bridge, because `rmcp`'s typed results drop that generation's task fields. The sign-in runs on `rmcp`'s `AuthorizationManager` (feature `auth`). In the same service the refresh token and the DPoP key go through `keyring-core` with the platform's store, the credential-store binding [ADR-020](020-cli-identity-key-storage-custody.md) names on macOS and Windows; on Linux they go in the service's `secrets.json`, sealed through `sidekicks-platforms`' own client of systemd's credential service. On Windows they are written at `CRED_PERSIST_LOCAL_MACHINE` (`persistence` = `local`), as every daemon secret is, through `sidekicks-platforms` in the service's own process. The same `rmcp` serves the daemon's own tool server, Playwright's tool set included ([ADR-034](034-embedded-browser-for-preview.md)). Weighed and not taken: a client of the service's own, which would re-implement what `rmcp` already carries (discovery, registration, PKCE, 2026-07-28 tasks); probed, the bridge needed only a `StreamableHttpClient` of about 70 lines.

### Thesis — Why This Option

- **It is the only option that meets the requirement as stated.** One press and one consent cover tools, resources and prompts on every provider, in every account, whichever way a session moves. Every other option either asks for a second consent, fails outright on some servers, or depends on a provider's private store.
- **It is built from routes each provider documents.** Claude Code takes an in-process server from the host that started it, as its own desktop app carries its connectors, and Codex takes a `url` entry on the service's route; no provider file is read and no provider store touched.
- **It follows the MCP specification's own model.** Each client registers itself, keeps its own tokens and renews its own refresh token. The service is one more client of the server, never a second holder of someone else's sign-in.
- **It closes the DPoP case on Claude Code and Codex.** Neither can reach a DPoP server by any route of its own; the service signs in with its own key and fronts the server, and the measured client renews with a signed proof on its own.
- **It keeps the credential inside the boundary the providers already use.** The refresh token sits in the operating system's credential store under the service's own item, so no cross-application keychain prompt fires, and no provider process holds a token at all.

### Antithesis — The Strongest Case Against

- **It puts the service in the credential blast radius of every server the person signs in to.** A compromised service can mint access tokens for all of them, where otherwise a compromise of one provider exposes only that provider's sign-ins.
- **The adopted sign-in rides a private format.** Taking over a provider's saved sign-in reads a file layout (`.credentials.json`, the Claude Code blob) that neither Claude Code nor Codex documents, and a release can change it.
- **Fronting puts the service on every call to a signed-in server.** Each call takes one more hop, and a fault in the service cuts every provider's reach to that server at once.
- **The in-process route is not the address route.** Whether Claude Code acts on a server's progress, list changes and elicitation over it, runs MCP Tasks on it, and sends its calls to the permission host as it does a direct server's is measured at build.
- **A sign-out the service performs does not revoke the token at the authorization server.** An access token already handed to a provider stays valid until it expires.

### Synthesis — Why It Still Holds

- **Blast radius:** the credential is held once, in the operating system's store under one item per server, and access tokens go only to processes the service launched, over a same-user socket; the renderer, events, logs and wire never carry one. The alternative is not "no custody" but one custody per provider plus a second consent, and the person still signs in to the same servers.
- **Private format:** the service reads a provider's saved sign-in only from the throwaway home it made for that one sign-in, once, right after the provider's own flow finishes, and deletes the home. A format change fails that sign-in visibly (`Sign-in did not finish.`); it never touches a store the person uses. The upstream asks for a prompt verb and MCP Tasks on Codex are filed, and when they land the fronting that needs the adopted sign-in narrows.
- **Fronting:** the service answers only for a session it launched with that server switched on, and no provider process holds a token, so nothing a provider starts can print one; the in-process route has no port, no secret and no process to impersonate. The hop is measured against the 5 ms budget (assumption 7).
- **Route parity:** a server the in-process route cannot serve in full goes on the loopback route, gated by the per-session secret, so no capability is lost to the transport.
- **Revocation:** sign-out deletes the refresh token and stops fronting at once, so no provider can renew; the residual is one access token's remaining lifetime, and the server reads `Needs sign-in` everywhere on the next call. This is an accepted risk.

---

## Alternatives Considered

### Option A: One service-held sign-in per server, fronted for each provider, with the adopted and DPoP arms (Chosen)

- **What:** The Decision above.
- **Steel man:** One sign-in, one consent, every provider, whichever way a session moves, Codex prompts and long calls included, DPoP servers reachable at all; built from routes each provider documents.
- **Weaknesses:** The service holds refresh tokens; the adopted arm depends on a provider's saved-sign-in layout; a sign-out leaves one access token's remaining lifetime.

### Option B: The service signs in for prompts only, tokens held in memory (Rejected)

- **What:** Each provider keeps its own sign-in for tools and resources; the service's MCP client runs its own flow only to list and read prompts for Codex, and keeps the tokens in memory.
- **Steel man:** Nothing is persisted, so the service holds no durable credential; each provider's sign-in stays exactly where it is.
- **Why rejected:** Two consent pages per server, and a fresh consent after every service restart. It does nothing for a fronted long call on a server behind a sign-in, and nothing for a DPoP server. It falls short of one sign-in for every provider.

### Option C: The service reads the provider's own saved sign-in (Rejected)

- **What:** The service reads the access token Codex or Claude Code stored for a server, uses it only for its own calls, never renews it, and has the provider renew it by reconnecting.
- **Steel man:** Exactly one sign-in, the provider's own; the service adds no client registration.
- **Why rejected:** It reads a private store layout that can change in any release. On macOS the first read raises the system's keychain prompt for the service's binary once per item, because the item trusts only the application that made it ([Apple: If you're asked for access to your keychain](https://support.apple.com/guide/keychain-access/if-youre-asked-for-access-to-your-keychain-kyca1243/mac)). It fails outright on a DPoP server. Renewing on the provider's behalf is not an option at all: a rotated refresh token signs the provider out, as measured on Claude Code and Codex.

### Option D: Carry the provider's MCP sign-ins across its accounts (Rejected)

- **What:** A reference app copies the `mcpOAuth` entries of Claude Code's credential blob from one account home to the next when it switches accounts, so a switch does not force every server to sign in again.
- **Steel man:** One sign-in per server per provider survives account switches with no new client.
- **Why rejected:** It is custody of the provider's own store, it still needs one sign-in per provider, it does nothing for Codex prompts, long calls or DPoP, and two homes holding one rotating refresh token sign each other out.

### Option E: Wait for the providers (Filed in parallel, not chosen alone)

- **What:** Ask Codex for `mcpServer/prompt/list` and `mcpServer/prompt/get` beside `mcpServer/resource/read` (a comment on [openai/codex#5059](https://github.com/openai/codex/issues/5059)) and for MCP Tasks ([openai/codex#48617](https://github.com/openai/codex/issues/48617)), and let each provider keep its own sign-in.
- **Steel man:** The provider's own authenticated connection would serve prompts and tasks with no credential in the service.
- **Why not chosen alone:** No date and no linked change on either request, and neither closes DPoP or the one-consent requirement. When the verbs land the service uses them and its fronting narrows; the single sign-in for every provider keeps its own value.

---

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Claude Code takes an in-process server named in `initialize` or added by `mcp_set_servers`, its messages carried by `mcp_message` | `@anthropic-ai/claude-agent-sdk` 0.3.302 `sdk.d.ts`; the `2.1.296` string census ([`claude.md`](../reference/provider-wire/claude.md)); [Claude Code MCP](https://code.claude.com/docs/en/mcp) | That server goes on the service's loopback route, gated by the per-session secret |
| 2 | Claude Code acts on an in-process server's progress, list changes, elicitation, tasks and permission asks as it does a direct server's | **Unvalidated.** Probed at build | The server that needs the missing piece goes on the loopback route |
| 3 | A provider's flow in a throwaway home saves the sign-in in a form the service can take over | Measured on Codex 0.156.0 (`.credentials.json` with `mcp_oauth_credentials_store = "file"`) and Claude Code 2.1.283 (its credential blob, in a Linux container) | That arm's sign-in ends `Sign-in did not finish.`; the pin check catches the layout change; the service's own client and owner-issued clients are unaffected |
| 4 | The operating system's credential store is available to the service | `keyring-core` over the macOS keychain; on Linux the service's `0600` file, sealed through systemd's credential service where it can seal and plain where not, and the same file on a Mac from its logged-out service's takeover until `sidekicks daemon uninstall`, even after that service is turned off in Login Items & Extensions; the Windows Credential Manager at `CRED_PERSIST_LOCAL_MACHINE`, written in the service's own process | Sign-in refuses with the store's cause; the refresh token is stored nowhere else |
| 5 | An authorization server rotates a public client's refresh token on renewal | [MCP security considerations §Token Theft](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations); measured on Claude Code and Codex | Nothing breaks; the rule that the service never renews the person's own provider sign-in costs nothing |
| 6 | The service's `StreamableHttpClient` on `rmcp` signs and renews with DPoP | Probed: it signs a proof on every request, keeps `DPoP-Nonce` and retries once | DPoP servers stay unreachable until the bridge is fixed; every other server is unaffected |
| 7 | A fronted call costs at most 5 ms over a direct one | **Unvalidated.** Measured at build against a direct call | The route's overhead is visible in tool latency; the fronting is revisited |

---

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The credential store is locked or unavailable | Low | Medium | The store call fails on sign-in or on the first token request | Fail closed: the server reads `Needs sign-in`, nothing is stored anywhere else, the store error surfaces on the sign-in attempt |
| A Claude Code pin changes the in-process route | Low | Medium | The provider-wire pin check and the build probes | Move the affected servers to the loopback route |
| A provider changes its saved-sign-in layout | Medium | Low | The takeover of the throwaway home finds no entry and the sign-in ends `Sign-in did not finish.`; the pin check | Update the reader at the next pin; only servers that admit a provider's client alone are affected |
| Two renewals race inside the service | Low | High | A renewal refused as `invalid_grant` right after a successful one | One renewal in flight per server, the rest wait on it, so a rotated refresh token is never replayed |
| A fronted call names a session or server the service does not hold | Low | High | The route or the control channel refuses the call and logs the refusal without any secret | Answer only for a session the service launched with that server switched on |
| A provider process outlives its session | Low | Medium | A fronted call arrives for a session that has closed | The service stops fronting for that session at close |

## Reversibility Assessment

- **Reversal cost:** Weeks. Every signed-in server is signed out, each provider's own sign-in comes back per provider, the fronted route loses its signed-in servers, Codex prompts and background calls on those servers go away, and DPoP servers become unreachable.
- **Blast radius:** Spec-024's sign-in, sign-out and fronting; the service's MCP client; both drivers' fronted servers; Settings › MCP servers.
- **Migration path:** Stop fronting signed-in servers, delete every item the service created in the credential store, and route each provider's sign-in back to its own flow; the person signs in again per provider.
- **Point of no return:** The first release in which a person signs in through the service. Before it, the custody is code and documents; after it, reversing signs the person out of every server they signed in to.

## Consequences

### Positive

- One sign-in and one consent per server serve tools, resources and prompts on every provider, Claude Code and Codex today, in every account and whichever way a session moves.
- Codex sessions get a server's prompts and background long calls on a server behind a sign-in.
- A DPoP server is reachable from Claude Code and from Codex.
- A token renewal never reaches the person.

### Negative (accepted trade-offs)

- The service holds refresh tokens for every server the person signs in to; accepted because the credential stays in the operating system's store under the service's own item and no provider process ever holds a token.
- The adopted arm depends on each provider's saved-sign-in layout; accepted because it runs only in a throwaway home and fails visibly.
- A sign-out leaves one access token's remaining lifetime; accepted because nothing can renew it.

### Unknowns

- The service's own flow end to end against a real OAuth-protected server (discovery, metadata-document or dynamic registration, the consent-page count): run at build against the MCP TypeScript SDK's OAuth example with a scripted consent.
- The in-process route's parity with a direct server on Claude Code, and a fronted call's added time: probed at build.
- Claude Code's adopted sign-in on macOS, where its blob is a keychain item: run at build.
- Windows: none of the runs behind this record were made there.

---

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Sign-ins per server to reach it from every provider | One | An end-to-end run: sign in once, call a tool on Claude Code and on Codex, list prompts on Codex | When the sign-in lands |
| A credential on any event, error, log, wire payload, renderer state or command line | Zero | The credential-echo sweep over every egress, and a process-listing check that no provider process's command line or environment carries a token or a route secret | When the sign-in lands |
| Reads or renewals of a store the person's own provider uses | Zero | A test that plants a provider-owned sign-in outside the service's homes and asserts it is untouched after sign-in, renewal and sign-out | When the sign-in lands |
| Calls that reach a server after sign-out | Zero beyond one access token's remaining lifetime | Sign out, then call from each provider and from the service's client | When the sign-out lands |
| Added latency on a fronted call | At most 5 ms | A fronted call against a direct one | When the route lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Throwaway-home takeover on Codex 0.156.0 and Claude Code 2.1.283 | Primary research | Each provider's own flow completed against a server admitting only its client; the saved entry held server, issuer, client id, tokens and expiry; a renewal from outside signed the provider's own copy out (400, then `needs-auth`) | Measured for this record; the figures are inlined above |
| DPoP run with `@modelcontextprotocol/client` 2.1.0 | Primary research | Signed in and read a prompt in 77 ms; `Bearer` or proof-less `DPoP` refused; renewal with a signed proof on its own | Measured for this record; the figures are inlined above |
| Claude Code MCP reference | Documentation | The desktop app registers its connectors as in-process `type: "sdk"` servers; a command that prints a header runs in a shell | https://code.claude.com/docs/en/mcp |
| `@anthropic-ai/claude-agent-sdk` 0.3.302 | Package source | `mcp_message` flows in both directions; an `sdk` server is named in `initialize` or added later with `mcp_set_servers` | `sdk.d.ts` in the npm package |
| MCP authorization specification | Specification | Tokens bound to the resource; each client registers itself and keeps its own tokens; refresh tokens rotated for public clients | https://modelcontextprotocol.io/specification/latest/basic/authorization, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations |
| `@modelcontextprotocol/client` CHANGELOG | Package source | 2.1.0 adds DPoP (`OAuthClientProvider.dpop()`, `DpopSession`); `discoveryState` and `saveDiscoveryState` bind the callback to its authorization server | https://github.com/modelcontextprotocol/typescript-sdk/pull/2629 |
| Codex MCP prompts request | Issue | Open; no prompt verb on `main` | https://github.com/openai/codex/issues/5059 |
| Codex MCP Tasks request | Issue | Filed; no `tasks/get` on `main` | https://github.com/openai/codex/issues/48617 |
| MCP 2026-07-28 changelog | Specification | Tasks leave the core protocol for the `io.modelcontextprotocol/tasks` extension: `tasks/result` and `tasks/list` removed, `tasks/get` polled for the result, `tasks/update` for input, the server deciding whether a call becomes a task (accessed 2026-10-11) | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| MCP tasks extension 2026-07-28 | Specification | `CreateTaskResult` with `resultType: "task"`, `pollIntervalMs`, the result inline in `tasks/get`, `tasks/cancel` acknowledged empty (accessed 2026-10-11) | https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html |
| `rmcp` 3.5.1 | Package source | `AuthorizationManager` runs metadata discovery, registration, PKCE, `resource` and refresh; no DPoP signing; its tasks types serve only 2026-07-28 servers | https://crates.io/crates/rmcp |
| `@modelcontextprotocol/ext-tasks` 0.2.2 | Package source | Both task generations over the client 2.x; `createTaskSessionFromClient`, `handoff`, `resumeTask` from a reference carrying the generation; a 2026-07-28 server needs `rawDispatch` and `v2RequestFraming` (accessed 2026-10-11) | https://github.com/modelcontextprotocol/ext-tasks |
| TypeScript SDK tasks extension work | Issue | Open: the client 2.3.1 carries no task call (accessed 2026-10-11) | https://github.com/modelcontextprotocol/typescript-sdk/issues/2189 |
| Apple keychain access prompt | Documentation | An item's access list trusts the application that created it; another application's read raises a prompt | https://support.apple.com/guide/keychain-access/if-youre-asked-for-access-to-your-keychain-kyca1243/mac |

### Related ADRs

- [ADR-026: Provider Credential Custody Posture](026-provider-credential-custody-posture.md) — custody of the provider accounts' own credentials; this record covers MCP-server credentials beside it.
- [ADR-020: Machine Identity Key Custody](020-cli-identity-key-storage-custody.md) — the operating-system credential store and the binding the product uses for every daemon secret.
- [ADR-031: One Claude Code Process Per Session, One Codex Service Per Account](031-one-claude-process-per-session-one-codex-service-per-account.md) — the provider processes the service launches, which are the only ones the service fronts servers for.

### Related Specs And Plans

- [Spec-024: MCP Server Configuration And Governance](../specs/024-mcp-server-configuration-and-governance.md) — §OAuth Orchestration and §Long tool calls and the fronted route carry this record's behavior.
- [Plan-022: MCP Server Configuration And Governance](../plans/022-mcp-server-configuration-and-governance.md) — builds the sign-in, the sign-out and the fronting.
