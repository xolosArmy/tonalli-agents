/**
 * @file errors.ts
 *
 * Durable Authorization Store Error Types and Classification
 */

export type DurableStoreErrorCode =
  | "REPLAY_DETECTED"
  | "MONETARY_LIMIT_EXCEEDED"
  | "LEASE_EXPIRED"
  | "LEASE_SUPERSEDED"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_ALREADY_COMMITTED"
  | "STORE_UNAVAILABLE"
  | "INVALID_CLOCK"
  | "SCHEMA_ERROR";

export class DurableStoreError extends Error {
  readonly code: DurableStoreErrorCode;
  readonly details?: unknown;

  constructor(code: DurableStoreErrorCode, message: string, details?: unknown) {
    super(`[DurableStore] ${code}: ${message}`);
    this.name = "DurableStoreError";
    this.code = code;
    this.details = details;
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof Error &&
      instance.name === "DurableStoreError" &&
      typeof (instance as any).code === "string"
    );
  }
}
