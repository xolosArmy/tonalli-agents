"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeSendXEC = safeSendXEC;
const policyGuard_1 = require("../cae/policyGuard");
const sessionSigner_1 = require("./sessionSigner");
const bus_1 = require("../events/bus");
const env_1 = require("../config/env");
const policy_1 = require("../types/policy");
async function safeSendXEC(input) {
    // 1. Construir el Intent
    const intent = {
        agentId: env_1.env.AGENT_ID,
        agentRole: env_1.env.AGENT_ROLE,
        fromAddress: env_1.env.AGENT_WALLET,
        toAddress: input.toAddress,
        amountSats: input.amountSats,
        reason: input.reason,
        memo: input.memo,
        timestamp: new Date().toISOString()
    };
    try {
        // 2. Obligar al Preflight Constitucional
        const preflight = await (0, policyGuard_1.enforcePreflight)(intent);
        // 3. La firma real pertenece a Tonalli Wallet y aún no está implementada.
        const signedTransaction = await (0, sessionSigner_1.signApprovedIntent)(intent);
        // 4. Emitir un estado no ejecutable, nunca un éxito de transacción.
        (0, bus_1.emitEvent)(bus_1.Topics.TX_NOT_IMPLEMENTED, {
            status: "not_implemented",
            agentId: intent.agentId,
            toAddress: intent.toAddress,
            amountSats: intent.amountSats,
            policyTraceId: preflight.policyTraceId
        });
        return {
            status: "not_implemented",
            simulation: true,
            intent,
            policyDecision: preflight,
            humanApproval: {
                status: "required"
            },
            signedTransaction,
            broadcast: {
                status: "not_attempted"
            },
            confirmation: {
                status: "not_attempted"
            }
        };
    }
    catch (error) {
        // Emitir el rechazo
        (0, bus_1.emitEvent)(bus_1.Topics.POLICY_REJECTED, {
            agentId: intent.agentId,
            error: error.message
        });
        throw error;
    }
}
//# sourceMappingURL=safeSendXEC.js.map
