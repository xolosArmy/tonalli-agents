import { requestPreflight } from "./preflightClient";
import { TxIntent, PreflightResponse } from "../types/policy";

export async function enforcePreflight(intent: TxIntent): Promise<PreflightResponse> {
  const response = await requestPreflight(intent);

  if (response.decision === "rejected") {
    throw new Error(`\n[MRCL ENFORCEMENT FAIL] Transacción bloqueada por el CAE.\nRazón: ${response.reason}\nTrace ID: ${response.policyTraceId}\n`);
  }

  if (response.decision === "needs_human_approval") {
    throw new Error(`[MRCL PENDING] Se requiere aprobación humana (A0): ${response.reason}`);
  }

  return response;
}
