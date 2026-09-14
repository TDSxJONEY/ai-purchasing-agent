export const SCENARIO_KEYS = [
  "S1-A",
  "S1-B",
  "S1-C",
  "S1-D",
  "S1-E",
  "S2-A",
] as const;

export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export type ScenarioKind = "purchase" | "shortfall";

export interface ExpectedOutcome {
  decision: string;
  quantity: number;
  constraint: string;
  supplierId: string | null;
  note: string;
}

export interface ScenarioCatalogEntry {
  key: ScenarioKey;
  kind: ScenarioKind;
  recommendationId: string | null;
  triggerPoId: string | null;
  productId: string;
  nodeId: string;
  title: string;
  sku: string;
  nodeName: string;
  recommendedQty: number | null;
  expected: ExpectedOutcome;
}

/**
 * Static catalog matching prisma/seed.ts and docs/decision-spec.md §8.
 * IDs are explicit so the UI, API, CLI and fixtures all name the same rows.
 */
export const SCENARIOS: ScenarioCatalogEntry[] = [
  {
    key: "S1-A",
    kind: "purchase",
    recommendationId: "rec_s1a",
    triggerPoId: null,
    productId: "prod_earbuds",
    nodeId: "node_delncr",
    title: "Wireless Earbuds Pro",
    sku: "SKU-EARBUD-01",
    nodeName: "Delhi NCR Hub",
    recommendedQty: 800,
    expected: {
      decision: "MODIFY",
      quantity: 250,
      constraint: "STORAGE",
      supplierId: "sup_meridian",
      note: "Open PO of 100 is the detail a hurried buyer misses. Storage headroom 280, lot-capped to 250.",
    },
  },
  {
    key: "S1-B",
    kind: "purchase",
    recommendationId: "rec_s1b",
    triggerPoId: null,
    productId: "prod_cola",
    nodeId: "node_mumwst",
    title: "Cola 500ml (Pack of 24)",
    sku: "SKU-COLA-500",
    nodeName: "Mumbai West Hub",
    recommendedQty: 800,
    expected: {
      decision: "REJECT",
      quantity: 0,
      constraint: "DEMAND",
      supplierId: null,
      note: "Available 400 already covers demand of 330. No purchase required.",
    },
  },
  {
    key: "S1-C",
    kind: "purchase",
    recommendationId: "rec_s1c",
    triggerPoId: null,
    productId: "prod_oliveoil",
    nodeId: "node_blrsth",
    title: "Extra Virgin Olive Oil 1L",
    sku: "SKU-OLIVE-01",
    nodeName: "Bengaluru South Hub",
    recommendedQty: 500,
    expected: {
      decision: "REJECT",
      quantity: 0,
      constraint: "MOQ",
      supplierId: null,
      note: "Need 60, MOQ 500, storage only allows 100. Escalate rather than under-ordering.",
    },
  },
  {
    key: "S1-D",
    kind: "purchase",
    recommendationId: "rec_s1d",
    triggerPoId: null,
    productId: "prod_protein",
    nodeId: "node_hydcen",
    title: "Whey Protein 1kg",
    sku: "SKU-PROTEIN-01",
    nodeName: "Hyderabad Central Hub",
    recommendedQty: 300,
    expected: {
      decision: "INVESTIGATE",
      quantity: 0,
      constraint: "EVIDENCE",
      supplierId: null,
      note: "Forecast is 21 days old and actuals diverge 60% from run-rate.",
    },
  },
  {
    key: "S1-E",
    kind: "purchase",
    recommendationId: "rec_s1e",
    triggerPoId: null,
    productId: "prod_toothpaste",
    nodeId: "node_punest",
    title: "Toothpaste 150g",
    sku: "SKU-TOOTH-01",
    nodeName: "Pune East Hub",
    recommendedQty: 400,
    expected: {
      decision: "ACCEPT",
      quantity: 400,
      constraint: "DEMAND",
      supplierId: "sup_kavery",
      note: "Net requirement 400 matches the system recommendation.",
    },
  },
  {
    key: "S2-A",
    kind: "shortfall",
    recommendationId: null,
    triggerPoId: "po_s2a_partial",
    productId: "prod_battery",
    nodeId: "node_chnnth",
    title: "AA Batteries (Pack of 8)",
    sku: "SKU-BATTERY-01",
    nodeName: "Chennai North Hub",
    recommendedQty: null,
    expected: {
      decision: "CREATE_SUPPLEMENTARY_PO",
      quantity: 250,
      constraint: "LEAD_TIME",
      supplierId: "sup_kavery",
      note: "Skip Northpoint (MOQ 800 unreachable). Kavery can deliver 250 in 9 days.",
    },
  },
];

export const SCENARIO_MAP: Record<string, ScenarioCatalogEntry> = Object.fromEntries(
  SCENARIOS.map((s) => [s.key, s])
);

export function isScenarioKey(value: string): value is ScenarioKey {
  return SCENARIO_KEYS.includes(value as ScenarioKey);
}
