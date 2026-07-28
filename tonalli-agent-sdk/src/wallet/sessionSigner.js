"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signApprovedIntent = signApprovedIntent;
const policy_1 = require("../types/policy");
async function signApprovedIntent(intent) {
    console.log(`[SIGNER] Firma no implementada para la intención hacia ${intent.toAddress}.`);
    return {
        status: "not_implemented",
        simulation: true,
        reason: "wallet_signing_not_implemented"
    };
}
//# sourceMappingURL=sessionSigner.js.map
