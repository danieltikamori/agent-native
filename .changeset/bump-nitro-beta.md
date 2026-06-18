---
"@agent-native/core": patch
---

Bump nitro to 3.0.260610-beta to address a dev-server cold-start race where the
Nitro Vite worker could be hit before its entry module finished importing,
surfacing as `Vite environment "nitro" is unavailable` / `UND_ERR_SOCKET`.

Also raises the `jiti` dependency floor to `^2.7.0` to satisfy the new Nitro
beta's peer requirement for downstream consumers of the published package.

Additionally fixes the underlying cold-start route race rather than patching a
single route. h3 reads its middleware list exactly once per request (inside
`handler()`), so any route registered by an async plugin after that snapshot —
e.g. `/_agent-native/speculation-rules.json`, MCP, or auth routes — could 404 on
the first request. Nitro awaits `h3.config.onRequest` before that snapshot, but
its dev runtime stub wires neither Nitro hooks nor `onRequest`, so the previous
gate never ran in dev. The framework now patches `h3.config.onRequest` directly
to await default-plugin bootstrap and tracked plugin inits before the snapshot,
so late-registered framework routes are dispatched naturally on every runtime.
