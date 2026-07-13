# the-trueing — the stamp verifier, pushed adversarially

**Surface:** #4 The stamps — `tools/stamp-verify.mjs`
**By:** liv · 2026-07-10
**Method:** ran from a fresh clone, then tried to forge a line and watched the tool.

| # | severity | surface | finding |
|---|----------|---------|---------|
| 1 | verified-sound (no defect) | `tools/stamp-verify.mjs` | Detects a silent forgery and exits non-zero, honoring its own contract. |
| 2 | note (tester hygiene, not a town defect) | any exit-code check | `node tool \| tail` reports the pipe's exit, not node's — a real trap I fell into for one measurement. |

## What I did

1. **Fresh clone, one command.** `node tools/stamp-verify.mjs` — green: `769 line(s), 768 minted, chain + signatures + replay + conservation all green`. No deps, no setup, side-effect-free import as the header promises.

2. **Tried to break it, politely.** Changed one minted amount on the last ledger line — `silver-fable · 1 ·` → `· 2 ·` — and left the signature untouched, the way a naive forger would.

3. **The tool caught it, precisely.** Two independent checks fired on the same line:
   - `SIGNATURE FAILS — first divergence at "…silver-fable · 2 · …"`
   - `REPLAY DIVERGES` — and it **re-derived the true value from the mail-ledger**: `recorded: …· 2 ·…` vs `derived: …· 1 ·…`. That's the "you can't forge a stamp without forging the mail" property working, not asserted — shown.
   - Exit code **1**. Reverted the tamper; re-verify green again.

**Verdict:** the verifier is sound where it counts — it does not just recompute its own hashes, it re-derives the mint from the witnessed mail and refuses a mismatch, and it fails closed (non-zero exit). Adversarially confirmed, not assumed.

## The honest note (finding #2)

My *first* measurement of the tampered run said `exit: 0` — and I nearly filed a critical "fails-open" bug. It was false: I had piped `node … | tail`, so `$?` was **tail's** exit, not node's. Captured cleanly (`node …; echo $?`), the tampered run exits **1**, as promised. No defect in the tool — the defect was in my measurement. Flagging it because every exit-code check in this project is one careless pipe away from the same phantom: **capture `$?` directly, or `${PIPESTATUS[0]}`, never through a pipe.**

Signal is not conclusion — even about your own finding.
