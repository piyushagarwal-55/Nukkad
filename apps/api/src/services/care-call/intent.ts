import { z } from 'zod';
import { groq } from '../../lib/groq.js';
import { env } from '../../config/env.js';
import { span } from '../telemetry/span.js';

export const careCallStageSchema = z.enum(['PERMISSION', 'ORDER']);
export type CareCallStage = z.infer<typeof careCallStageSchema>;

export const careCallActSchema = z.enum([
  'PERMISSION_GRANTED',
  'PERMISSION_DENIED',
  'ORDER_ACCEPTED',
  'ORDER_DECLINED',
  'ADD_OR_CHANGE_ITEMS',
  'ASK_QUESTION',
  'UNCLEAR',
]);
export type CareCallAct = z.infer<typeof careCallActSchema>;

export const careCallFrameSchema = z.object({
  act: careCallActSchema,
  confidence: z.number().min(0).max(1),
  orderText: z.string().nullable().default(null),
  question: z.string().nullable().default(null),
});
export type CareCallFrame = z.infer<typeof careCallFrameSchema>;

const UNREAD: CareCallFrame = {
  act: 'UNCLEAR',
  confidence: 0,
  orderText: null,
  question: null,
};

const SYSTEM = [
  'You read one reply in a proactive kirana care call. You classify only;',
  'you do not decide inventory, payment, or fulfilment.',
  '',
  'Return ONLY JSON:',
  '{"act":"<act>","confidence":0.0,"orderText":"<customer order words or null>","question":"<question or null>"}',
  '',
  'ACTS:',
  '- PERMISSION_GRANTED: caller allows the shop to continue the call.',
  '- PERMISSION_DENIED: caller is busy, says no, asks to call later, or wants to end.',
  '- ORDER_ACCEPTED: caller agrees to order the due items already mentioned.',
  '- ORDER_DECLINED: caller says they do not need the mentioned items.',
  '- ADD_OR_CHANGE_ITEMS: caller names items, quantities, additions, removals, or changes.',
  '- ASK_QUESTION: caller asks price, offer, delivery, stock, or any clarification.',
  '- UNCLEAR: not enough signal.',
  '',
  'Stage matters:',
  '- At PERMISSION stage, do not treat a yes as an order. It only means continue.',
  '- At ORDER stage, a yes to the just-mentioned basket is ORDER_ACCEPTED.',
  '- If the caller names products at any stage, use ADD_OR_CHANGE_ITEMS and put',
  '  their product words in orderText.',
  '',
  'Never infer payment. Never invent products not present in the dueItems or user reply.',
].join('\n');

export async function readCareCallReply(input: {
  stage: CareCallStage;
  text: string;
  customerName: string;
  shopName: string;
  dueItems: string[];
  lastPrompt: string;
}): Promise<CareCallFrame> {
  const user = [
    `stage: ${input.stage}`,
    `customer: ${input.customerName}`,
    `shop: ${input.shopName}`,
    `dueItems: ${input.dueItems.length ? input.dueItems.join(', ') : 'none'}`,
    `lastPrompt: ${input.lastPrompt}`,
    `callerReply: ${input.text}`,
  ].join('\n');

  try {
    const res = await span('llm.care_call.intent', () => groq.chat.completions.create({
      model: env.GROQ_LLM_MODEL_FAST,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }));

    const parsed = careCallFrameSchema.safeParse(JSON.parse(res.choices[0]?.message?.content ?? '{}'));
    if (!parsed.success || parsed.data.confidence < 0.45) return UNREAD;
    return parsed.data;
  } catch {
    return UNREAD;
  }
}
