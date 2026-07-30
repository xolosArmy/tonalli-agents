import type {
  AgentIntentV1,
  CaePolicyDecisionV1
} from "@xolosarmy/tonalli-core";

export type PreflightDecision = CaePolicyDecisionV1["decision"];
export type TxIntent = AgentIntentV1;
export type PreflightResponse = CaePolicyDecisionV1;
