import EventEmitter from "eventemitter3";

const GLOBAL_BUS_KEY = Symbol.for("tonalli.agents.event_bus");
const globalBusHolder = globalThis as unknown as {
  [GLOBAL_BUS_KEY]?: EventEmitter;
};

export const bus: EventEmitter =
  globalBusHolder[GLOBAL_BUS_KEY] ??
  (globalBusHolder[GLOBAL_BUS_KEY] = new EventEmitter());

export const Topics = {
  BALANCE_LOW: "treasury.balance_low",
  TX_NOT_IMPLEMENTED: "treasury.tx.not_implemented",
  POLICY_NEEDS_HUMAN_APPROVAL: "policy.needs_human_approval",
  POLICY_REJECTED: "policy.rejected",
  WALLET_APPROVAL_TRANSPORT_FAILED: "wallet.approval_transport_failed"
} as const;

export function emitEvent(topic: string, payload: unknown) {
  bus.emit(topic, payload);
}

export function onEvent(topic: string, handler: (payload: unknown) => void) {
  bus.on(topic, handler);
}
