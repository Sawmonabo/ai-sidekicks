# ADR-038: MCP Credential Custody

| Field         | Value                                    |
| ------------- | ---------------------------------------- |
| **Status**    | `accepted`                               |
| **Type**      | `Type 2 (one-way door)`                  |
| **Domain**    | Auth, MCP Governance, Credential Custody |
| **Date**      | 2026-09-29                               |
| **Author(s)** | Claude (AI-assisted)                     |
| **Reviewers** | Sawmon Abo                               |

> **Type guidance:** Type 2. This record has the background service hold, renew and hand out credentials for the MCP servers a person signs in to. Once refresh tokens live in the operating system's credential store under the service's own items and both providers reach signed-in servers through the service, taking custody back out means signing the person out of every server and moving every session's server connections back to each provider's own sign-in.

---

## Context

**What the person needs.** A tool server that wants a sign-in is signed in to once, with one press of `Sign in to this server` and one consent, and that one sign-in serves its tools, resources and prompts on Claude Code and on Codex alike, in every account, in both directions: a session that moves from one provider to the other needs no new sign-in. [Spec-024 §OAuth Orchestration](../specs/024-mcp-server-configuration-and-governance.md#oauth-orchestration) states the requirement; this record decides who holds the credential that meets it.

**Why the providers' own sign-ins cannot meet it.**

- **Codex never asks a server for its prompts.** Codex 0.156.0 has no prompt verb on its app-server and none on `main`; its MCP client methods are `mcpServerStatus/list`, `mcpServer/oauth/login`, `config/mcpServer/reload`, `mcpServer/resource/read`, `mcpServer/tool/call` and an event stream that serves only hosted apps. An upstream request asks for one ([openai/codex#5059](https://github.com/openai/codex/issues/5059)). So on a Codex session the service lists and reads a server's prompts through its own MCP client, and that client needs a credential for a server behind a sign-in.
- **Codex has no MCP Tasks and cannot move a long call to the background** ([openai/codex#48617](https://github.com/openai/codex/issues/48617)). So the service fronts every tool server a Codex session reaches, on its own route, with its own MCP client holding the real connection ([Spec-024 §Long tool calls and the fronted route](../specs/024-mcp-server-configuration-and-governance.md#long-tool-calls-and-the-fronted-route)). A fronted server behind a sign-in needs a credential the service can present.
- **A second party cannot share a provider's sign-in.** The MCP authorization specification registers each client itself (a Client ID Metadata Document, pre-registration, or dynamic registration), requires clients to "implement secure token storage", and requires an authorization server to rotate refresh tokens for public clients ([MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [Security considerations §Token Theft](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)). Measured against a server that rotates on every renewal, on Codex 0.156.0 and on Claude Code 2.1.283: once a second party renewed the provider's saved sign-in, the provider's own renewal was refused (400), its next tool call failed, and the server read `needs-auth` / `notLoggedIn` on that provider.
- **A server that demands proof-of-possession (DPoP) tokens cannot be reached by either provider.** The draft DPoP extension for MCP (SEP-1932) binds a token to the client's signing key and needs a fresh signed proof on every request. The only DPoP code in Codex 0.156.0 and Claude Code 2.1.283 serves their own AWS sign-in.

**What each provider offers to carry a credential the service holds.** Both providers run a header helper for a server reached at an address: Codex's `mcp_servers.<name>.http_headers_helper` ([openai/codex#38245](https://github.com/openai/codex/pull/38245)) and Claude Code's `headersHelper` ([Claude Code MCP §Use dynamic headers for custom authentication](https://code.claude.com/docs/en/mcp)). Each runs a command that prints a JSON object of headers, uses a printed `Authorization` header as the server's credential, and runs the helper again by itself after the server rejects a call with 401 or 403, then retries once. Measured on Codex 0.156.0 and Claude Code 2.1.282 against a local server whose credential rotated between calls: each provider connected on the helper's credential, hit one 401 after the rotation, re-ran the helper once, retried, and answered the call; the rotation never reached the caller. Codex runs its helper with the environment cleared to a fixed set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `USER`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `TZ` on Unix), a 10 s timeout and a 64 KB output cap. Claude Code runs a helper for a server passed by the session's own server set with no trust step (measured on 2.1.282); for project and local-scope servers its documentation puts the helper behind the folder's trust dialog and writes `headersHelper not run` on stderr when it is skipped.

**What each provider does with its own sign-in.** Codex keeps an MCP sign-in in the operating system's keyring under the service `Codex MCP Credentials`, falling back to `$CODEX_HOME/.credentials.json`, and in its own words "Credentials stored in the keyring will only be readable by Codex unless the user explicitly grants access"; `mcp_oauth_credentials_store = "file"` makes it write the file. Claude Code keeps its MCP sign-ins in its credential blob (`mcpOAuth`), a keychain item on macOS and a mode-0600 file elsewhere. Both saved entries carry the server, the issuer, the client id, the access and refresh tokens and the expiry. Run in a throwaway home with no provider sign-in, each provider's own flow completed against a server that admits only that provider's client (Codex through `mcpServer/oauth/login`, Claude Code through its `mcp_authenticate` control request), and the saved sign-in renewed under the same client id from outside the provider, after which the server answered `initialize`, `prompts/list` and `prompts/get` on the new token.

**The MCP client library.** `@modelcontextprotocol/client` 2.1.0 ships DPoP (`OAuthClientProvider.dpop()` returning a `DpopSession`; its CHANGELOG, [PR #2629](https://github.com/modelcontextprotocol/typescript-sdk/pull/2629)) beside discovery, registration, PKCE and `resource`; `@modelcontextprotocol/sdk` 1.30.1 does not sign DPoP proofs. Measured against a local server that issues only DPoP-bound tokens and verifies every proof: the client signed in, listed and read the server's prompt in 77 ms from the first connect; the same token sent as `Bearer`, or as `DPoP` with no proof, was refused; with every access token expired, the client renewed with a signed proof on its own and the call succeeded.

## Problem Statement

Who holds the credential for an MCP server a person signs in to, where is it kept, and how does it reach Claude Code, Codex and the service's own MCP client without any of them holding a second sign-in?

### Trigger

Codex prompts, long calls moved to the background on Codex, and DPoP servers on both providers all need a credential the service can present, and the requirement of one sign-in for both providers cannot be met by any provider's own store.

---

## Decision

**The background service holds one OAuth sign-in per MCP server, used by both providers and by its own MCP client. It keeps the refresh token in the operating system's credential store under its own item, renews it itself under the client id it was issued to, and hands a current access token only to provider processes it launched, through each provider's own header helper. `mcp.oauthLogout {serverId}` removes the sign-in. It never reads or renews a sign-in the person's own Claude Code or Codex holds.**

1. **How the service signs in.** By default as its own OAuth client: discovery from the server's protected-resource metadata, client registration by the server's metadata document or by dynamic registration, PKCE, and `resource` set to the server's address. A server whose entry names a client the server's owner issued (Codex's `oauth.client_id` and `oauth.callback_url`) is signed in as that client.
2. **A server that admits only a provider's own client.** The service runs that provider's own flow in a throwaway home it makes for this one sign-in: Codex's `mcpServer/oauth/login` with `mcp_oauth_credentials_store = "file"`, which needs no ChatGPT sign-in, or Claude Code's own flow in a credential folder of its own. It takes the saved sign-in (the server, the issuer, the client id, the access and refresh tokens, the expiry) into its own item, deletes the home, and from then on renews the sign-in under that client id and hands it to each provider through its header helper like any other signed-in server: Claude Code reaches the server directly, and Codex on the service's route, which fronts every server a Codex session reaches. It learns which client a server admits before the browser opens wherever the server says so: a refused dynamic registration, or a refusal from the server's pushed-authorization endpoint. Where the server says nothing, the first sign-in opens with the service's own client, and when that one ends as `Sign-in did not finish.`, the next press goes through the admitted provider's client. The service remembers which client each server admitted, so every later sign-in is one press.
3. **Where the credential lives.** The refresh token is kept in the operating system's credential store, under an item the service created, never in a file of its own; on a Linux machine with no Secret Service the item goes in the service's one file readable by this account alone, as every daemon secret does ([ADR-020 §The Credential Store](020-cli-identity-key-storage-custody.md#the-credential-store)). Access tokens are held in the service's memory. Nothing is logged, relayed, shown, placed on any event, error or wire payload, or given to the renderer.
4. **How a provider gets a token.** Each provider process the service launches carries a header helper for each signed-in server: Codex's `http_headers_helper`, Claude Code's `headersHelper`. The helper asks the service over its same-user local socket for a current access token and prints it as the `Authorization` header. Its command line carries only a server handle and a session handle and the socket's path, never a credential, because a command line is visible in process listings; it names the command-line tool by absolute path because Codex clears the helper's environment. A provider process the service did not launch gets nothing. Each provider re-runs its helper by itself after a rejected token, so a renewal never reaches the person.
5. **The service's own MCP client uses the same sign-in.** It lists and reads a server's prompts for a Codex session and holds the real connection for every server it fronts.
6. **A server that demands DPoP tokens.** The service signs in as its own client with a signing key made for that one sign-in, one key per server and never the machine's own control-plane key, kept in the operating system's credential store beside the refresh token. Because a header helper cannot carry a per-request proof, the service fronts that server for Claude Code and Codex alike and signs a fresh proof for every request.
7. **Sign-out.** `mcp.oauthLogout {serverId}` deletes the service's refresh token for that server, and its signing key where the server demands DPoP, and ends the access tokens it handed out: each provider's next call to that server gets no token, and the server reads `Needs sign-in` in every session on both providers until the next sign-in.
8. **The person's own provider sign-ins stay theirs.** The service never reads or renews a sign-in held by the person's own Claude Code or Codex outside the app. A server replaces a public client's refresh token on every renewal, so a second party renewing it would sign the person's own provider out.
9. **The sign-in page's address** is held only while the sign-in uses it, written to no storage and no log, and dropped when the sign-in settles.

**Provider accounts and MCP servers.** [ADR-026](026-provider-credential-custody-posture.md) governs the credentials of the provider accounts themselves (Claude Code's and Codex's own sign-ins). This record governs the credentials of MCP servers, and only those: for an MCP server the service is an OAuth client in its own right and speaks the server's token endpoint for its own sign-ins. Nothing here widens what the service may do with a provider account's credential, and nothing in ADR-026 governs an MCP server's.

**Library.** The service's MCP client is `@modelcontextprotocol/client` 2.3.0, the one maintained MCP client that signs DPoP proofs; the refresh token and the DPoP key go through `@napi-rs/keyring` 2.1.0, the credential-store binding [ADR-020](020-cli-identity-key-storage-custody.md) names, opened with `{linux: {store: "secret-service"}}` on macOS and Linux. On Windows, native and WSL alike, they go through the service's Windows half at `CRED_PERSIST_LOCAL_MACHINE`, as every daemon secret does, because the 2.1.0 binding's Windows path writes every entry at the roaming Enterprise persistence. `@modelcontextprotocol/sdk` stays in the daemon only to host Playwright's tool server.

### Thesis — Why This Option

- **It is the only option that meets the requirement as stated.** One press and one consent cover tools, resources and prompts on both providers, in every account, in both directions. Every other option either asks for a second consent, fails outright on some servers, or depends on a provider's private store.
- **It is built from hooks each provider documents.** The header helper is a published configuration key on both providers, and the measured runs show each provider connecting on the helper's credential and renewing through it after a rejection, with no provider file read and no provider store touched.
- **It follows the MCP specification's own model.** Each client registers itself, keeps its own tokens and renews its own refresh token. The service is one more client of the server, never a second holder of someone else's sign-in.
- **It closes the DPoP case on both providers.** Neither provider can reach a DPoP server by any route of its own; the service signs in with its own key and fronts the server, and the measured client renews with a signed proof on its own.
- **It keeps the credential inside the boundary the providers already use.** The refresh token sits in the operating system's credential store under the service's own item, so no cross-application keychain prompt fires, and the helper's socket is same-user, the same boundary as the providers' own stores.

### Antithesis — The Strongest Case Against

- **It puts the service in the credential blast radius of every server the person signs in to.** A compromised service can mint access tokens for all of them, where otherwise a compromise of one provider exposes only that provider's sign-ins.
- **The adopted sign-in rides a private format.** Taking over a provider's saved sign-in reads a file layout (`.credentials.json`, the Claude Code blob) that neither provider documents, and a release can change it.
- **The helper is a new executable path into every provider process.** A helper that answers the wrong session, or a socket another user can reach, hands a token to a process that should not have it.
- **Claude Code's helper trust rule is version-sensitive.** Its documentation puts the helper behind the folder's trust dialog for project and local-scope servers, and the measured "no trust step" holds on 2.1.282 for servers the session's own set passes.
- **A sign-out the service performs does not revoke the token at the authorization server.** An access token already handed to a provider stays valid until it expires.

### Synthesis — Why It Still Holds

- **Blast radius:** the credential is held once, in the operating system's store under one item per server, and access tokens go only to processes the service launched, over a same-user socket; the renderer, events, logs and wire never carry one. The alternative is not "no custody" but one custody per provider plus a second consent, and the person still signs in to the same servers.
- **Private format:** the service reads a provider's saved sign-in only from the throwaway home it made for that one sign-in, once, right after the provider's own flow finishes, and deletes the home. A format change fails that sign-in visibly (`Sign-in did not finish.`); it never touches a store the person uses. The upstream asks for a prompt verb and MCP Tasks on Codex are filed, and when they land the fronting that needs the adopted sign-in narrows.
- **Helper path:** the helper's command line carries handles, never a credential, and the service answers only for a session it launched with that server switched on. A provider process the service did not launch has no handle to present.
- **Trust rule:** the service watches each Claude Code process's stderr for the documented `headersHelper not run` line and reports it as a fault on that server's leg, never as a silently unauthenticated server; the provider-wire pin check covers the rule on every pin.
- **Revocation:** sign-out deletes the refresh token and stops answering the helper at once, so no provider can renew; the residual is one access token's remaining lifetime, and the server reads `Needs sign-in` everywhere on the next call. This is an accepted risk.

---

## Alternatives Considered

### Option A: One service-held sign-in per server, handed to both providers through their header helpers, with the adopted and DPoP arms (Chosen)

- **What:** The Decision above.
- **Steel man:** One sign-in, one consent, both providers, both directions, Codex prompts and long calls included, DPoP servers reachable at all; built from documented hooks and measured on both providers.
- **Weaknesses:** The service holds refresh tokens; the adopted arm depends on a provider's saved-sign-in layout; a sign-out leaves one access token's remaining lifetime.

### Option B: The service signs in for prompts only, tokens held in memory (Rejected)

- **What:** Each provider keeps its own sign-in for tools and resources; the service's MCP client runs its own flow only to list and read prompts for Codex, and keeps the tokens in memory.
- **Steel man:** Nothing is persisted, so the service holds no durable credential; each provider's sign-in stays exactly where it is.
- **Why rejected:** Two consent pages per server, and a fresh consent after every service restart. It does nothing for a fronted long call on a server behind a sign-in, and nothing for a DPoP server. It falls short of one sign-in for both providers.

### Option C: The service reads the provider's own saved sign-in (Rejected)

- **What:** The service reads the access token Codex or Claude Code stored for a server, uses it only for its own calls, never renews it, and has the provider renew it by reconnecting.
- **Steel man:** Exactly one sign-in, the provider's own; the service adds no client registration.
- **Why rejected:** It reads a private store layout that can change in any release. On macOS the first read raises the system's keychain prompt for the service's binary once per item, because the item trusts only the application that made it ([Apple: If you're asked for access to your keychain](https://support.apple.com/guide/keychain-access/if-youre-asked-for-access-to-your-keychain-kyca1243/mac)). It fails outright on a DPoP server. Renewing on the provider's behalf is not an option at all: a rotated refresh token signs the provider out, as measured on both.

### Option D: Carry the provider's MCP sign-ins across its accounts (Rejected)

- **What:** A reference app copies the `mcpOAuth` entries of Claude Code's credential blob from one account home to the next when it switches accounts, so a switch does not force every server to sign in again.
- **Steel man:** One sign-in per server per provider survives account switches with no new client.
- **Why rejected:** It is custody of the provider's own store, it still needs one sign-in per provider, it does nothing for Codex prompts, long calls or DPoP, and two homes holding one rotating refresh token sign each other out.

### Option E: Wait for the providers (Filed in parallel, not chosen alone)

- **What:** Ask Codex for `mcpServer/prompt/list` and `mcpServer/prompt/get` beside `mcpServer/resource/read` (a comment on [openai/codex#5059](https://github.com/openai/codex/issues/5059)) and for MCP Tasks ([openai/codex#48617](https://github.com/openai/codex/issues/48617)), and let each provider keep its own sign-in.
- **Steel man:** The provider's own authenticated connection would serve prompts and tasks with no credential in the service.
- **Why not chosen alone:** No date and no linked change on either request, and neither closes DPoP or the one-consent requirement. When the verbs land the service uses them and its fronting narrows; the single sign-in for both providers keeps its own value.

---

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Both providers keep running a header helper for a server reached at an address, and re-run it after a 401 or 403 | Codex `http_headers_helper` ([openai/codex#38245](https://github.com/openai/codex/pull/38245)); Claude Code `headersHelper` ([Claude Code MCP](https://code.claude.com/docs/en/mcp)); measured on Codex 0.156.0 and Claude Code 2.1.282 | A provider reaches a signed-in server only through the service's route; the service fronts it on that provider too |
| 2 | Claude Code runs a helper for a server the session's own set passes, with no trust step | Measured on 2.1.282; the documented trust rule names project and local-scope servers | The helper is skipped; detected by the `headersHelper not run` stderr line and reported on the leg; the service fronts the server on Claude Code |
| 3 | A provider's flow in a throwaway home saves the sign-in in a form the service can take over | Measured on Codex 0.156.0 (`.credentials.json` with `mcp_oauth_credentials_store = "file"`) and Claude Code 2.1.283 (its credential blob, in a Linux container) | That arm's sign-in ends `Sign-in did not finish.`; the pin check catches the layout change; the service's own client and owner-issued clients are unaffected |
| 4 | The operating system's credential store is available to the service | `@napi-rs/keyring` 2.1.0 over the macOS keychain and the Secret Service on Linux, with the service's `0600` file where no Secret Service answers and on a Mac from its approved logged-out service's takeover until `sidekicks daemon uninstall`, even after that service is turned off in Login Items & Extensions; the service's Windows half over the Windows Credential Manager at `CRED_PERSIST_LOCAL_MACHINE` | Sign-in refuses with the store's cause; the refresh token is stored nowhere else |
| 5 | An authorization server rotates a public client's refresh token on renewal | [MCP security considerations §Token Theft](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations); measured on both providers | Nothing breaks; the rule that the service never renews the person's own provider sign-in costs nothing |
| 6 | `@modelcontextprotocol/client` 2.1.0 or later signs and renews with DPoP | Its CHANGELOG ([PR #2629](https://github.com/modelcontextprotocol/typescript-sdk/pull/2629)); measured against a local DPoP server | DPoP servers stay unreachable until the client is fixed; every other server is unaffected |
| 7 | A fronted call costs at most 5 ms over a direct one | **Unvalidated.** Measured at build against a direct call | The route's overhead is visible in tool latency; the fronting is revisited |

---

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| The credential store is locked or unavailable | Low | Medium | The store call fails on sign-in or on the first token request | Fail closed: the server reads `Needs sign-in`, nothing is stored anywhere else, the store error surfaces on the sign-in attempt |
| A Claude Code pin tightens the helper trust rule | Medium | Medium | The `headersHelper not run` line on the process's stderr; the provider-wire pin check | Report the fault on that server's leg; front the server on Claude Code through the service's route |
| A provider changes its saved-sign-in layout | Medium | Low | The takeover of the throwaway home finds no entry and the sign-in ends `Sign-in did not finish.`; the pin check | Update the reader at the next pin; only servers that admit a provider's client alone are affected |
| Two renewals race inside the service | Low | High | A renewal refused as `invalid_grant` right after a successful one | One renewal in flight per server, the rest wait on it, so a rotated refresh token is never replayed |
| A helper is asked for a server or session it does not hold | Low | High | The service's socket handler refuses the handle and logs the refusal without the handle's token | Answer only for a session the service launched with that server switched on; a refused helper prints nothing |
| A provider process outlives its session | Low | Medium | A helper presents the handle of a session that has closed | The service stops answering that handle at session close |

## Reversibility Assessment

- **Reversal cost:** Weeks. Every signed-in server is signed out, each provider's own sign-in comes back per provider, the fronted route loses its signed-in servers, Codex prompts and background calls on those servers go away, and DPoP servers become unreachable.
- **Blast radius:** Spec-024's sign-in, sign-out and fronting; the service's MCP client; both drivers' helper configuration; Settings › MCP servers.
- **Migration path:** Stop issuing helpers, delete every item the service created in the credential store, and route each provider's sign-in back to its own flow; the person signs in again per provider.
- **Point of no return:** The first release in which a person signs in through the service. Before it, the custody is code and documents; after it, reversing signs the person out of every server they signed in to.

## Consequences

### Positive

- One sign-in and one consent per server serve tools, resources and prompts on Claude Code and Codex, in every account and in both directions.
- Codex sessions get a server's prompts and background long calls on a server behind a sign-in.
- A DPoP server is reachable from both providers.
- A token renewal never reaches the person.

### Negative (accepted trade-offs)

- The service holds refresh tokens for every server the person signs in to; accepted because the credential stays in the operating system's store under the service's own item and reaches only processes the service launched.
- The adopted arm depends on each provider's saved-sign-in layout; accepted because it runs only in a throwaway home and fails visibly.
- A sign-out leaves one access token's remaining lifetime; accepted because nothing can renew it.

### Unknowns

- The service's own flow end to end against a real OAuth-protected server (discovery, metadata-document or dynamic registration, the consent-page count): run at build against the MCP TypeScript SDK's OAuth example with a scripted consent.
- The helper's start time as a command-line call over the service's socket: measured when that command lands; both providers allow a helper 10 s.
- Claude Code's adopted sign-in on macOS, where its blob is a keychain item: run at build.
- Windows: none of the helper runs were made there.

---

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Sign-ins per server to reach it from both providers | One | An end-to-end run: sign in once, call a tool on Claude Code and on Codex, list prompts on Codex | When the sign-in lands |
| A credential on any event, error, log, wire payload, renderer state or command line | Zero | The credential-echo sweep over every egress, and a process-listing check of each helper's command line | When the sign-in lands |
| Reads or renewals of a store the person's own provider uses | Zero | A test that plants a provider-owned sign-in outside the service's homes and asserts it is untouched after sign-in, renewal and sign-out | When the sign-in lands |
| Calls that reach a server after sign-out | Zero beyond one access token's remaining lifetime | Sign out, then call from each provider and from the service's client | When the sign-out lands |
| Added latency on a fronted call | At most 5 ms | A fronted call against a direct one | When the route lands |

---

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Header-helper run on Codex 0.156.0 and Claude Code 2.1.282 | Primary research | Both providers connected on a helper-printed credential; after a rotation each hit one 401, re-ran the helper once and retried successfully; Claude Code listed prompts itself on that credential | Measured for this record; the figures are inlined above |
| Throwaway-home takeover on Codex 0.156.0 and Claude Code 2.1.283 | Primary research | Each provider's own flow completed against a server admitting only its client; the saved entry held server, issuer, client id, tokens and expiry; a renewal from outside signed the provider's own copy out (400, then `needs-auth`) | Measured for this record; the figures are inlined above |
| DPoP run with `@modelcontextprotocol/client` 2.1.0 | Primary research | Signed in and read a prompt in 77 ms; `Bearer` or proof-less `DPoP` refused; renewal with a signed proof on its own | Measured for this record; the figures are inlined above |
| Codex dynamic HTTP header helpers | Upstream change | `http_headers_helper` per `url` server; cleared environment, 10 s timeout, 64 KB cap; re-run once after 401/403 | https://github.com/openai/codex/pull/38245 |
| Claude Code MCP reference | Documentation | `headersHelper` runs at session start and on reconnect, re-runs after 401/403 and retries once; an `Authorization` header from it is used instead of OAuth | https://code.claude.com/docs/en/mcp |
| MCP authorization specification | Specification | Tokens bound to the resource; each client registers itself and keeps its own tokens; refresh tokens rotated for public clients | https://modelcontextprotocol.io/specification/latest/basic/authorization, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations |
| `@modelcontextprotocol/client` CHANGELOG | Package source | 2.1.0 adds DPoP (`OAuthClientProvider.dpop()`, `DpopSession`); `discoveryState` and `saveDiscoveryState` bind the callback to its authorization server | https://github.com/modelcontextprotocol/typescript-sdk/pull/2629 |
| Codex MCP prompts request | Issue | Open; no prompt verb on `main` | https://github.com/openai/codex/issues/5059 |
| Codex MCP Tasks request | Issue | Filed; no `tasks/get` on `main` | https://github.com/openai/codex/issues/48617 |
| Apple keychain access prompt | Documentation | An item's access list trusts the application that created it; another application's read raises a prompt | https://support.apple.com/guide/keychain-access/if-youre-asked-for-access-to-your-keychain-kyca1243/mac |

### Related ADRs

- [ADR-026: Provider Credential Custody Posture](026-provider-credential-custody-posture.md) — custody of the provider accounts' own credentials; this record covers MCP-server credentials beside it.
- [ADR-020: Machine Identity Key Custody](020-cli-identity-key-storage-custody.md) — the operating-system credential store and the binding the product uses for every daemon secret.
- [ADR-031: One Claude Code Process Per Session, One Codex Service Per Account](031-one-claude-process-per-session-one-codex-service-per-account.md) — the provider processes the service launches, which are the only ones that get a helper.

### Related Specs And Plans

- [Spec-024: MCP Server Configuration And Governance](../specs/024-mcp-server-configuration-and-governance.md) — §OAuth Orchestration and §Long tool calls and the fronted route carry this record's behavior.
- [Plan-022: MCP Server Configuration And Governance](../plans/022-mcp-server-configuration-and-governance.md) — builds the sign-in, the helper, the sign-out and the fronted route.
