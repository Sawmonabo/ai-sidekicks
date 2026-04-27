# Repo Exploration: Relay And Support Packages

## Table of Contents
- [Relay](#relay)
- [Highlight](#highlight)
- [Expo Two-Way Audio](#expo-two-way-audio)
- [Website](#website)
- [Sources](#sources)

## Relay
`packages/relay` is intentionally narrow. Its core abstraction is the encrypted channel in `packages/relay/src/encrypted-channel.ts`, which wraps a WebSocket-like transport and makes the initiator and responder behave symmetrically after an initial key exchange.[S1]

The client-side path generates a keypair, imports the daemon public key obtained during pairing, derives a shared key, sends `e2ee_hello`, and retries the plaintext hello until the channel opens. The daemon-side path waits for that hello, derives the shared key from its long-lived keypair, sends `e2ee_ready`, and then promotes the transport into the encrypted channel state.[S1]

That code directly implements the trust model described in `SECURITY.md`: the relay is not trusted with plaintext, and the pairing artifact containing the daemon public key is the trust anchor for the channel.[S2][S1]

## Highlight
`packages/highlight` is a small utility package used for syntax highlighting. `highlightCode()` selects a parser by filename, parses the source with Lezer, maps syntax tags to CSS-like token classes, builds a per-character style map, and then compresses that back into per-line tokens. `highlightLine()` is just a one-line convenience wrapper over the full-file path.[S3]

The design is intentionally simple: parse once, map tags, then emit neutral token objects instead of binding the package to a specific renderer.[S3]

## Expo Two-Way Audio
`packages/expo-two-way-audio` is a thin bridge package around a native Expo module. The `core.ts` file exposes initialization, PCM playback, recording toggles, teardown/restart, microphone permission access, iOS microphone mode helpers, and playback control without adding additional business logic in JavaScript.[S4]

That is consistent with the rest of the repo: higher-level speech and voice logic belongs in the daemon and app packages, while this package only abstracts the native device boundary.[S4]

## Website
`packages/website` is the marketing surface, not part of the control plane. The landing page composes the main site sections such as the hero, download/get-started actions, provider positioning, FAQ, and footer links. It uses animated presentation components, but it does not participate in daemon runtime or relay behavior.[S5]

This package matters mostly because it documents product positioning and distribution targets from the public-facing side while the rest of the repo implements the product itself.[S5]

## Sources
- [S1] `packages/relay/src/encrypted-channel.ts#L1-L260`, E2EE handshake, hello/ready flow, retries, and channel wrapper.
- [S2] `SECURITY.md#L16-L62`, relay threat model, local daemon trust boundary, and supported remote-access path.
- [S3] `packages/highlight/src/highlighter.ts#L1-L111`, parser selection and token emission strategy.
- [S4] `packages/expo-two-way-audio/src/core.ts#L1-L62`, native audio bridge API surface.
- [S5] `packages/website/src/components/landing-page.tsx#L1-L220`, landing-page structure and public product sections.
