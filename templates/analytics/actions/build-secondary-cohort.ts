import { defineAction } from "@agent-native/core";

import {
  buildSecondaryCohort,
  secondaryCohortConfigSchema,
} from "../server/lib/secondary-cohort";

export default defineAction({
  readOnly: true,
  timeoutMs: 360_000,
  description:
    "Build a secondary-provider cohort by joining caller-supplied provider account fields to CRM deals via company join keys. All property names, segment filters, sentiment values, and rollup fields come from the request body. Excludes accounts already matched on a primary CRM deal property.",
  schema: secondaryCohortConfigSchema,
  http: { method: "POST" },
  run: async (args) => {
    const accounts = await buildSecondaryCohort(args);
    return {
      accounts,
      total: accounts.length,
      guidance:
        "Joined secondary-provider accounts to CRM deals via company join keys, filtered by companySegmentProperty/companySegmentValue, excluding accounts already matched on dealProperty/dealPropertyValues.",
    };
  },
});
