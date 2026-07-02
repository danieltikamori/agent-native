import { z } from "zod";

import {
  getScopedSettingRecord,
  putScopedSettingRecord,
  type SettingsScope,
} from "./scoped-settings";

const SETTINGS_KEY = "risk-model-config";

// Field-name mapping for the Risk Review dashboard. Defaults match Builder's
// Fusion Analytics HubSpot/Pylon schema exactly, so an org that never
// configures this gets identical behavior to the hardcoded original. Orgs
// with a different CRM/Pylon setup override individual fields without code
// changes — the CRM search, batched association joins, and pagination
// mechanics in hubspot.ts/pylon.ts/risk-meeting.ts stay generic.
export const riskModelConfigSchema = z.object({
  statusProperty: z.string().min(1).default("risk_status"),
  activeStatusValues: z
    .array(z.string().min(1))
    .min(1)
    .default([
      "On the Radar",
      "Churn Risk",
      "Confirmed Churn",
      "No Save Attempted",
    ]),
  statusLastUpdatedProperty: z
    .string()
    .min(1)
    .default("risk_status_last_updated"),
  summaryProperty: z.string().min(1).default("risk_summary"),
  categoryProperty: z.string().min(1).default("risk_category"),
  nextStepProperty: z.string().min(1).default("hs_next_step"),
  notesProperty: z.string().min(1).default("churn_notes"),
  arrProperty: z.string().min(1).default("total_contract_value"),
  ownerProperty: z.string().min(1).default("customer_success_owner"),
  companyRootOrgIdProperty: z.string().min(1).default("root_org_id"),
  companyDomainProperty: z.string().min(1).default("domain"),
  companySegmentProperty: z.string().min(1).default("account_profile"),
  companySegmentValue: z.string().min(1).default("Enterprise Active Customer"),
  pylonSentimentField: z.string().min(1).default("general_sentiment"),
  pylonRootOrgIdField: z.string().min(1).default("account.hubspot.root_org_id"),
  pylonDomainField: z.string().min(1).default("account.hubspot.domain"),
  pylonRiskSentiments: z
    .array(z.string().min(1))
    .min(1)
    .default(["frustrated", "high_risk_detractor"]),
});

export type RiskModelConfig = z.infer<typeof riskModelConfigSchema>;

export const DEFAULT_RISK_MODEL_CONFIG: RiskModelConfig =
  riskModelConfigSchema.parse({});

export async function loadRiskModelConfig(
  scope: SettingsScope,
): Promise<RiskModelConfig> {
  const saved = await getScopedSettingRecord(scope, SETTINGS_KEY);
  return riskModelConfigSchema.parse({
    ...DEFAULT_RISK_MODEL_CONFIG,
    ...(saved ?? {}),
  });
}

export async function saveRiskModelConfig(
  scope: SettingsScope,
  patch: Partial<RiskModelConfig>,
): Promise<RiskModelConfig> {
  const current = await loadRiskModelConfig(scope);
  const merged = riskModelConfigSchema.parse({ ...current, ...patch });
  await putScopedSettingRecord(scope, SETTINGS_KEY, merged);
  return merged;
}
