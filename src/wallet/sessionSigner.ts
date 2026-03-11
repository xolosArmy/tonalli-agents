import { TxIntent } from "../types/policy";

export interface SignedTxResult {
  txHex: string;
  txidPreview: string;
}

export async function signApprovedIntent(intent: TxIntent): Promise<SignedTxResult> {
  console.log(`[SIGNER] Firmando transacción aprobada hacia ${intent.toAddress}...`);
  return {
    txHex: `signed_mock_tx_for_${intent.toAddress}_${intent.amountSats}`,
    txidPreview: `mock_txid_${Date.now()}`
  };
}
