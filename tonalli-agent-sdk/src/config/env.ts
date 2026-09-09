import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

export const parseEnvBoolean = (value: unknown, defaultValue = true): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1") return true;
    if (trimmed === "false" || trimmed === "0") return false;
  }
  return defaultValue;
};

export const parseEnvNonnegativeInt = (value: unknown, defaultValue = 0): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return defaultValue;
};

export const EnvSchema = z.object({
  CHRONIK_URL: z.string().min(1),
  CAE_PREFLIGHT_URL: z.string().url(),
  CAE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  AGENT_ID: z.string().min(1),
  AGENT_ROLE: z.string().min(1),
  AGENT_WALLET: z.string().min(1),
  AGENT_DAILY_LIMIT_SATS: z.preprocess(
    (val) => parseEnvNonnegativeInt(val, 0),
    z.number().int().nonnegative().default(0)
  ),
  AGENT_INTENT_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  AGENTIC_KILL_SWITCH: z.preprocess(
    (val) => parseEnvBoolean(val, true),
    z.boolean().default(true)
  )
});

export const env = EnvSchema.parse(process.env);
