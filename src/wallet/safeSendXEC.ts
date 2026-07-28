import { enforcePreflight } from "../cae/policyGuard";
import { signApprovedIntent } from "./sessionSigner";
import { emitEvent, Topics } from "../events/bus";
import { env } from "../config/env";
import { TxIntent } from "../types/policy";

interface SafeSendXecInput {
  toAddress: string;
  amountSats: number;
  reason: string;
  memo?: string;
}

export async function safeSendXEC(input: SafeSendXecInput) {
  // 1. Construir el Intent
  const intent: TxIntent = {
    agentId: env.AGENT_ID,
    agentRole: env.AGENT_ROLE,
    fromAddress: env.AGENT_WALLET,
    toAddress: input.toAddress,
    amountSats: input.amountSats,
    reason: input.reason,
    memo: input.memo,
    timestamp: new Date().toISOString()
  };

  try {
    // 2. Obligar al Preflight Constitucional
    const preflight = await enforcePreflight(intent);

    // 3. La firma real pertenece a Tonalli Wallet y aún no está implementada.
    const signedTransaction = await signApprovedIntent(intent);

    // 4. Emitir un estado no ejecutable, nunca un éxito de transacción.
    emitEvent(Topics.TX_NOT_IMPLEMENTED, {
      status: "not_implemented",
      agentId: intent.agentId,
      toAddress: intent.toAddress,
      amountSats: intent.amountSats,
      policyTraceId: preflight.policyTraceId
    });

    return {
      status: "not_implemented" as const,
      simulation: true as const,
      intent,
      policyDecision: preflight,
      humanApproval: {
        status: "required" as const
      },
      signedTransaction,
      broadcast: {
        status: "not_attempted" as const
      },
      confirmation: {
        status: "not_attempted" as const
      }
    };

  } catch (error: any) {
    // Emitir el rechazo
    emitEvent(Topics.POLICY_REJECTED, {
      agentId: intent.agentId,
      error: error.message
    });
    throw error;
  }
}
