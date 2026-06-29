import { defineAction } from "@agent-native/core";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  requireLibrary,
  serializeAsset,
  serializeGenerationRun,
} from "./_helpers.js";

export default defineAction({
  description:
    "Get a generation run and all assets produced by that run for history/debugging. For slow image runs in the Assets UI, the live variant tray handles polling; use refresh-generation-run only when explicitly advancing completion for headless/no-tray workflows or async video runs.",
  schema: z.object({ runId: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ runId }) => {
    const db = getDb();
    const [run] = await db
      .select()
      .from(schema.assetGenerationRuns)
      .where(eq(schema.assetGenerationRuns.id, runId))
      .limit(1);
    if (!run) throw new Error("Generation run not found.");
    await requireLibrary(run.libraryId);
    const assets = await db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.generationRunId, runId));
    return {
      run: serializeGenerationRun(run),
      assets: assets.map(serializeAsset),
    };
  },
});
