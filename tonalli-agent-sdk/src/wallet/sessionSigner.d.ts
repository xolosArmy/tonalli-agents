import { TxIntent } from "../types/policy";
export interface SigningNotImplementedResult {
    status: "not_implemented";
    simulation: true;
    reason: "wallet_signing_not_implemented";
}
export declare function signApprovedIntent(intent: TxIntent): Promise<SigningNotImplementedResult>;
//# sourceMappingURL=sessionSigner.d.ts.map
