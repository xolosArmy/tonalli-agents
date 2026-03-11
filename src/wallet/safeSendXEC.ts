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

    // 3. Si pasa, firmar
    const signed = await signApprovedIntent(intent);

    // 4. Emitir el evento de éxito
    emitEvent(Topics.TX_SIGNED, {
      agentId: intent.agentId,
      toAddress: intent.toAddress,
      amountSats: intent.amountSats,
      policyTraceId: preflight.policyTraceId,
      txidPreview: signed.txidPreview
    });

    return {
      success: true,
      intent,
      preflight,
      signed
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
