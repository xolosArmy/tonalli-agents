import { TxIntent } from "../types/policy";
interface SafeSendXecInput {
    toAddress: string;
    amountSats: number;
    reason: string;
    memo?: string;
}
export declare function safeSendXEC(input: SafeSendXecInput): Promise<{
    status: "not_implemented";
    simulation: true;
    intent: TxIntent;
    policyDecision: import("../types/policy").PreflightResponse;
    humanApproval: {
        status: "required";
    };
    signedTransaction: import("./sessionSigner").SigningNotImplementedResult;
    broadcast: {
        status: "not_attempted";
    };
    confirmation: {
        status: "not_attempted";
    };
}>;
export {};
//# sourceMappingURL=safeSendXEC.d.ts.map
