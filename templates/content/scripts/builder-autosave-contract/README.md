# Builder `autoSaveOnly` contract-test harness

Controlled, real-API contract tests that answer whether Builder's
`?autoSaveOnly=true` write stages a revision **without** changing the live
published artifact — the assumption that gates live Builder writes in the
content template.

Modeled on the Fusion Notion contract-test repo
(`fusion-content-workspace-notion-contract-tests`): controlled real-API calls,
captured raw request/response, runnable scripts.

## Files

- `builder-client.ts` — dependency-free Builder API client. Write API
  (`https://builder.io/api/v1/write/...`, `Bearer` private key) + delivery CDN
  (`https://cdn.builder.io/api/v3/content/...`, public `apiKey`). Every call
  returns a `CapturedExchange` with the request (private key/apiKey redacted)
  and the raw response. Hosts overridable via `BUILDER_CONTENT_API_HOST` /
  `BUILDER_CMS_API_HOST` / `BUILDER_CDN_HOST`.
- `safety.ts` — the non-negotiable guard. `ThrowawayRegistry.assertMutable()`
  is the single chokepoint every write passes through; it throws unless the
  target id was created by this run AND its name carries the
  `zz-autosave-contract-test` prefix.
- `run-contract.ts` — the lifecycle runner: create+publish a throwaway entry,
  autosave-PATCH it, re-read delivery, query by handle, and (gated) unpublish.
  Writes evidence to `evidence/`.
- `probe-readonly.ts` — GET-only delivery probe. Never reads the private key;
  safe to run against a real space to characterize the response envelope.

## Running

Needs Node ≥ 22 (uses `--experimental-strip-types` and `--env-file`; no build
step, no extra deps).

```bash
cd templates/content

# Plan only (no network):
node --experimental-strip-types scripts/builder-autosave-contract/run-contract.ts

# Read-only delivery probe (only needs public BUILDER_API_KEY):
node --env-file=.env.local --experimental-strip-types \
  scripts/builder-autosave-contract/probe-readonly.ts --model blog-article

# Full live run against your own throwaway entry:
node --env-file=.env.local --experimental-strip-types \
  scripts/builder-autosave-contract/run-contract.ts --live \
  --model zz-autosave-contract-test-model

# Plus the destructive published:"draft" unpublish probe (throwaway only):
... --live --allow-unpublish-test
```

## Credentials (env, never hard-coded)

| var | purpose |
| --- | --- |
| `BUILDER_PRIVATE_KEY` / `BUILDER_CMS_PRIVATE_KEY` | write API bearer token |
| `BUILDER_API_KEY` / `BUILDER_PUBLIC_KEY` | public delivery `apiKey` |

## Safety rules baked in

- Writes only ever target an entry the harness created **this run** whose name
  starts with `zz-autosave-contract-test`. Anything else throws before the call.
- `--live` is required to make any write. The destructive unpublish probe
  additionally requires `--allow-unpublish-test`.
- Throwaway entries are left in place and their IDs printed for manual cleanup
  (`DELETE /api/v1/write/{model}/{id}` or the Builder UI).
- Captured evidence redacts the private key and `apiKey`. The `evidence/` dir is
  gitignored because raw responses can contain real entry content.

Findings live in `templates/content/docs/builder-autosave-contract-findings.md`.
