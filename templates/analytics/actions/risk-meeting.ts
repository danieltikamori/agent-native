import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { getRiskMeetingData } from "../server/lib/risk-meeting";
import { loadRiskModelConfig } from "../server/lib/risk-model-config";
import { resolveRequestScope } from "../server/lib/scoped-settings";

export default defineAction({
  readOnly: true,
  description:
    "Load HubSpot at-risk renewal deals and Pylon early-warning accounts for the weekly risk meeting review. Which HubSpot/Pylon properties and values define risk is configurable per org via get-risk-model-config/save-risk-model-config.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const config = await loadRiskModelConfig(resolveRequestScope());
    return getRiskMeetingData(config);
  },
});
