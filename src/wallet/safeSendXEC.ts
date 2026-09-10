import { randomUUID } from "node:crypto";
import {
  AGENTIC_CONTRACT_VERSION,
  parseAgenticWorkflowV1,
  parseWalletApprovalRequestV1,
  type HumanApprovalV1
} from "@xolosarmy/tonalli-core";
import { enforcePreflight } from "../cae/policyGuard";
import type { PreflightRequester } from "../cae/policyGuard";
import { emitEvent, Topics } from "../events/bus";
import {
  createWalletApprovalTransport,
  WalletApprovalTransportError,
  type WalletApprovalTransportPort
} from "./approvalTransport";
import {
  createAgentPaymentIntent,
  type AgentPaymentIntentInput,
  type IntentFactoryOptions
} from "./intent";

export interface SafeSendDependencies extends IntentFactoryOptions {
  requestPolicy?: PreflightRequester;
  walletApprovalPort?: WalletApprovalTransportPort;
  walletTransport?: ReturnType<typeof createWalletApprovalTransport>;
}

const signingNotAttempted = (intentId: string) => ({
  contractVersion: AGENTIC_CONTRACT_VERSION,
  kind: "signed_transaction" as const,
  status: "not_attempted" as const,
  intentId
});

const signingNotImplemented = (intentId: string) => ({
  contractVersion: AGENTIC_CONTRACT_VERSION,
  kind: "signed_transaction" as const,
  status: "not_implemented" as const,
  intentId,
  reason: "wallet_signing_not_implemented" as const
});

const broadcastNotAttempted = (intentId: string) => ({
  contractVersion: AGENTIC_CONTRACT_VERSION,
  kind: "broadcast" as const,
  status: "not_attempted" as const,
  intentId
});

const confirmationNotAttempted = (intentId: string) => ({
  contractVersion: AGENTIC_CONTRACT_VERSION,
  kind: "confirmation" as const,
  status: "not_attempted" as const,
  intentId
});

export async function safeSendXEC(
  input: AgentPaymentIntentInput,
  dependencies: SafeSendDependencies = {}
) {
  const intent = createAgentPaymentIntent(input, dependencies);
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));

  try {
    const policyDecision = dependencies.requestPolicy
      ? await enforcePreflight(intent, dependencies.requestPolicy, now)
      : await enforcePreflight(intent, undefined, now);
    const stoppedStages = {
      signedTransaction: signingNotAttempted(intent.intentId),
      broadcast: broadcastNotAttempted(intent.intentId),
      confirmation: confirmationNotAttempted(intent.intentId)
    };

    if (policyDecision.decision === "rejected") {
      const workflow = parseAgenticWorkflowV1({
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "agentic_workflow",
        intent,
        policyDecision,
        ...stoppedStages
      });
      emitEvent(Topics.POLICY_REJECTED, {
        intentId: intent.intentId,
        policyTraceId: policyDecision.policyTraceId,
        reasonCode: policyDecision.reasonCode
      });
      return {
        status: "rejected" as const,
        simulation: true as const,
        intent,
        policyDecision,
        workflow
      };
    }

    if (policyDecision.decision === "needs_human_approval") {
      const requestedAt = now();
      const expiresAt = Math.min(intent.expiresAt, policyDecision.expiresAt);
      const randomId = dependencies.randomId ?? randomUUID;
      const walletApprovalRequest = parseWalletApprovalRequestV1({
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "wallet_approval_request",
        purpose: "xec_payment",
        requestId: `wallet-request:${randomId()}`,
        intent,
        policyDecision,
        requestedAt,
        expiresAt
      });

      let humanApproval: HumanApprovalV1 | undefined;
      if (dependencies.walletApprovalPort) {
        if (!dependencies.walletTransport) {
          throw new WalletApprovalTransportError(
            "MISSING_WALLET_TRANSPORT",
            "walletApprovalPort was provided without a preconfigured walletTransport. Fail-closed: transport must be explicitly composed."
          );
        }
        humanApproval = await dependencies.walletTransport.dispatchApprovalRequest(
          walletApprovalRequest,
          dependencies.walletApprovalPort
        );
      }

      const workflow = parseAgenticWorkflowV1({
        contractVersion: AGENTIC_CONTRACT_VERSION,
        kind: "agentic_workflow",
        intent,
        policyDecision,
        walletApprovalRequest,
        ...(humanApproval ? { humanApproval } : {}),
        ...stoppedStages
      });

      emitEvent(Topics.POLICY_NEEDS_HUMAN_APPROVAL, {
        intentId: intent.intentId,
        requestId: walletApprovalRequest.requestId,
        policyTraceId: policyDecision.policyTraceId
      });

      if (!humanApproval) {
        return {
          status: "needs_human_approval" as const,
          simulation: true as const,
          intent,
          policyDecision,
          walletApprovalRequest,
          workflow
        };
      }

      if (humanApproval.status === "approved") {
        return {
          status: "human_approval_recorded" as const,
          simulation: true as const,
          intent,
          policyDecision,
          walletApprovalRequest,
          humanApproval,
          workflow
        };
      }

      if (humanApproval.status === "rejected") {
        return {
          status: "rejected" as const,
          simulation: true as const,
          intent,
          policyDecision,
          walletApprovalRequest,
          humanApproval,
          workflow
        };
      }

      return {
        status: "expired" as const,
        simulation: true as const,
        intent,
        policyDecision,
        walletApprovalRequest,
        humanApproval,
        workflow
      };
    }

    const workflow = parseAgenticWorkflowV1({
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "agentic_workflow",
      intent,
      policyDecision,
      signedTransaction: signingNotImplemented(intent.intentId),
      broadcast: broadcastNotAttempted(intent.intentId),
      confirmation: confirmationNotAttempted(intent.intentId)
    });
    emitEvent(Topics.TX_NOT_IMPLEMENTED, {
      status: "not_implemented",
      intentId: intent.intentId,
      policyTraceId: policyDecision.policyTraceId
    });
    return {
      status: "not_implemented" as const,
      simulation: true as const,
      intent,
      policyDecision,
      workflow
    };
  } catch (error: any) {
    emitEvent(Topics.POLICY_REJECTED, {
      intentId: intent.intentId,
      error: error instanceof Error ? error.message : "Unknown fail-closed error"
    });
    throw error;
  }
}
