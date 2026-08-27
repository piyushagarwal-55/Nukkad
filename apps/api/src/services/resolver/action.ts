/**
 * COMMAND PHRASES, MASKED BEFORE ANYTHING LOOKS FOR A PRODUCT.
 *
 * "daal do" means put it in. "daal" is a lentil. Token-level matching
 * cannot tell those apart and does not know it is failing: asked "ek aur
 * yeh bhi daal do" one message after being quoted a price for sugar, the
 * shop matched the verb against three dals and offered them.
 *
 * The fix is not a better score for the word daal. It is that the word
 * never reaches product matching at all, because it is not a word here --
 * it is half of a two-word command. Phrases are recognised and removed
 * FIRST, and whatever survives is what the customer named.
 *
 * WHY PHRASES AND NOT WORDS. Because the ambiguity lives entirely at the
 * word level and disappears at the phrase level. "daal" is a coin flip;
 * "daal do" is a command every time. The same is true of "de do", "kar
 * do", "hata do" -- Hinglish builds commands by pairing a verb with do or
 * dena, and the pairing is the signal.
 *
 * WHAT THIS IS NOT. It is not a list of products, and it must never
 * become one. Product knowledge belongs in the catalogue and the KB where
 * a shopkeeper can change it. This is grammar: a closed, small set of
 * ways to say "add this", which is the same reason the yes/no vocabulary
 * in conversation/reply.ts is a list rather than a model call.
 */

/** what a command phrase is asking for */
export type Action = 'ADD' | 'REMOVE' | 'SEND' | 'MORE';

interface Phrase {
  words: string[];
  action: Action;
}

/**
 * Longest first, because matching is greedy and "cancel kar do" must be
 * recognised before "kar do" claims its tail.
 */
const PHRASES: Phrase[] = [
  ['cancel kar do', 'REMOVE'],
  ['hata do', 'REMOVE'],
  ['nikal do', 'REMOVE'],
  ['add kar do', 'ADD'],
  ['pack kar do', 'ADD'],
  ['daal do', 'ADD'],
  ['daal dijiye', 'ADD'],
  ['daal dena', 'ADD'],
  ['rakh do', 'ADD'],
  ['rakh dijiye', 'ADD'],
  ['de do', 'ADD'],
  ['de dijiye', 'ADD'],
  ['kar do', 'ADD'],
  ['bhej do', 'SEND'],
  ['bhej dena', 'SEND'],
  ['bhej dijiye', 'SEND'],
  ['ek aur', 'MORE'],
  ['aur do', 'MORE'],
]
  .map(([p, action]) => ({ words: (p as string).split(' '), action: action as Action }))
  .sort((a, b) => b.words.length - a.words.length);

export interface Masked {
  /** what is left after the commands are removed, in order */
  rest: string;
  /** the commands that were found, so the caller knows what was asked */
  actions: Action[];
  /** true when a command was recognised at all */
  found: boolean;
}

const split = (text: string) =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Take the commands out and hand back the rest.
 *
 * Greedy left to right over a normalised token list, so "ek kilo sugar
 * daal do" leaves "ek kilo sugar" and "haan daal do" leaves nothing at
 * all -- which is the signal that the product must come from what the
 * conversation was already about.
 */
export function maskActions(text: string): Masked {
  const tokens = split(text);
  const kept: string[] = [];
  const actions: Action[] = [];

  let i = 0;
  while (i < tokens.length) {
    const hit = PHRASES.find((p) =>
      p.words.every((w, k) => tokens[i + k] === w),
    );
    if (hit) {
      actions.push(hit.action);
      i += hit.words.length;
      continue;
    }
    kept.push(tokens[i]!);
    i += 1;
  }

  return { rest: kept.join(' '), actions, found: actions.length > 0 };
}
