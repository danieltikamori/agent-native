import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { loadRiskModelConfig } from "../server/lib/risk-model-config";
import { resolveRequestScope } from "../server/lib/scoped-settings";

export default defineAction({
  description:
    "Get the org's risk-model field mapping used by the Risk Review dashboard: which HubSpot deal/company properties and values define an at-risk deal, an enterprise account, and which Pylon fields join back to HubSpot. Falls back to Builder's Fusion Analytics defaults when unset.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => loadRiskModelConfig(resolveRequestScope()),
});
