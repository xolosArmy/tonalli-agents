declare module "@xolosarmy/tonalli-agent-sdk" {
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
    status: "not_implemented";
    simulation: true;
    policyDecision: {
      decision: string;
      reason: string;
      policyTraceId?: string;
    };
    humanApproval: {
      status: "required";
    };
    signedTransaction: {
      status: "not_implemented";
      simulation: true;
      reason: "wallet_signing_not_implemented";
    };
    broadcast: {
      status: "not_attempted";
    };
    confirmation: {
      status: "not_attempted";
    };
  }>;

  export function preflightSendXEC(input: {
    toAddress: string;
    amountSats: number;
    reason: string;
    memo?: string;
  }): Promise<{
    success: boolean;
    intent: {
      agentId: string;
      agentRole: string;
      fromAddress: string;
      toAddress: string;
      amountSats: number;
      tokenId?: string;
      tokenAmount?: string;
      reason: string;
      memo?: string;
      timestamp: string;
    };
    preflight: {
      decision: string;
      reason: string;
      policyTraceId?: string;
      requiresApproval?: boolean;
    };
  }>;
}
