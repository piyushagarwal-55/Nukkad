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
  /**
   * WIDER THAN IT LOOKS, and each one exists because the alternative was a
   * numbered menu.
   *
   * "Pichhla order dobara bhejo" used to be option 1 on a four-item list a
   * shop assistant would never read out loud. A person just says it, so
   * REPEAT and ACCOUNT are recognised from language instead. GREETING and
   * QUESTION exist so that "kya haal hai" and "dukaan kab tak khuli hai"
   * get an answer rather than the same menu a third time.
   */
  intent: z.enum([
    'ORDER',
    /** wants the last order again */
    'REPEAT',
    /** asking about their own spend or history */
    'ACCOUNT',
    'CANCEL',
    'MODIFY',
    'CONFIRM',
    /** namaste, kya haal hai, thanks */
    'GREETING',
    /** asking the shop something: timings, availability, price */
    'QUESTION',
    'UNKNOWN',
  ]),
});

export type Extraction = z.infer<typeof extractionSchema>;
