import {
  batchGetAssociations,
  getAllDeals,
  getDealOwners,
  getDealPipelines,
  getVisiblePipelines,
  readHubSpotObjects,
  searchHubSpotDealsByRiskStatuses,
  type Deal,
  type Pipeline,
} from "./hubspot";
import {
  getPylonSentimentMap,
  isRiskSentiment,
  type PylonSentimentMap,
} from "./pylon";
import {
  DEFAULT_RISK_MODEL_CONFIG,
  type RiskModelConfig,
} from "./risk-model-config";

export interface RiskDeal {
  id: string;
  dealname: string;
  riskStatus: string;
  riskSummary: string | null;
  riskCategory: string | null;
  nextStep: string | null;
  churnNotes: string | null;
  daysInCurrentRiskStatus: number;
  riskStatusLastUpdated: string | null;
  csmName: string | null;
  dealStageLabel: string | null;
  arr: number | null;
  closedate: string | null;
  pipeline: string | null;
  pylonSentiment: string | null;
  pylonAccountId: string | null;
}

export interface PylonEarlyWarningAccount {
  pylonAccountId: string;
  accountName: string;
  pylonSentiment: string;
  csmName: string | null;
  totalArr: number | null;
  earliestClosedate: string | null;
  dealCount: number;
}

export interface RiskMeetingData {
  deals: RiskDeal[];
  pylonOnlyDeals: PylonEarlyWarningAccount[];
  total: number;
}

