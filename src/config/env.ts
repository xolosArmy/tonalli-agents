import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  CHRONIK_URL: z.string(),
  CAE_PREFLIGHT_URL: z.string(),
  AGENT_ID: z.string(),
  AGENT_ROLE: z.string(),
  AGENT_WALLET: z.string(),
  AGENT_DAILY_LIMIT_SATS: z.coerce.number()
});

export const env = EnvSchema.parse(process.env);
