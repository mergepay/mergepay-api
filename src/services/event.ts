import { EventEmitter } from "node:events";

export const WEBHOOK_EVENT_TYPES = [
  "expense.created",
  "expense.settled",
  "settlement.completed",
  "settlement.failed",
  "treasury.proposal.created",
  "treasury.proposal.signed",
  "treasury.proposal.submitted",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface MergepayEvent {
  eventType: WebhookEventType;
  payload: unknown;
  groupId?: string;
  userId?: string;
}

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

export function emitEvent(event: MergepayEvent): void {
  eventBus.emit("event", event);
}
