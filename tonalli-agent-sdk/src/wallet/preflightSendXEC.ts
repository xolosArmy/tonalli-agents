import {
  AGENTIC_CONTRACT_VERSION,
  parseAgenticWorkflowV1
} from "@xolosarmy/tonalli-core";
import { enforcePreflight } from "../cae/policyGuard";
import {
  createAgentPaymentIntent,
  type AgentPaymentIntentInput
} from "./intent";

export async function preflightSendXEC(input: AgentPaymentIntentInput) {
  const intent = createAgentPaymentIntent(input);
  const policyDecision = await enforcePreflight(intent);
  const workflow = parseAgenticWorkflowV1({
    contractVersion: AGENTIC_CONTRACT_VERSION,
    kind: "agentic_workflow",
    intent,
    policyDecision,
    signedTransaction: {
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "signed_transaction",
      status: "not_attempted",
      intentId: intent.intentId
    },
    broadcast: {
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "broadcast",
      status: "not_attempted",
      intentId: intent.intentId
    },
    confirmation: {
      contractVersion: AGENTIC_CONTRACT_VERSION,
      kind: "confirmation",
      status: "not_attempted",
      intentId: intent.intentId
    }
  });

  return {
    status: "preflight_only" as const,
    simulation: true as const,
    intent,
    policyDecision,
    workflow
  };
}
