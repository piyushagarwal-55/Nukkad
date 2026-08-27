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
    /**
     * Done adding: "bas", "itna hi", "ho gaya", "that's all". Distinct
     * from CONFIRM, which answers a question the shop asked. This one is
     * the customer closing the basket unprompted.
     */
    'CHECKOUT',
    /**
     * Rejecting something the SHOP proposed -- a substitute they do not
     * want, a product they did not mean. Split out from CANCEL because the
     * two need opposite responses: a cancel ends the order, a rejection
     * asks for the next option. MG-ShopDial found Negative feedback to be
     * the highest-agreement intent in the whole schema, which is what you
     * would expect: people are unambiguous when they say no to a
     * suggestion.
     */
    'REJECT',
    /** namaste, kya haal hai, thanks */
    'GREETING',
    /** asking the shop something: timings, availability, price */
    'QUESTION',
    'UNKNOWN',
  ]),

  /**
   * WHAT THE UTTERANCE IS IN SERVICE OF, which is a different question
   * from what it does.
   *
   * Taken from MG-ShopDial (Bernard & Balog, SIGIR '23). Their finding is
   * that the Recommend intent appears in NO utterance annotated with the
   * QA or Search goal -- so an agent tracking intent alone cannot tell
   * when a suggestion is welcome and when it is an interruption.
   *
   * ORDERING IS OURS, NOT THEIRS, and the difference matters. Their four
   * goals describe DISCOVERY shopping: someone who does not yet know
   * which phone they want. A kirana line is mostly REPLENISHMENT --
   * "do kilo atta bhej dena" from a customer who has bought the same atta
   * for two years. That is a transaction, not a search, and forcing it
   * into Recommendation would mislabel the overwhelming majority of real
   * traffic. Their observation that conversations open with recommendation
   * for 10-15 turns does not transfer here, and pretending it does would
   * be cargo-culting a paper rather than reading it.
   */
  goal: z
    .enum(['ORDERING', 'RECOMMENDATION', 'QA', 'SEARCH', 'META'])
    .default('ORDERING'),
});

export type Extraction = z.infer<typeof extractionSchema>;
