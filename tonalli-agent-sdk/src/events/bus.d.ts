import EventEmitter from "eventemitter3";
export declare const bus: EventEmitter<string | symbol, any>;
export declare const Topics: {
    readonly BALANCE_LOW: "treasury.balance_low";
    readonly TX_NOT_IMPLEMENTED: "treasury.tx.not_implemented";
    readonly POLICY_REJECTED: "policy.rejected";
};
export declare function emitEvent(topic: string, payload: unknown): void;
export declare function onEvent(topic: string, handler: (payload: unknown) => void): void;
//# sourceMappingURL=bus.d.ts.map
