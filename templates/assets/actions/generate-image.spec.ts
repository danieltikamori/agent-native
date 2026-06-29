import { beforeEach, describe, expect, it, vi } from "vitest";

const assertAccessMock = vi.hoisted(() => vi.fn());
const getDbMock = vi.hoisted(() => vi.fn());
const readImageModelDefaultMock = vi.hoisted(() => vi.fn());
const finalizeImageRunWithinBudgetMock = vi.hoisted(() => vi.fn());
const upsertVariantSlotMock = vi.hoisted(() => vi.fn());
const wasVariantSlotDismissedMock = vi.hoisted(() => vi.fn());
const insertCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const updateCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

const schemaMock = vi.hoisted(() => ({
  assetLibraries: { id: "libraries.id" },
  assetGenerationSessions: { id: "sessions.id" },
  assetGenerationPresets: { id: "presets.id" },
  assetCollections: { id: "collections.id" },
  assets: { id: "assets.id" },
  assetGenerationRuns: { id: "runs.id" },
}));

vi.mock("@agent-native/core", () => ({
  defineAction: (entry: unknown) => entry,
}));

vi.mock("@agent-native/core/action", () => ({}));

vi.mock("@agent-native/core/application-state", () => ({
  writeAppState: vi.fn(),
  deleteAppState: vi.fn(async () => undefined),
}));

vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: vi.fn(() => "designer@example.test"),
  getRequestOrgId: vi.fn(() => "org-1"),
}));

vi.mock("@agent-native/core/sharing", () => ({
  assertAccess: assertAccessMock,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((column, value) => ({ column, value })),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "run-1"),
}));

vi.mock("../server/db/index.js", () => ({
  getDb: getDbMock,
  schema: schemaMock,
}));

vi.mock("../server/lib/generation-presets.js", () => ({
  applyPromptTemplate: vi.fn((_template, prompt: string) => prompt),
}));

vi.mock("../server/lib/generation.js", () => ({
  compilePrompt: vi.fn(() => "Compiled prompt"),
  DEFAULT_GENERATION_REFERENCE_LIMIT: 6,
  isImageGenerationSetupError: vi.fn(() => false),
  selectReferences: vi.fn(async () => []),
}));

vi.mock("../server/lib/image-runs.js", () => ({
  finalizeImageRunWithinBudget: finalizeImageRunWithinBudgetMock,
  IMAGE_GENERATION_INLINE_FAST_PATH_MS: 25,
  markImageRunFailed: vi.fn(),
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
  stringifyJson: vi.fn((value: unknown) => JSON.stringify(value)),
}));

vi.mock("./_helpers.js", () => ({
  requireGenerationSessionInLibrary: vi.fn(),
  serializeAsset: vi.fn((asset) => ({
    id: asset.id,
    assetId: asset.id,
    url: `/asset/${asset.id}`,
    previewUrl: `/api/assets/${asset.id}/content`,
    thumbnailUrl: `/api/assets/${asset.id}/content?variant=thumb`,
  })),
  serializeGenerationRun: vi.fn((run) => run),
}));

vi.mock("./_image-model-default.js", () => ({
  readImageModelDefault: readImageModelDefaultMock,
}));

vi.mock("./variant-slots.js", () => ({
  upsertVariantSlot: upsertVariantSlotMock,
  wasVariantSlotDismissed: wasVariantSlotDismissedMock,
}));

import action from "./generate-image.js";

function createDb() {
  const rowsFor = (table: unknown) => {
    if (table === schemaMock.assetLibraries) {
      return [
        {
          id: "library-1",
          title: "Northstar",
          styleBrief: "{}",
          customInstructions: "",
          canonicalLogoAssetId: null,
        },
      ];
    }
    return [];
  };
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const rows = rowsFor(table);
          const promise = Promise.resolve(rows) as Promise<any[]> & {
            limit: (count: number) => Promise<any[]>;
          };
          promise.limit = vi.fn(async (count: number) => rows.slice(0, count));
          return promise;
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        insertCalls.push(row);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updateCalls.push(values);
        }),
      })),
    })),
  };
}

describe("generate-image", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertCalls.length = 0;
    updateCalls.length = 0;
    assertAccessMock.mockResolvedValue(undefined);
    readImageModelDefaultMock.mockResolvedValue(undefined);
    upsertVariantSlotMock.mockResolvedValue(undefined);
    wasVariantSlotDismissedMock.mockResolvedValue(false);
    getDbMock.mockReturnValue(createDb());
  });

  it("preserves the fast path by returning a ready asset inline", async () => {
    finalizeImageRunWithinBudgetMock.mockImplementation(async (run) => ({
      status: "completed",
      run: { ...run, status: "completed" },
      asset: {
        id: "asset-1",
        libraryId: "library-1",
        thumbnailObjectKey: "thumb.webp",
      },
    }));

    const result = await action.run({
      libraryId: "library-1",
      prompt: "Create a hero image",
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: "asset-1",
        assetId: "asset-1",
        runId: "run-1",
        status: "ready",
        artifactType: "image",
      }),
    );
    expect(finalizeImageRunWithinBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", status: "processing" }),
      25,
    );
  });

  it("returns processing without failing the run when the inline budget elapses", async () => {
    finalizeImageRunWithinBudgetMock.mockImplementation(async (run) => ({
      status: "processing",
      run,
    }));

    const result = await action.run({
      libraryId: "library-1",
      prompt: "Create a large campaign image",
    });

    expect(result).toEqual(
      expect.objectContaining({
        runId: "run-1",
        status: "processing",
        artifactType: "image",
      }),
    );
    expect(updateCalls).toContainEqual(
      expect.objectContaining({ status: "processing" }),
    );
    expect(updateCalls).not.toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(insertCalls).toContainEqual(
      expect.objectContaining({
        id: "run-1",
        status: "pending",
        mediaType: "image",
      }),
    );
  });
});
