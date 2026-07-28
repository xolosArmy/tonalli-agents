import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  CHRONIK_URL: z.string().min(1),
  CAE_PREFLIGHT_URL: z.string().url(),
  CAE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  AGENT_ID: z.string().min(1),
  AGENT_ROLE: z.string().min(1),
  AGENT_WALLET: z.string().min(1),
  AGENT_DAILY_LIMIT_SATS: z.coerce.number().int().nonnegative(),
  AGENT_INTENT_TTL_SECONDS: z.coerce.number().int().positive().default(300)
});

export const env = EnvSchema.parse(process.env);
