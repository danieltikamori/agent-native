import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assertAccessMock = vi.hoisted(() => vi.fn());
const getDbMock = vi.hoisted(() => vi.fn());
const completeVideoGenerationRunMock = vi.hoisted(() => vi.fn());
const finalizeImageRunWithinBudgetMock = vi.hoisted(() => vi.fn());
const markImageRunFailedMock = vi.hoisted(() => vi.fn());
const upsertVariantSlotMock = vi.hoisted(() => vi.fn());
const updateSetCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

const schemaMock = vi.hoisted(() => ({
  assetGenerationRuns: {
    id: "assetGenerationRuns.id",
    libraryId: "assetGenerationRuns.libraryId",
  },
  assets: {
    generationRunId: "assets.generationRunId",
  },
}));

vi.mock("@agent-native/core", () => ({
  defineAction: (entry: unknown) => entry,
}));

vi.mock("@agent-native/core/sharing", () => ({
  assertAccess: assertAccessMock,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column, value) => ({ op: "eq", column, value })),
}));

vi.mock("../server/db/index.js", () => ({
  getDb: getDbMock,
  schema: schemaMock,
}));

vi.mock("../server/lib/image-runs.js", () => ({
  finalizeImageRunWithinBudget: finalizeImageRunWithinBudgetMock,
  IMAGE_GENERATION_REFRESH_ATTEMPT_MS: 25,
  markImageRunFailed: markImageRunFailedMock,
}));

vi.mock("../server/lib/video-runs.js", () => ({
  completeVideoGenerationRun: completeVideoGenerationRunMock,
}));

vi.mock("../server/lib/json.js", () => ({
  nowIso: vi.fn(() => "2026-05-28T12:00:00.000Z"),
  parseJson: vi.fn((value: string | null | undefined, fallback: unknown) => {
    if (!value) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }),
}));

vi.mock("./variant-slots.js", () => ({
  upsertVariantSlot: upsertVariantSlotMock,
}));

vi.mock("./_helpers.js", () => ({
  serializeAsset: vi.fn((asset) => ({
    id: asset.id,
    previewUrl: `/api/assets/${asset.id}/content`,
    thumbnailUrl: `/api/assets/${asset.id}/content?variant=thumb`,
  })),
  serializeGenerationRun: vi.fn((run) => run),
}));

import action from "./refresh-generation-run.js";

function createDb({
  run,
  assets,
}: {
  run: Record<string, unknown>;
  assets: Array<Record<string, unknown>>;
}) {
  const rowsForTable = (table: unknown) =>
    table === schemaMock.assetGenerationRuns ? [run] : assets;
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const rows = rowsForTable(table);
          const promise = Promise.resolve(rows) as Promise<
            Array<Record<string, unknown>>
          > & {
            limit: (count: number) => Promise<Array<Record<string, unknown>>>;
          };
          promise.limit = vi.fn(async (count: number) => rows.slice(0, count));
          return promise;
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updateSetCalls.push(values);
        }),
      })),
    })),
  };
}

describe("refresh-generation-run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateSetCalls.length = 0;
    assertAccessMock.mockResolvedValue(undefined);
    upsertVariantSlotMock.mockResolvedValue(undefined);
    finalizeImageRunWithinBudgetMock.mockImplementation(async (run) => ({
      status: "processing",
      run,
    }));
    markImageRunFailedMock.mockImplementation(async ({ run, message }) => ({
      ...run,
      status: "failed",
      error: message,
      completedAt: "2026-05-28T12:00:00.000Z",
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a stale pending image run failed and syncs the live slot", async () => {
    getDbMock.mockReturnValue(
      createDb({
        run: {
          id: "run-1",
          libraryId: "library-1",
          collectionId: null,
          presetId: null,
          sessionId: null,
          prompt: "Recreate this diagram",
          mediaType: "image",
          status: "pending",
          error: null,
          metadata: JSON.stringify({
            slotId: "agent-workflow-final",
            variantBatchId: "batch-1",
            threadId: "thread-1",
            variantScopeId: "thread-1",
          }),
          createdAt: "2026-05-28T11:57:00.000Z",
        },
        assets: [],
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));

    const result = await action.run({ runId: "run-1" });

    expect(result.run.status).toBe("failed");
    expect(markImageRunFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ id: "run-1" }),
        message: expect.stringContaining("interrupted"),
      }),
    );
    expect(finalizeImageRunWithinBudgetMock).not.toHaveBeenCalled();
    expect(completeVideoGenerationRunMock).not.toHaveBeenCalled();
  });

  it("restores a completed image asset into its live slot", async () => {
    getDbMock.mockReturnValue(
      createDb({
        run: {
          id: "run-2",
          libraryId: "library-1",
          collectionId: null,
          presetId: null,
          sessionId: null,
          prompt: "Hero image",
          mediaType: "image",
          status: "pending",
          error: null,
          metadata: JSON.stringify({ slotId: "hero-slot" }),
          createdAt: "2026-05-28T11:59:30.000Z",
        },
        assets: [{ id: "asset-1" }],
      }),
    );

    finalizeImageRunWithinBudgetMock.mockResolvedValueOnce({
      status: "completed",
      run: { id: "run-2", status: "completed" },
      asset: { id: "asset-1" },
    });

    const result = await action.run({ runId: "run-2" });

    expect(result.assets).toEqual([expect.objectContaining({ id: "asset-1" })]);
    expect(finalizeImageRunWithinBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-2",
      }),
      25,
    );
  });

  it("polls an async image run once and leaves it processing when not ready", async () => {
    getDbMock.mockReturnValue(
      createDb({
        run: {
          id: "run-3",
          libraryId: "library-1",
          collectionId: null,
          presetId: null,
          sessionId: null,
          prompt: "Slow image",
          mediaType: "image",
          status: "processing",
          error: null,
          metadata: JSON.stringify({
            slotId: "slow-slot",
            providerStatus: "processing",
            startedAt: "2026-05-28T11:59:45.000Z",
          }),
          createdAt: "2026-05-28T11:59:45.000Z",
        },
        assets: [],
      }),
    );
    finalizeImageRunWithinBudgetMock.mockImplementation(async (run) => ({
      status: "processing",
      run,
    }));

    const result = await action.run({ runId: "run-3" });

    expect(result.run.status).toBe("processing");
    expect(result.assets).toEqual([]);
    expect(finalizeImageRunWithinBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-3", status: "processing" }),
      25,
    );
    expect(markImageRunFailedMock).not.toHaveBeenCalled();
  });
});
