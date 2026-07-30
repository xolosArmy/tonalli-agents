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

Security Review Gate 1 is reproducible with Docker or Podman from an exact,
clean commit. See [`docs/security-gate-1.md`](docs/security-gate-1.md).
