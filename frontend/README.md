# VeriCourt frontend

A client-only static app: Vite, React and TypeScript, styled with plain CSS custom properties (Forensic Pop tokens). There is no backend.

**Current scope (Phase 4):**
- **Ordinary build (read-only):** case dashboard (your cases from the contract's party index, open by ID, recently viewed in this browser), case detail with agreement, reply and deadline, evidence register, timeline and assessment, and a browser-generated case report (print or `.html` download). It reads only the contract configured with `VITE_VERICOURT_CONTRACT_ADDRESS`, after confirming the deployed code is the reviewed contract on StudioNet. **It cannot send transactions.**
- **Write experiment build (localhost only, gated):** the create-case wizard, evidence, reply, missed-deadline and assessment-request forms, each through the guarded write path (see below).
- **Wallet:** the app talks to an injected EIP-1193 wallet passively on load (`eth_chainId`, `eth_accounts`); `eth_requestAccounts` only when the user presses Connect.

### Run the read-only app against the test contract

```bash
VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220 npm run dev
```

Then open http://127.0.0.1:5173/#/app. Each case page makes about 8 read requests (plus 3 once per session for the contract check) and never polls: StudioNet allows about 500 requests per hour per IP.

## Guarded write path (Phase 3.5A, not connected)

`src/write/` holds the guard for a future single-write experiment. Nothing in the app imports it (`isolation.test.ts` enforces this), writes stay disabled, and it is absent from the production bundle.

- **One request per operation:** a `WriteGuard` permits exactly one `eth_sendTransaction` (wallet) or one `signTransaction` (in-memory test signer), claimed synchronously before any check.
- **Exact match:** chain, sender, consensus target, V5 `addTransaction` selector and the full calldata are compared byte for byte with the approved intent.
- **SDK fallback:** genlayer-js's V6 resend is refused at the guard and never reaches the wallet or the key.
- **Deadline:** `runGuardedWrite` disarms the guard on timeout; an already-forwarded request is reported as uncertain, never as failed.
- **Uncertain blocks:** `WriteSession` refuses new writes until `reconcile` finds positive evidence.

Details: `docs/PHASE_3_5A_GUARD_IMPLEMENTATION_REPORT.md`.

**Browser-wallet preparation (Phase 3.5B, still not wired, writes still disabled):**
- **Persistent safety record:** `pendingStore.ts` + `durableSession.ts`, in browser storage under `vericourt.write.pending.v1`.
  - It is written **before** any wallet request (write-ahead). If that save fails, nothing is sent.
  - A reload recovers it as `not_sent` only if no request had been forwarded; otherwise it becomes uncertain and stays blocked.
  - Unreadable records and unwritable storage block all writes.
- **One write across tabs:** the Web Locks API. Writes are refused if it is unavailable.
- **Account, chain or disconnect events** during an operation close it before the forward. A wallet that cannot report them is not used.
- **Read-only reconciliation:** `reconcileReader.ts` checks:
  - lookups by the recorded hash;
  - nonces (recorded only; never treated as proof);
  - a `create_case` effect check at `latest-final` / `latest-nonfinal`.

  A finalized effect settles as `confirmed_by_state`; anything else stays blocked.
- **Confirmation screen:** `components/WriteConfirmation.tsx`, previewed at `#/review` with fictional data. The final button is always disabled in this build.

Details: `docs/PHASE_3_5B_BROWSER_WALLET_PREPARATION_REPORT.md`.

## Write experiment build (Phase 3.5C): off by default

**The ordinary build has no write path:** `npm run dev`, `npm run build` and `npm run preview` produce an app with none of this code. The experiment UI sits behind a build-mode check that Vite removes from ordinary bundles.

**What a write needs, all five conditions** (`src/config/writeGate.ts`):

```bash
VITE_VERICOURT_WRITE_EXPERIMENT=I-UNDERSTAND-THIS-SENDS-ONE-REAL-STUDIONET-TRANSACTION VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220 npx vite --mode write-experiment
```

1. `--mode write-experiment`;
2. the exact acknowledgement phrase;
3. a known throwaway test contract;
4. a page served from localhost;
5. `CONTRACT_WRITES_ENABLED` still `false`.

**Do not run it without separate approval:** with all five conditions met, `#/review` can send **real StudioNet transactions**, one at a time: `create_case`, `submit_evidence`, `submit_reply`, `process_reply_deadline` and `request_assessment` (`#/review?action=<method>&case=VC-…`). Each one is reviewed field by field, needs an explicit acknowledgement and one click, runs a fresh preflight under a cross-tab lock, and counts as success only after finality plus a latest-final read showing its effect. One unresolved write blocks every other write in the browser profile. The flow lives in `src/experiment/`. Details: `docs/PHASE_3_5C_WRITE_WIRING_REPORT.md`, `docs/PHASE_4_IMPLEMENTATION_REPORT.md`.

## Wallet connection (Phase 3.4)

**Structure:** `src/wallet/` holds three layers:
- `eip1193.ts`: provider access and strict validation;
- `walletState.ts`: a pure reducer;
- `WalletContext.tsx`: one listener set per provider, removed on unmount.

**Wallet calls:**
- On load, the app makes a passive `eth_chainId` + `eth_accounts` read.
- `eth_requestAccounts` runs only when the user presses Connect.
- The app listens for `accountsChanged`, `chainChanged` and `disconnect`.
- There is no network switching, signing or sending. Writes stay disabled (`WRITES_DISABLED_REASON`).

**Status display:** the header chip shows wallet status on every page; the wallet page is `#/wallet`.

The wallet's chain is read from the wallet itself and is never inferred from the RPC configuration. Results are in `docs/PHASE_3_4_WALLET_REPORT.md`.

## Live read-only check (Phase 3.3)

The **Live read-only check** page (`#/live`) talks to StudioNet only when the user presses its button.

**Where it reads from:**
- the known throwaway Phase 2.17C test deployment (`src/config/testDeployments.ts`);
- through `src/live/sdkGateway.ts`, which loads genlayer-js lazily.

**What it checks, in order** (it stops at the first failure):
1. The chain ID.
2. The deployed contract code against the SHA-256 of `../contracts/vericourt.py`, plus the address named in the deploy transaction.
3. Contract reads at `latest-nonfinal` and `latest-final`, validated and compared with the recorded read-back.
4. The known transaction lookups.

**Safety:** every call has a 20 s timeout. Nothing is retried, and the gateway exposes only read methods.

Results are in `docs/PHASE_3_3_READ_ONLY_BROWSER_REPORT.md`.

## Hosted demo (Vercel)

**Live:** https://vericourt.vercel.app (deployed 2026-10-22, Vercel project `vericourt`).

**What it is:** the ordinary **read-only** build, configured for the throwaway **test contract** `0x3258…6220` (fictional data). It cannot send transactions; the experiment build is never deployed.

**Security headers** come from `deploy/vercel.json`:
- the content-security policy allows scripts and styles from the site itself only, and connections only to `https://studio.genlayer.com`;
- no framing, no-referrer, nosniff, and a locked-down permissions policy.

**To redeploy:** build a static folder, check it, add the headers file, and deploy that folder (no build runs on Vercel):

```bash
VITE_VERICOURT_CONTRACT_ADDRESS=0x3258A80A86920792354A9b7e59D5Ed2409E96220 npx vite build --outDir ../.deploy/vericourt --emptyOutDir
grep -rlF "write-experiment" ../.deploy/vericourt   # must print nothing
cp deploy/vercel.json ../.deploy/vericourt/ && cd ../.deploy/vericourt && npx vercel@65.1.0 deploy --prod
```

## Commands

Requires Node ≥ 24.15.

| Command | Purpose |
|---|---|
| `npm ci` | Install the exact versions from `package-lock.json` |
| `npm run dev` | Dev server on http://127.0.0.1:5173 |
| `npm run typecheck` | Strict TypeScript, no emit |
| `npm run lint` | ESLint (flat config; forbids `dangerouslySetInnerHTML`) |
| `npm test` | Vitest (jsdom). Every network API is stubbed to throw |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run preview` | Serve `dist/` on http://127.0.0.1:4173 |

## Configuration

- **`VITE_VERICOURT_CONTRACT_ADDRESS`** (optional, build time):
  - No contract address is selected by default, because there is no designated deployment.
  - When the variable is unset, contract features show as unavailable.
- **`src/config/network.ts`** holds the expected StudioNet chain (61999) and RPC URL, and `CONTRACT_WRITES_ENABLED = false`.

## Layout

| Path | Responsibility |
|---|---|
| `src/contract/` | Mirror of the contract's enums, exact notice strings, and view return types. `enums.test.ts` parses `../contracts/vericourt.py` so they cannot drift |
| `src/display/` | Pure display-safety functions (Phase 2.18B rules): labels, provenance blocks, the no-response notice, citation groups (UNRESOLVED shows no direction), the claimant-only caution, advisory remedy |
| `src/tx/` | Transaction classifier (port of the Phase 2.13 harness) and the write state model (no retry event) |
| `src/wallet/` | EIP-1193 connection (`eth_chainId`, `eth_accounts`, `eth_requestAccounts` only), state reducer, React context |
| `src/cases/` | Read-only case loading (contract check, finality comparison, validation, cross-read consistency checks), action eligibility, browser-local recent cases and sent-transaction list |
| `src/experiment/` | Gated write workspace: wizard, case-action forms, per-method preflight and effect checks |
| `src/pages/`, `src/components/`, `src/app/` | Landing, dashboard, case detail, case report, wallet diagnostics, limitations; hash routing (`#/case/VC-…`, `#/report/VC-…`) |
| `src/fixtures/recorded/` | Verbatim StudioNet data from Phases 2.8–2.17C (copied from the git-ignored `integration-logs/`) |

## Verified vs unverified

**Verified:**
- the contract enums and notices (source-parsed test);
- recorded contract read-backs;
- the raw StudioNet transaction shape (Phase 2.8);
- genlayer-js 1.1.8 source behaviour.

**Unverified until Phase 3.3+:**
- how genlayer-js decodes reads in a browser;
- whether the wallet-path `writeContract` return value is a GenLayer transaction ID;
- browser CORS access to the StudioNet RPC;
- gasless wallet writes.

See `src/tx/state.ts` `PHASE_VERIFICATION`.
