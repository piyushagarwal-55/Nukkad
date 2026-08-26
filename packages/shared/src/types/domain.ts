export type AutonomyTier =
  | 'MANUAL'      // 0. household messages when it wants
  | 'SUGGESTED'   // 1. agent proposes, household taps confirm. DEFAULT.
  | 'STANDING'    // 2. agent places it, household has a veto window. Silence = consent.
  | 'SILENT';     // 3. locked staples basket under a rupee cap

export type InputSource = 'TEXT' | 'VOICE' | 'PHOTO' | 'AUTO' | 'MENU';

export type OrderStatus =
  | 'DRAFT'        // parsed, not yet shown
  | 'AWAITING'     // confirm card sent, waiting on the buyer
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'FULFILLED';

export type InvoiceStatus = 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'EXPIRED' | 'CANCELLED';

export type ConversationState =
  | 'IDLE'
  | 'MENU'
  | 'AWAITING_ORDER_INPUT'
  | 'AWAITING_CONFIRM'
  | 'AWAITING_DISAMBIGUATION'
  | 'AWAITING_VETO';   // tier 2 standing order countdown

export interface Household {
  id: string;
  kiranaId: string;
  name: string;
  phone: string;
  memberCount: number;
  autonomyTier: AutonomyTier;
  /** consecutive correct predictions, gates promotion to STANDING */
  streak: number;
}

export interface Sku {
  id: string;
  kiranaId: string;
  name: string;
  brand: string | null;
  packSize: number;
  unit: string;
  sellPaise: number;
  category: string | null;
  /** hand-added local names: 'chakki atta', 'peela tel'. Feeds the matcher. */
  aliases: string[];
}
