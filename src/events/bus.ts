import EventEmitter from "eventemitter3";

export const bus = new EventEmitter();

export const Topics = {
  BALANCE_LOW: "treasury.balance_low",
  TX_NOT_IMPLEMENTED: "treasury.tx.not_implemented",
  POLICY_REJECTED: "policy.rejected"
} as const;

export function emitEvent(topic: string, payload: unknown) {
  bus.emit(topic, payload);
}

export function onEvent(topic: string, handler: (payload: unknown) => void) {
  bus.on(topic, handler);
}
