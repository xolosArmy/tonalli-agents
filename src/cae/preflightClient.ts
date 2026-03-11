import axios from "axios";
import { env } from "../config/env";
import { TxIntent, PreflightResponse } from "../types/policy";

const client = axios.create({
  baseURL: env.CAE_PREFLIGHT_URL,
  timeout: 10000
});

export async function requestPreflight(intent: TxIntent): Promise<PreflightResponse> {
  try {
    // Aquí simulamos la llamada HTTP para este MVP.
    // En producción, descomenta la siguiente línea:
    // const { data } = await client.post("", intent);
    // return data;

    console.log(`[CAE PREFLIGHT] Evaluando intent de ${intent.agentId} por ${intent.amountSats} sats...`);
    
    // MOCK DEL CAE PARA PRUEBAS: Si supera el límite diario, falla.
    if (intent.amountSats > env.AGENT_DAILY_LIMIT_SATS) {
        return {
            decision: "rejected",
            reason: `Monto (${intent.amountSats}) supera el límite diario del agente (${env.AGENT_DAILY_LIMIT_SATS})`,
            policyTraceId: `cae_mock_${Date.now()}`
        }
    }
    
    return {
        decision: "approved",
        reason: "Within A2/A3 policy threshold",
        policyTraceId: `cae_mock_${Date.now()}`
    };

  } catch (error) {
    console.error("[CAE PREFLIGHT] Error al consultar el Tribunal:", error);
    throw error;
  }
}
