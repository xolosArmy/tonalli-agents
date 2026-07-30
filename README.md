# tonalli-agents

## Cycle 1 money freeze

Agentic money execution is explicitly disabled. `safeSendXEC` can create an
intent and obtain a policy decision, but it returns `status:
"not_implemented"` with separate non-executed signing, broadcast, and
confirmation stages. It never returns a transaction hex or TXID.

This is a compatibility break from the early mock, which returned `success:
true`, `signed.txHex`, and `signed.txidPreview`. Consumers must treat the new
result as non-executable. Real signing will be implemented only inside Tonalli
Wallet after the canonical CAE contract and human-approval boundary are
reviewed.

## Canonical CAE contract

Cycle 1 consumes `@xolosarmy/tonalli-core` contract `1.0` from an immutable
commit. The only accepted CAE decisions are `approved`, `rejected`, and
`needs_human_approval`. Unknown values, absent responses, incompatible
versions, malformed payloads, network failures, and mismatched intent IDs all
fail closed.

The embedded CAE starts with its kill-switch enabled and its cumulative daily
limit disabled. Even an explicit canonical `approved` response stops at
`signed_transaction.status = "not_implemented"`; this repository cannot sign
or broadcast.

See [Cycle 1 security and compatibility](docs/agentic-security-cycle-1.md) for
configuration, reproducible tests, downstream handoff, and migration details.

Security Review Gate 1 is reproducible with Docker or Podman from an exact,
clean commit. See [`docs/security-gate-1.md`](docs/security-gate-1.md).
