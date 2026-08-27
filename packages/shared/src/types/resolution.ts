import type { Sku } from './domain.js';

/**
 * How a line item got matched. Recorded PER LINE in the database so the
 * ablation table is derivable from production data, not hand-assembled
 * the night before the demo.
 */
export type ResolutionMethod =
  | 'EXACT'          // string equality on name or alias
  | 'FUZZY'          // token ratio over the catalogue
  | 'PRIOR'          // reorder history broke the tie
  | 'EMBEDDING'      // vector similarity, only if enabled
  | 'LLM'            // model picked from a shortlist
  | 'DISAMBIGUATED'  // buyer tapped one of top-k
  | 'SUBSTITUTED'    // original was out of stock
  | 'UNRESOLVED';

export interface Candidate {
  sku: Sku;
  score: number;
  /**
   * The purely LEXICAL part of the score, before the household prior is
   * added in. Kept separate because the two answer different questions:
   * `score` decides which candidate wins, `fuzzy` decides whether a
   * candidate has any business being on the list at all. See the note on
   * alternates in resolver/rank.ts.
   */
  fuzzy: number;
  method: ResolutionMethod;
}

export interface ResolvedLine {
  /** verbatim span from the transcript, kept for the eval harness */
  sourceText: string;
  quantity: number;
  unitHint: string | null;
  chosen: Candidate | null;
  /** top-k alternates, surfaced as disambiguation taps when confidence is low */
  alternates: Candidate[];
  confidence: number;
  needsDisambiguation: boolean;
}

export interface ResolutionResult {
  lines: ResolvedLine[];
  transcript: string | null;
  /** which ASR produced the transcript, so eval rows stay attributable */
  asrEngine: string | null;
  latencyMs: number;
}
