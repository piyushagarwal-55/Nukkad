import type { ChannelAdapter, ChannelId } from '@nukkad/shared';
import { twilioAdapter } from './twilio.adapter.js';
import { simAdapter } from './sim.adapter.js';

const registry: Record<string, ChannelAdapter> = {
  twilio: twilioAdapter,
  sim: simAdapter,
};

export function adapterFor(id: ChannelId): ChannelAdapter {
  const a = registry[id];
  if (!a) throw new Error(`no channel adapter registered for '${id}'`);
  return a;
}

export { twilioAdapter, simAdapter };
export { drainSimOutbox } from './sim.adapter.js';
