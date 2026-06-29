import { defineAction } from "@agent-native/core";
import { assertAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  finalizeImageRunWithinBudget,
  IMAGE_GENERATION_REFRESH_ATTEMPT_MS,
  markImageRunFailed,
} from "../server/lib/image-runs.js";
import { parseJson } from "../server/lib/json.js";
import { completeVideoGenerationRun } from "../server/lib/video-runs.js";
import { serializeAsset, serializeGenerationRun } from "./_helpers.js";
import { upsertVariantSlot } from "./variant-slots.js";

const STALE_IMAGE_RUN_MS = 2 * 60 * 1000;
const INTERRUPTED_IMAGE_RUN_ERROR =
  "Image generation was interrupted before a preview was created. Start a new generation to retry.";

function imageRunAgeMs(run: { createdAt?: string | null }): number {
  if (!run.createdAt) return 0;
  const createdAt = Date.parse(run.createdAt);
  return Number.isFinite(createdAt) ? Date.now() - createdAt : 0;
}

async function syncImageVariantSlot(
  run: typeof schema.assetGenerationRuns.$inferSelect,
  status: "ready" | "failed",
  options: {
    asset?: typeof schema.assets.$inferSelect;
    error?: string | null;
  } = {},
) {
  const metadata = parseJson<Record<string, unknown>>(run.metadata, {});
  const slotId =
    typeof metadata.slotId === "string" && metadata.slotId
      ? metadata.slotId
      : run.id;
  const batchId =
    typeof metadata.variantBatchId === "string" && metadata.variantBatchId
      ? metadata.variantBatchId
      : null;
  const threadId =
    typeof metadata.threadId === "string" && metadata.threadId
      ? metadata.threadId
      : null;
  const variantScopeId =
    typeof metadata.variantScopeId === "string" && metadata.variantScopeId
      ? metadata.variantScopeId
      : null;
  const serialized = options.asset ? serializeAsset(options.asset) : null;

  await upsertVariantSlot({
    runId: run.id,
    batchId,
    libraryId: run.libraryId,
    collectionId: run.collectionId ?? null,
    presetId: run.presetId ?? null,
    sessionId: run.sessionId ?? null,
    threadId,
    variantScopeId,
    prompt: run.prompt,
    slotId,
    status,
    assetId: serialized?.id,
    previewUrl: serialized?.previewUrl,
    thumbnailUrl: serialized?.thumbnailUrl,
    error: options.error ?? undefined,
  });
}

async function refreshImageRun(
  run: typeof schema.assetGenerationRuns.$inferSelect,
) {
  const db = getDb();
  const metadata = parseJson<Record<string, unknown>>(run.metadata, {});
  const assets = await db
    .select()
    .from(schema.assets)
    .where(eq(schema.assets.generationRunId, run.id));

  const outputAsset = assets[0] ?? null;
  if (outputAsset) {
    const completed = await finalizeImageRunWithinBudget(
      run,
      IMAGE_GENERATION_REFRESH_ATTEMPT_MS,
    );
    return {
      run: completed.run,
      assets: completed.status === "completed" ? [completed.asset] : assets,
    };
  }

  if (run.status === "failed") {
    await syncImageVariantSlot(run, "failed", {
      error: run.error ?? "Image generation failed.",
    });
    return { run, assets: [] };
  }

  const asyncSubmitted =
    metadata.providerStatus === "processing" ||
    typeof metadata.startedAt === "string";
  if (run.status === "pending" || run.status === "processing") {
    if (asyncSubmitted) {
      try {
        const completed = await finalizeImageRunWithinBudget(
          { ...run, status: "processing" },
          IMAGE_GENERATION_REFRESH_ATTEMPT_MS,
        );
        return {
          run: completed.run,
          assets: completed.status === "completed" ? [completed.asset] : [],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Image generation failed.";
        const failedRun = await markImageRunFailed({ run, message });
        return { run: failedRun, assets: [] };
      }
    }

    if (imageRunAgeMs(run) >= STALE_IMAGE_RUN_MS) {
      const failedRun = await markImageRunFailed({
        run,
        message: INTERRUPTED_IMAGE_RUN_ERROR,
      });
      return { run: failedRun, assets: [] };
    }
  }

  return { run, assets: [] };
}

export default defineAction({
  description:
    "Refresh a generation run by runId until it completes and creates assets. The Assets live variant tray already polls image runs automatically, so normal in-app chat agents should not call this after generate-image or generate-image-batch unless the user asks, there is no visible tray, or the caller is headless. Continue using this for async video runs.",
  schema: z.object({
    runId: z.string(),
  }),
  run: async ({ runId }) => {
    const db = getDb();
    const [run] = await db
      .select()
      .from(schema.assetGenerationRuns)
      .where(eq(schema.assetGenerationRuns.id, runId))
      .limit(1);
    if (!run && runId.startsWith("pending-")) {
      return {
        run: {
          id: runId,
          status: "pending",
          mediaType: "image",
          metadata: { placeholder: true },
        },
        assets: [],
      };
    }
    if (!run) throw new Error("Generation run not found.");
    await assertAccess("asset-library", run.libraryId, "editor");
    if ((run.mediaType ?? "image") !== "video") {
      const refreshed = await refreshImageRun(run);
      return {
        run: serializeGenerationRun(refreshed.run),
        assets: refreshed.assets.map(serializeAsset),
      };
    }
    if (run.status === "completed" || run.status === "failed") {
      const assets = await db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.generationRunId, runId));
      return {
        run: serializeGenerationRun(run),
        assets: assets.map(serializeAsset),
      };
    }
    const refreshed = await completeVideoGenerationRun(run);
    return {
      run: serializeGenerationRun(refreshed.run),
      assets:
        refreshed.status === "completed"
          ? [serializeAsset(refreshed.asset)]
          : [],
    };
  },
});
