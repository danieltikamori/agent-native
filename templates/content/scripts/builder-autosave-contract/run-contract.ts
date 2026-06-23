/**
 * Builder autoSaveOnly contract-test harness.
 *
 * Purpose: produce raw API evidence (not docs) for the question that gates
 * live Builder writes — does `PUT/PATCH ...?autoSaveOnly=true` stage a revision
 * WITHOUT changing the live published artifact?
 *
 * Mirrors the reference pattern in
 * /Users/alicemoore/Developer/fusion-content-workspace-notion-contract-tests
 * (controlled real-API calls, captured raw request/response, a runnable script).
 *
 * USAGE
 *   # Plan only (no network), safe to run anywhere:
 *   node --experimental-strip-types scripts/builder-autosave-contract/run-contract.ts
 *
 *   # Live run against YOUR throwaway entry (requires credentials in env):
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/builder-autosave-contract/run-contract.ts --live --model zz-autosave-contract-test-model
 *
 *   # Also exercise the DESTRUCTIVE published:"draft" unpublish probe (Q3),
 *   # on the throwaway entry only:
 *   ... --live --allow-unpublish-test
 *
 * CREDENTIALS (read from env; see resolveConfig):
 *   BUILDER_PRIVATE_KEY (or BUILDER_CMS_PRIVATE_KEY)  — write API bearer token
 *   BUILDER_API_KEY     (or BUILDER_PUBLIC_KEY)       — public delivery apiKey
 *
 * SAFETY: the harness only ever mutates entries it created this run whose name
 * carries the `zz-autosave-contract-test` prefix (enforced in safety.ts). It
 * never touches pre-existing content. The destructive draft probe additionally
 * requires the explicit --allow-unpublish-test flag.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuilderContractClient,
  type CapturedExchange,
  resolveConfig,
} from "./builder-client.ts";
import {
  makeThrowawayName,
  parseFlags,
  type RunFlags,
  ThrowawayRegistry,
} from "./safety.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(HERE, "evidence");

interface FindingRecord {
  question: string;
  status: "answered" | "blocked";
  evidenceLabels: string[];
  note: string;
}

function entryIdFrom(exchange: CapturedExchange): string | undefined {
  const body = exchange.response.body;
  if (!body || typeof body !== "object") return undefined;
  const rec = body as Record<string, unknown>;
  for (const key of ["id", "_id", "@id", "uuid"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function summarizeDelivery(exchange: CapturedExchange): string {
  const body = exchange.response.body;
  if (!exchange.response.ok) {
    return `HTTP ${exchange.response.status} (${exchange.response.statusText})`;
  }
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    const results = Array.isArray(rec.results) ? rec.results : null;
    if (results) return `${results.length} result(s)`;
    return `single entry: published=${String(rec.published)} lastUpdated=${String(rec.lastUpdated)}`;
  }
  return "no body";
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

async function runLive(
  client: BuilderContractClient,
  flags: RunFlags,
): Promise<{ findings: FindingRecord[] }> {
  const registry = new ThrowawayRegistry();
  const findings: FindingRecord[] = [];
  const model = flags.model;

  // --- Step 0: create a throwaway entry and PUBLISH it ---------------------
  const name = makeThrowawayName();
  log(`\n[create] creating + publishing throwaway entry "${name}" in model "${model}"`);
  const created = await client.createEntry({
    label: "create-published-throwaway",
    model,
    body: {
      name,
      published: "published",
      data: {
        title: name,
        handle: name,
        marker: "v1-original-published",
      },
    },
  });
  const entryId = entryIdFrom(created);
  if (!created.response.ok || !entryId) {
    log(
      `[create] FAILED (HTTP ${created.response.status}). Cannot proceed — ` +
        `no throwaway entry to test against. See evidence.`,
    );
    return {
      findings: [
        {
          question: "ALL",
          status: "blocked",
          evidenceLabels: ["create-published-throwaway"],
          note:
            `Could not create a throwaway entry (HTTP ${created.response.status}). ` +
            `Likely the model "${model}" does not exist in this space, or the ` +
            `private key lacks write scope. Create a dedicated test model first.`,
        },
      ],
    };
  }
  registry.register(entryId, name);
  log(`[create] created entry id=${entryId}`);

  // Baseline live delivery (what visitors see) before any autosave.
  await client.getDeliveredEntry({
    label: "q1-baseline-live-delivery",
    model,
    entryId,
    cachebust: true,
  });
  await client.getDeliveredEntry({
    label: "q2-baseline-include-unpublished",
    model,
    entryId,
    includeUnpublished: true,
    cachebust: true,
  });

  // --- Q1/Q2: autoSaveOnly=true PATCH against the published entry ----------
  registry.assertMutable(entryId, "autoSaveOnly PATCH");
  log(`[autosave] PATCH ...?autoSaveOnly=true&triggerWebhooks=false on ${entryId}`);
  await client.patchEntry({
    label: "q1-autosave-patch",
    model,
    entryId,
    query: { autoSaveOnly: "true", triggerWebhooks: "false" },
    body: { data: { marker: "v2-autosaved-should-NOT-go-live" } },
  });

  // Re-read live delivery + includeUnpublished AFTER autosave.
  await client.getDeliveredEntry({
    label: "q1-live-delivery-after-autosave",
    model,
    entryId,
    cachebust: true,
  });
  await client.getDeliveredEntry({
    label: "q2-include-unpublished-after-autosave",
    model,
    entryId,
    includeUnpublished: true,
    cachebust: true,
  });

  findings.push({
    question:
      "Q1: Does autoSaveOnly=true leave the live published artifact unchanged?",
    status: "answered",
    evidenceLabels: [
      "q1-baseline-live-delivery",
      "q1-autosave-patch",
      "q1-live-delivery-after-autosave",
    ],
    note:
      "Compare the `marker` field in q1-baseline-live-delivery vs " +
      "q1-live-delivery-after-autosave. If unchanged (still v1-original), " +
      "autosave is non-destructive to the live artifact.",
  });
  findings.push({
    question:
      "Q2: Does autosave create a History revision / change lastUpdated / cache?",
    status: "answered",
    evidenceLabels: [
      "q2-baseline-include-unpublished",
      "q1-autosave-patch",
      "q2-include-unpublished-after-autosave",
    ],
    note:
      "Inspect the autosave response body and the includeUnpublished read for " +
      "revision/draft fields and lastUpdated. triggerWebhooks=false in the " +
      "query controls webhook firing; the response status/body is the evidence.",
  });

  // --- Q4: identify live vs autosaved revision fields ----------------------
  findings.push({
    question: "Q4: Which response fields distinguish live vs autosaved revision?",
    status: "answered",
    evidenceLabels: [
      "q1-autosave-patch",
      "q1-live-delivery-after-autosave",
      "q2-include-unpublished-after-autosave",
    ],
    note:
      "Diff the field set across the three: the live delivery shows the " +
      "published revision; includeUnpublished surfaces the staged one. Look " +
      "for `published`, `lastUpdated`, `meta`, `id` and any revision markers.",
  });

  // --- Q5: duplicate-handle / listing semantics ---------------------------
  await client.queryEntries({
    label: "q5-query-by-handle",
    model,
    query: { "query.data.handle": name },
    includeUnpublished: true,
    limit: 10,
  });
  findings.push({
    question:
      "Q5: scheduled entries + duplicate-handle resolution when includeUnpublished=true",
    status: "answered",
    evidenceLabels: ["q5-query-by-handle"],
    note:
      "q5-query-by-handle returns all entries matching the handle. Count " +
      "results and inspect ordering (lastUpdated desc) to define a " +
      "deterministic dedupe rule. Scheduled entries surface via " +
      "startDate/endDate fields in the entry body.",
  });

  // --- Q3: DESTRUCTIVE published:"draft" probe (gated) --------------------
  if (flags.allowUnpublishTest) {
    registry.assertMutable(entryId, "published:draft unpublish PATCH");
    log(
      `[unpublish] (--allow-unpublish-test) PATCH published:"draft" on ${entryId}`,
    );
    await client.patchEntry({
      label: "q3-unpublish-patch",
      model,
      entryId,
      query: { triggerWebhooks: "false" },
      body: { published: "draft" },
    });
    await client.getDeliveredEntry({
      label: "q3-live-delivery-after-unpublish",
      model,
      entryId,
      cachebust: true,
    });
    findings.push({
      question:
        "Q3: What does published:\"draft\" (no autoSaveOnly) do to a live entry?",
      status: "answered",
      evidenceLabels: ["q3-unpublish-patch", "q3-live-delivery-after-unpublish"],
      note:
        "If q3-live-delivery-after-unpublish returns 0 results / 404 while the " +
        "entry still exists under includeUnpublished, the draft path UNPUBLISHED " +
        "the live artifact — the destructive risk the gate guards against.",
    });
  } else {
    findings.push({
      question:
        "Q3: What does published:\"draft\" (no autoSaveOnly) do to a live entry?",
      status: "blocked",
      evidenceLabels: [],
      note:
        "Destructive probe skipped — re-run with --allow-unpublish-test to " +
        "exercise it against the throwaway entry only.",
    });
  }

  log(`\n[done] throwaway entries created this run:`);
  for (const e of registry.list()) log(`  - ${e.id} (${e.name})`);
  log(
    `[cleanup] These throwaway entries remain in the space. Delete them in the ` +
      `Builder UI (or via DELETE /api/v1/write/${model}/{id}) when finished.`,
  );

  return { findings };
}

function printPlan(flags: RunFlags, client: BuilderContractClient): void {
  log("Builder autoSaveOnly contract harness — PLAN (no --live, no network)\n");
  log(`  model:                 ${flags.model}`);
  log(`  write credentials:     ${client.hasWriteCredentials() ? "present" : "MISSING"}`);
  log(`  delivery credentials:  ${client.hasReadCredentials() ? "present" : "MISSING"}`);
  log(`  unpublish probe (Q3):  ${flags.allowUnpublishTest ? "enabled" : "disabled"}`);
  log("\nSteps that WOULD run with --live:");
  log("  0. POST create + publish throwaway entry (zz-autosave-contract-test-*)");
  log("  1. GET baseline live delivery + includeUnpublished");
  log("  2. PATCH ?autoSaveOnly=true&triggerWebhooks=false  (Q1/Q2/Q4)");
  log("  3. GET live delivery + includeUnpublished after autosave");
  log("  4. GET query by handle (Q5 duplicate/listing)");
  log("  5. [gated] PATCH published:draft + re-read (Q3 unpublish risk)");
  log("\nAdd --live to execute. Credentials must be in env (e.g. --env-file=.env.local).");
}

function writeEvidence(
  flags: RunFlags,
  exchanges: CapturedExchange[],
  findings: FindingRecord[],
): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(EVIDENCE_DIR, `run-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        flags,
        findings,
        exchanges,
      },
      null,
      2,
    ),
  );
  return file;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const config = resolveConfig();
  const client = new BuilderContractClient(config);

  if (!flags.live) {
    printPlan(flags, client);
    return;
  }

  if (!client.hasWriteCredentials()) {
    log(
      "BLOCKED: --live requested but no BUILDER_PRIVATE_KEY (or " +
        "BUILDER_CMS_PRIVATE_KEY) is set. Provide credentials via " +
        "--env-file=.env.local and re-run.",
    );
    process.exitCode = 2;
    return;
  }
  if (!client.hasReadCredentials()) {
    log(
      "WARNING: no BUILDER_API_KEY (public delivery key) — write probes will " +
        "run but delivery reads (the live-artifact evidence) will fail.",
    );
  }

  log(`Builder autoSaveOnly contract harness — LIVE run`);
  log(`  write host: ${config.writeHost}`);
  log(`  cdn host:   ${config.cdnHost}`);

  let findings: FindingRecord[] = [];
  try {
    ({ findings } = await runLive(client, flags));
  } catch (error) {
    log(
      `\n[abort] ${error instanceof Error ? error.message : String(error)}`,
    );
    findings = [
      {
        question: "ALL",
        status: "blocked",
        evidenceLabels: client.exchanges.map((e) => e.label),
        note: `Run aborted: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }

  // Print captured exchanges to stdout for live transcript visibility.
  for (const ex of client.exchanges) {
    log(
      `\n>>> ${ex.label}  ${ex.request.method} ${ex.request.url}` +
        `\n    -> HTTP ${ex.response.status} ${ex.response.statusText} — ${summarizeDelivery(ex)}`,
    );
  }

  const file = writeEvidence(flags, client.exchanges, findings);
  log(`\nEvidence written to ${file}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
