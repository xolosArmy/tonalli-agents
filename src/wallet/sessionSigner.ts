import { TxIntent } from "../types/policy";

export interface SigningNotImplementedResult {
  status: "not_implemented";
  simulation: true;
  reason: "wallet_signing_not_implemented";
}

/**
 * Cycle 1 safety boundary.
 *
 * This function intentionally does not create, sign, or identify a
 * transaction. Real signing must be implemented inside Tonalli Wallet.
 */
export async function signApprovedIntent(
  intent: TxIntent
): Promise<SigningNotImplementedResult> {
  console.log(`[SIGNER] Firma no implementada para la intención hacia ${intent.toAddress}.`);
  return {
    status: "not_implemented",
    simulation: true,
    reason: "wallet_signing_not_implemented"
  };
}