interface CompanyInfo {
  rootOrgId: string | null;
  domain: string | null;
  accountProfile: string | null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toNumber(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function daysSince(ms: number): number {
  return Math.max(0, Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000)));
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isPastCloseDate(closedate: string | null | undefined): boolean {
  if (!closedate) return false;
  const ms = Date.parse(closedate);
  return Number.isFinite(ms) && ms < Date.now();
}

function stageLookups(pipelines: Pipeline[]) {
  const stageLabels: Record<string, string> = {};
  const pipelineLabels: Record<string, string> = {};
  for (const pipeline of pipelines) {
    pipelineLabels[pipeline.id] = pipeline.label;
    for (const stage of pipeline.stages) {
      stageLabels[stage.id] = stage.label || stage.id;
    }
  }
  return { stageLabels, pipelineLabels };
}

function riskDealProperties(config: RiskModelConfig): string[] {
  return [
    config.statusProperty,
    config.summaryProperty,
    config.categoryProperty,
    config.statusLastUpdatedProperty,
    config.nextStepProperty,
    config.notesProperty,
    config.arrProperty,
    config.ownerProperty,
    "dealname",
    "dealstage",
    "closedate",
    "pipeline",
    "hubspot_owner_id",
  ];
}

// Joins deals to their primary company's root-org-id / domain / segment
// property with batched association reads so a cohort of N deals costs
// O(N/100) HTTP calls instead of N — required to stay inside the 30s
// extension iframe budget. Property names are configurable via
// risk-model-config (defaults match fusion-analytics's getDealCompanyMaps()
// exactly): the company's root-org-id property is the primary Pylon join
// key (also synced into Pylon as a custom field), domain is the fallback,
// and the segment property/value marks the Pylon-eligible enterprise
// segment (e.g. "Enterprise Active Customer").
async function buildDealCompanyMap(
  dealIds: string[],
  config: RiskModelConfig,
): Promise<Map<string, CompanyInfo>> {
  const result = new Map<string, CompanyInfo>();
  if (!dealIds.length) return result;

  const dealToCompanies = await batchGetAssociations({
    fromObjectType: "deals",
    toObjectType: "companies",
    fromObjectIds: dealIds,
  });

  const companyIds = Array.from(
    new Set(Array.from(dealToCompanies.values()).flat()),
  );
  if (!companyIds.length) return result;

  const companies = await readHubSpotObjects({
    objectType: "companies",
    ids: companyIds,
    properties: [
      config.companyRootOrgIdProperty,
      config.companyDomainProperty,
      config.companySegmentProperty,
    ],
  });
  const companyById = new Map<string, CompanyInfo>();
  for (const company of companies) {
    companyById.set(company.id, {
      rootOrgId: strOrNull(company.properties[config.companyRootOrgIdProperty]),
      domain:
        strOrNull(
          company.properties[config.companyDomainProperty],
        )?.toLowerCase() ?? null,
      accountProfile: strOrNull(
        company.properties[config.companySegmentProperty],
      ),
    });
  }

  for (const [dealId, associatedCompanyIds] of dealToCompanies) {
    const primaryCompanyId = associatedCompanyIds[0];
    const info = primaryCompanyId
      ? companyById.get(primaryCompanyId)
      : undefined;
    if (info) result.set(dealId, info);
  }

  return result;
}

function lookupPylon(
  company: CompanyInfo | undefined,
  pylonSentimentMap: PylonSentimentMap,
) {
  if (!company) return undefined;
  return (
    (company.rootOrgId && pylonSentimentMap.get(company.rootOrgId)) ||
    (company.domain && pylonSentimentMap.get(company.domain)) ||
    undefined
  );
}

function isEnterpriseSegment(
  info: CompanyInfo | undefined,
  config: RiskModelConfig,
): boolean {
  return info?.accountProfile === config.companySegmentValue;
}

export async function getRiskDeals(
  pylonSentimentMap: PylonSentimentMap,
  config: RiskModelConfig = DEFAULT_RISK_MODEL_CONFIG,
): Promise<RiskDeal[]> {
  const allDeals: Deal[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { deals, nextAfter } = await searchHubSpotDealsByRiskStatuses({
      riskStatuses: config.activeStatusValues,
      statusProperty: config.statusProperty,
      limit: 100,
      after,
      extraProperties: riskDealProperties(config),
    });
    allDeals.push(...deals);
    if (!nextAfter) break;
    after = nextAfter;
  }

  const activeStatuses = new Set(config.activeStatusValues);
  const candidateDeals = allDeals.filter((deal) => {
    const status = String(deal.properties[config.statusProperty] ?? "").trim();
    if (!activeStatuses.has(status)) return false;
    return !isPastCloseDate(deal.properties.closedate);
  });

  const [allPipelines, owners, companyByDeal] = await Promise.all([
    getDealPipelines(),
    getDealOwners(),
    buildDealCompanyMap(
      candidateDeals.map((deal) => deal.id),
      config,
    ),
  ]);
  const lookups = stageLookups(getVisiblePipelines(allPipelines));

  const riskDeals: RiskDeal[] = candidateDeals.map((deal) => {
    const props = deal.properties;
    const stageId = String(props.dealstage ?? "");
    const pipelineId = String(props.pipeline ?? "");
    const lastUpdatedMs = Number(props[config.statusLastUpdatedProperty] ?? "");
    const hasLastUpdated = Number.isFinite(lastUpdatedMs) && lastUpdatedMs > 0;
    const ownerId = String(
      props[config.ownerProperty] ?? props.hubspot_owner_id ?? "",
    );
    const pylonEntry = lookupPylon(
      companyByDeal.get(deal.id),
      pylonSentimentMap,
    );

    return {
      id: deal.id,
      dealname: props.dealname ?? "",
      riskStatus: String(props[config.statusProperty] ?? ""),
      riskSummary: props[config.summaryProperty] ?? null,
      riskCategory: props[config.categoryProperty] ?? null,
      nextStep: props[config.nextStepProperty] ?? null,
      churnNotes: props[config.notesProperty] ?? null,
      daysInCurrentRiskStatus: hasLastUpdated ? daysSince(lastUpdatedMs) : 0,
      riskStatusLastUpdated: hasLastUpdated ? toIsoDate(lastUpdatedMs) : null,
      csmName: ownerId ? (owners[ownerId] ?? null) : null,
      dealStageLabel: lookups.stageLabels[stageId] ?? (stageId || null),
      arr: toNumber(props[config.arrProperty]),
      closedate: props.closedate ?? null,
      pipeline: pipelineId
        ? (lookups.pipelineLabels[pipelineId] ?? pipelineId)
        : null,
      pylonSentiment: pylonEntry?.sentiment ?? null,
      pylonAccountId: pylonEntry?.pylonAccountId ?? null,
    };
  });

  riskDeals.sort(
    (a, b) => b.daysInCurrentRiskStatus - a.daysInCurrentRiskStatus,
  );

  return riskDeals;
}

// Determines which Pylon accounts already have an active-risk HubSpot deal,
// using ALL deals regardless of close date (a past-dated flagged deal still
// means a CSM has engaged this account in HubSpot). Mirrors
// fusion-analytics's getPylonOnlyRiskDeals exactly rather than reusing the
// future-dated cohort from getRiskDeals.
export async function getPylonOnlyRiskDeals(
  pylonSentimentMap: PylonSentimentMap,
  config: RiskModelConfig = DEFAULT_RISK_MODEL_CONFIG,
): Promise<PylonEarlyWarningAccount[]> {
  const hasRiskAccounts = Array.from(pylonSentimentMap.values()).some((entry) =>
    isRiskSentiment(entry.sentiment, config.pylonRiskSentiments),
  );
  if (!hasRiskAccounts) return [];

  const [allDeals, owners] = await Promise.all([
    getAllDeals([config.ownerProperty, config.arrProperty]),
    getDealOwners(),
  ]);

  const companyByDeal = await buildDealCompanyMap(
    allDeals.map((deal) => deal.id),
    config,
  );

  const activeStatuses = new Set(config.activeStatusValues);
  const flaggedPylonAccountIds = new Set<string>();
  for (const deal of allDeals) {
    const status = String(deal.properties[config.statusProperty] ?? "").trim();
    if (!activeStatuses.has(status)) continue;
    const entry = lookupPylon(companyByDeal.get(deal.id), pylonSentimentMap);
    if (entry) flaggedPylonAccountIds.add(entry.pylonAccountId);
  }

  interface Accumulator extends PylonEarlyWarningAccount {
    earliestCloseMs: number;
  }

  const byAccountId = new Map<string, Accumulator>();

  for (const deal of allDeals) {
    const company = companyByDeal.get(deal.id);
    if (!isEnterpriseSegment(company, config)) continue;

    const entry = lookupPylon(company, pylonSentimentMap);
    if (
      !entry ||
      !isRiskSentiment(entry.sentiment, config.pylonRiskSentiments)
    ) {
      continue;
    }
    if (flaggedPylonAccountIds.has(entry.pylonAccountId)) continue;

    const props = deal.properties;
    const ownerId = String(
      props[config.ownerProperty] ?? props.hubspot_owner_id ?? "",
    );
    const arr = toNumber(props[config.arrProperty]) ?? 0;
    const closedate = props.closedate ?? null;
    const closeMs = closedate ? Date.parse(closedate) : NaN;

    const existing = byAccountId.get(entry.pylonAccountId);
    if (!existing) {
      byAccountId.set(entry.pylonAccountId, {
        pylonAccountId: entry.pylonAccountId,
        accountName: entry.accountName,
        pylonSentiment: entry.sentiment,
        csmName: ownerId ? (owners[ownerId] ?? null) : null,
        totalArr: arr,
        earliestClosedate: closedate,
        dealCount: 1,
        earliestCloseMs: Number.isFinite(closeMs) ? closeMs : Infinity,
      });
      continue;
    }

    existing.totalArr = (existing.totalArr ?? 0) + arr;
    existing.dealCount += 1;
    if (!existing.csmName && ownerId) {
      existing.csmName = owners[ownerId] ?? null;
    }
    if (Number.isFinite(closeMs) && closeMs < existing.earliestCloseMs) {
      existing.earliestCloseMs = closeMs;
      existing.earliestClosedate = closedate;
    }
  }

  const results = Array.from(byAccountId.values());
  results.sort((a, b) => a.earliestCloseMs - b.earliestCloseMs);
  return results.map(({ earliestCloseMs: _earliestCloseMs, ...rest }) => rest);
}

export async function getRiskMeetingData(
  config: RiskModelConfig = DEFAULT_RISK_MODEL_CONFIG,
): Promise<RiskMeetingData> {
  const pylonSentimentMap = await getPylonSentimentMap({
    sentimentField: config.pylonSentimentField,
    rootOrgIdField: config.pylonRootOrgIdField,
    domainField: config.pylonDomainField,
  });
  const [deals, pylonOnlyDeals] = await Promise.all([
    getRiskDeals(pylonSentimentMap, config),
    getPylonOnlyRiskDeals(pylonSentimentMap, config),
  ]);

  return {
    deals,
    pylonOnlyDeals,
    total: deals.length,
  };
}
