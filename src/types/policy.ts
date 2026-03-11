export type PreflightDecision = "approved" | "rejected" | "needs_human_approval";

export interface TxIntent {
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
}

export interface PreflightResponse {
  decision: PreflightDecision;
  reason: string;
  policyTraceId?: string;
  requiresApproval?: boolean;
}
