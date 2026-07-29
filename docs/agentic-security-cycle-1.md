# Agentic security cycle 1

## Scope

This cycle normalizes the CAE boundary and contains risk. It does not activate
real funds, Commerce Relay, A2/A3 autonomy, Wallet signing, broadcast, or
Chronik confirmation.

The SDK pins `@xolosarmy/tonalli-core` to commit
`bbcea361579c18d00387c4f68ceeb53853a37328`, which defines agentic contract
version `1.0`.

## Fail-closed behavior

The CAE accepts a strict `AgentIntentV1` and returns a strict
`CaePolicyDecisionV1`. Its only decision values are:

- `approved`
- `rejected`
- `needs_human_approval`

Unknown decisions, missing responses, network failures, non-2xx responses,
incompatible versions, invalid structures, and mismatched intent IDs throw
`CaeFailClosedError`. They never enter a signing path.

The embedded policy engine also rejects:

- expired or not-yet-valid intents;
- repeated intent IDs or nonces;
- destinations outside the allowlist;
- cumulative daily amounts above the configured limit;
- every request while the kill-switch is active.

Valid monetary intents can advance only to `needs_human_approval`. Reservations
are counted when such a decision is issued, so concurrent intents cannot each
consume the same remaining limit. Cycle 1 state is process-local and
conservative; restarting the CAE requires the kill-switch to be enabled again
before any further evaluation.

## In-memory security state

Replay protection, consumed nonces, intent IDs, and cumulative-limit
reservations exist only in the memory of one CAE process. They are not durable,
shared, or atomically coordinated across processes. A restart clears them, and
two or more instances can hold different replay and spending-limit views.

These controls are therefore not suitable for multiple CAE instances or real
funds. Cycle 1 must remain single-process and non-financial, with the
kill-switch enabled and the monetary limit at zero. A later design requires a
durable, transactional, shared store before any real-funds or multi-instance
review can begin.

## Safe defaults

The standalone CAE reads:

| Variable | Default | Meaning |
|---|---:|---|
| `AGENTIC_KILL_SWITCH` | `true` | Reject all monetary intents |
| `AGENT_DAILY_LIMIT_SATS` | `0` | Disable the daily monetary allowance |
| `AGENT_ALLOWED_PAY_TO` | empty | Allow no payment destination |
| `CAE_DECISION_TTL_SECONDS` | `60` | Maximum decision lifetime |

Disabling the kill-switch alone is insufficient: both a positive limit and an
explicit destination allowlist are required. The result still requires human
approval and cannot execute.

## Wallet and x402 handoff

`WalletApprovalRequestV1` is the complete downstream envelope. It contains the
intent, policy decision, request timestamps, and an optional bound
`X402ApprovalContextV1`. It contains no seed, private key, mnemonic, session
secret, signature, raw transaction, or signing material.

Tonalli Wallet must validate the envelope again, display the exact amount,
destination, reason, expiry, and policy trace, then record a separate
`HumanApprovalV1`. x402-XEC may contribute only its public invoice context:
network, invoice/resource hashes, amount, destination, nonce, and expiry.

Signing remains exclusively a future Tonalli Wallet responsibility. Until that
work lands, `safeSendXEC` returns one of:

- `rejected`
- `needs_human_approval`
- `not_implemented`

Every result has `simulation: true`. Signing is `not_attempted` or
`not_implemented`; broadcast and confirmation are `not_attempted`. No TXID or
raw transaction is returned.

## Compatibility

This is a breaking change for consumers of the previous mock response.

- Replace `approve`/`deny` with the three canonical decision values.
- Stop reading `success`, `signed.txHex`, or `signed.txidPreview`.
- Read `policyDecision`, `walletApprovalRequest`, and `workflow` instead.
- Treat every parse or transport error as a hard stop.
- Do not infer execution from a policy approval.

Tonalli Wallet and x402-XEC integration remain blocked on their dedicated
issues; this PR does not modify either repository.

## Reproducible verification

Security Review Gate 1 supersedes host-only verification. From any checkout,
run the versioned clean-clone container runner against the exact commit:

```sh
./scripts/run-security-gate.sh <40-character-commit-sha>
```

The test suite covers valid canonical decisions, unknown/missing/invalid CAE
responses, network and status failures, replay, expiry, allowlist, cumulative
limits, kill-switch behavior, and the non-executable workflow boundary.

See [`security-gate-1.md`](security-gate-1.md) for the fixed Node image,
Docker/Podman commands, evidence requirements, approval text, and
commit-invalidation rule.
