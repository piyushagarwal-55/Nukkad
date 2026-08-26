import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { z } from 'zod';

/**
 * A supplier bill carries the TRADE's name for a product. A customer says
 * something else entirely, and that word is never on the bill:
 *
 *   bill says   "AASHIRVAAD ATTA 5KG"
 *   customer says "atta bhejo" / "gehu ka atta" / "chakki wala atta"
 *
 * Aliases are that bridge, and they are the single highest-leverage data in
 * the system. They are never typed from scratch. Two mechanisms:
 *
 *   1. SUGGESTED here at import, approved with one tap.
 *   2. LEARNED at runtime: when the resolver is unsure and the buyer taps a
 *      disambiguation option, that is a labelled example. See
 *      services/resolver, and learnAlias() below.
 */
const aliasSchema = z.object({
  aliases: z.array(z.string().min(2).max(40)).max(8),
});

const PROMPT = [
  'You generate the local names Indian households actually use for a grocery product.',
  'Given a product as printed on a wholesale bill, return ONLY JSON:',
  '{"aliases":["...","..."]}',
  'RULES:',
  '- Roman Hinglish only, lowercase, no Devanagari.',
  '- Include the bare generic ("atta", "tel", "chawal") because that is what',
  '  people say most often.',
  '- Include common romanisation variants ("aata", "cheeni"/"chini").',
  '- Include the brand alone if the brand is how people refer to it.',
  '- Include descriptive references people actually use ("peela wala tel").',
  '- Do NOT include the pack size. Quantity is handled separately.',
  '- Maximum 8. Fewer good ones beats more bad ones.',
].join('\n');

export async function suggestAliases(productName: string): Promise<string[]> {
  const res = await groq.chat.completions.create({
    model: env.GROQ_LLM_MODEL_FAST,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: productName },
    ],
  });

  const parsed = aliasSchema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
  if (!parsed.success) return [];

  return [...new Set(parsed.data.aliases.map((a) => a.trim().toLowerCase()))].filter(Boolean);
}
