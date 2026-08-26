import { z } from 'zod';

/**
 * Schema the LLM is forced to emit when extracting an order from a
 * transcript.
 *
 * Kept deliberately dumb: the model SEGMENTS the utterance and pulls
 * quantities. It does NOT pick the SKU. SKU choice belongs to the ranker,
 * which is constrained to this shop's catalogue and conditioned on the
 * household's own reorder history. See PRD, 'Stop transcribing, start
 * ranking'. Letting the model name products is exactly the failure mode
 * that caps open-menu voice ordering at ~86 percent.
 */
export const extractionSchema = z.object({
  items: z.array(z.object({
    text: z.string().describe('verbatim span naming the product'),
    quantity: z.number().positive().default(1),
    unit: z.string().nullable().default(null),
  })),
  intent: z.enum(['ORDER', 'CANCEL', 'MODIFY', 'QUESTION', 'CONFIRM', 'UNKNOWN']),
});

export type Extraction = z.infer<typeof extractionSchema>;
