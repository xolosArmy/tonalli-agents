declare module "@xolosarmy/tonalli-agent-sdk" {
  type CanonicalDecision = {
    contractVersion: "1.0";
    kind: "cae_policy_decision";
    decisionId: string;
    intentId: string;
    decision: "approved" | "rejected" | "needs_human_approval";
    reasonCode: string;
    reason: string;
    policyTraceId: string;
    policyVersion: string;
    evaluatedAt: number;
    expiresAt: number;
  };

  export function getBalance(address: string): Promise<{
    address: string;
    sats: number;
    xec: number;
  }>;

  export function safeSendXEC(input: {
    toAddress: string;
    amountSats: number;
    reason: string;
    memo?: string;
  }): Promise<{
    status: "rejected" | "needs_human_approval" | "not_implemented";
    simulation: true;
    policyDecision: CanonicalDecision;
    walletApprovalRequest?: {
      contractVersion: "1.0";
      kind: "wallet_approval_request";
      purpose: "xec_payment";
      requestId: string;
    };
    workflow: {
      contractVersion: "1.0";
      kind: "agentic_workflow";
      signedTransaction?: {
        status: "not_attempted" | "not_implemented";
      };
      broadcast?: { status: "not_attempted" };
      confirmation?: { status: "not_attempted" };
    };
  }>;

  export function preflightSendXEC(input: {
    toAddress: string;
    amountSats: number;
    reason: string;
    memo?: string;
  }): Promise<{
    status: "preflight_only";
    simulation: true;
    policyDecision: CanonicalDecision;
    workflow: {
      contractVersion: "1.0";
      kind: "agentic_workflow";
    };
  }>;
}
