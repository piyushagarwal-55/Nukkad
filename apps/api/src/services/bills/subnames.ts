import { z } from 'zod';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { retrieveKb } from '../kb/retrieve.js';

/**
 * GROUNDED SUBNAME GENERATION.
 *
 * A bill prints the trade's name for a product. A customer says something
 * else entirely, and that word is never on the bill:
 *
 *     bill says      "AASHIRVAAD ATTA 5KG"
 *     customer says  "atta bhejo" / "gehu ka atta" / "chakki wala atta"
 *
 * Asked cold for those names a model invents confident nonsense. Shown the
 * real ones for the nearest known products it mostly copies, which is the
 * point. Subnames are how a spoken order finds a SKU, so this is the
 * highest-leverage data in the system and the least safe place to guess.
 *
 * Lives here rather than inside the graph because it is needed twice. The
 * alias node runs it for lines the agent decided are new; the commit route
 * runs it for lines the OWNER decided are new, which the agent had marked
 * ambiguous and therefore never generated names for. A product created that
 * way used to land in the catalogue with no subnames at all and would never
 * have matched a spoken order.
 */

const schema = z.object({ aliases: z.array(z.string().min(2).max(40)).max(8) });

const PROMPT = [
  'You give the local names Indian households actually use for a grocery item.',
  '',
  'You are shown REFERENCE entries: real products with the real names people',
  'use for them, retrieved from a curated list. Use them as your evidence.',
  '',
  'Return ONLY JSON: {"aliases":["...","..."]}',
  '',
  'RULES:',
  '- Prefer names that appear in the REFERENCE block. Reuse them verbatim when',
  '  the product is the same kind of thing.',
  '- Roman Hinglish, lowercase, no Devanagari.',
  '- Always include the bare generic ("atta", "tel", "namak"): it is what',
  '  people say most.',
  '- Include romanisation variants people actually type ("aata", "chini").',
  '- Include the brand alone only if people refer to it that way.',
  '- NEVER include the pack size or a number. Quantity is handled elsewhere.',
  '- If the reference block is empty, return at most three names you are sure of.',
  '- Maximum 8. Fewer good ones beats more invented ones.',
].join('\n');

export interface SubnameResult {
  aliases: string[];
  /** whether the knowledge base had anything close to stand on */
  grounded: boolean;
}

export async function groundedSubnames(productName: string): Promise<SubnameResult> {
  const kb = await retrieveKb(productName);
  const reference = kb
    .map((h) => `- ${(h.brand + ' ' + h.canonical).trim()} (${h.category}): ${h.subnames.join(', ')}`)
    .join('\n');

  try {
    const res = await groq.chat.completions.create({
      model: env.GROQ_LLM_MODEL_FAST,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: `PRODUCT AS PRINTED: ${productName}\n\nREFERENCE:\n${reference || '(nothing close found)'}`,
        },
      ],
    });

    const parsed = schema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
    if (!parsed.success) return { aliases: [], grounded: !!reference };

    const aliases = [
      ...new Set(
        parsed.data.aliases
          .map((a) => a.trim().toLowerCase())
          // a "subname" carrying a digit is a pack size, not a name
          .filter((a) => a && !/\d/.test(a)),
      ),
    ];
    return { aliases, grounded: !!reference };
  } catch {
    return { aliases: [], grounded: !!reference };
  }
}
