---
"@agent-native/core": patch
---

Bump nitro to 3.0.260610-beta to address a dev-server cold-start race where the
Nitro Vite worker could be hit before its entry module finished importing,
surfacing as `Vite environment "nitro" is unavailable` / `UND_ERR_SOCKET`.

Also raises the `jiti` dependency floor to `^2.7.0` to satisfy the new Nitro
beta's peer requirement for downstream consumers of the published package.

Fixes a dev-only 404 for extension-bearing framework endpoints such as
`/_agent-native/speculation-rules.json` and `/.well-known/agent-card.json`.
Nitro's Vite dev middleware classifies any request whose path has an asset-like
extension as a static asset (handing it to Vite) unless a Nitro _route_ matches
it. Framework endpoints are registered as h3 middleware, invisible to Nitro's
route table, so their `.json`/`.png` URLs were misrouted to Vite and 404'd
before reaching the server (extensionless routes like `/ping` were unaffected).
The framework now adds a dev Vite middleware that marks `/_agent-native/*` and
framework `/.well-known/*` requests as dynamic so Nitro's dev handler serves
them. Production builds don't run this heuristic and were never affected.

Also hardens the async-plugin cold-start path: h3 snapshots its middleware list
once per request (inside `handler()`), so a route registered by an async plugin
after that snapshot can 404 on the first request. The framework patches
`h3.config.onRequest` to await default-plugin bootstrap and tracked plugin inits
before the snapshot, so late-registered framework routes dispatch naturally on
every runtime (the dev stub wires neither Nitro hooks nor `onRequest`).
