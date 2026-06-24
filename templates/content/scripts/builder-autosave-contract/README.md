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
  (`https://cdn.builder.io/api/v3/content/...`, public `apiKey`). Mutators
  (`createEntry`/`patchEntry`) accept only a capability token from `safety.ts`,
  never a bare model/id. Every call returns a `CapturedExchange`; all persisted
  fields pass through one recursive redaction path that strips credential-like
  query params (incl. ones nested in embedded URLs) and body/header fields.
  Hosts overridable via `BUILDER_CONTENT_API_HOST` / `BUILDER_CMS_API_HOST` /
  `BUILDER_CDN_HOST`.
- `safety.ts` — the non-negotiable guard and the **only** minter of write
  capability tokens. `assertModelAllowedForLive()` gates the target model (no
  default production model; non-test models need `--allow-model`).
  `ThrowawayRegistry` issues a `MutableTarget` only after the entry was created
  this run AND its name carries the `zz-autosave-contract-test` prefix. A write
  without a token is unrepresentable, so the guard is unbypassable.
- `run-contract.ts` — the lifecycle runner: create a throwaway entry **as a
  draft**, autosave-PATCH it, re-read delivery, **assert** the invariants
  (published/marker unchanged, `hasAutosaves` flipped), query by handle, and
  (gated) unpublish. Exits nonzero on any violated invariant. Writes evidence
  to `evidence/`.
- `safety.test.ts` — pure-function tests for the guard, the model gate, token
  forgery rejection, and redaction. No network.
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

| var                                               | purpose                  |
| ------------------------------------------------- | ------------------------ |
| `BUILDER_PRIVATE_KEY` / `BUILDER_CMS_PRIVATE_KEY` | write API bearer token   |
| `BUILDER_API_KEY` / `BUILDER_PUBLIC_KEY`          | public delivery `apiKey` |

## Safety rules baked in

- Writes only ever target an entry the harness created **this run** whose name
  starts with `zz-autosave-contract-test`. The client mutators require a
  capability token only `safety.ts` can mint, so anything else throws before the
  call — it is not just a caller convention.
- Live writes refuse any model that is not test-named (`zz-*` /
  `autosave-contract-test`) unless explicitly allowlisted via `--allow-model`.
  There is no default production model.
- The throwaway entry is created as a **draft** — even it is never pushed live.
- `--live` requires **both** the write key and the delivery key; without the
  delivery key it cannot assert the contract and refuses to run.
- The destructive unpublish probe additionally requires `--allow-unpublish-test`.
- Throwaway entries are left in place and their IDs printed for manual cleanup
  (`DELETE /api/v1/write/{model}/{id}` or the Builder UI).
- Captured evidence redacts credentials recursively — the private key, `apiKey`
  (incl. nested in pixel/preview URLs), and credential-named body/header fields.
  The `evidence/` dir is gitignored because raw responses can contain real
  entry content.

Findings live in `templates/content/docs/builder-autosave-contract-findings.md`.
