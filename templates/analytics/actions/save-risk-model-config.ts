import { defineAction } from "@agent-native/core";

import {
  riskModelConfigSchema,
  saveRiskModelConfig,
} from "../server/lib/risk-model-config";
import { resolveRequestScope } from "../server/lib/scoped-settings";

export default defineAction({
  description:
    "Update the org's risk-model field mapping for the Risk Review dashboard — which HubSpot deal/company properties and values define risk status, ARR, owner, enterprise segment, and Pylon sentiment join keys. Only provided fields are changed; omitted fields keep their current value. Use get-risk-model-config first to see current values before changing them.",
  schema: riskModelConfigSchema.partial(),
  http: { method: "POST" },
  run: async (args) => saveRiskModelConfig(resolveRequestScope(), args),
});
