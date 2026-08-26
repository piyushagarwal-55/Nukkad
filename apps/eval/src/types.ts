export interface GoldenExpected {
  skuName: string;
  quantity: number;
}

export interface GoldenCase {
  id: string;
  householdPhone: string;
  /** path to a REAL voice note. Synthetic audio does not count. */
  audio: string | null;
  /** used when the case is a typed order rather than a voice note */
  text: string | null;
  expected: GoldenExpected[];
}

export interface StageResult {
  stage: string;
  cases: number;
  lines: number;
  top1: number;
  top3: number;
  quantityExact: number;
  unresolved: number;
  /** only meaningful for the confirmation stage */
  sentToBuyer: number;
  avgLatencyMs: number;
}
