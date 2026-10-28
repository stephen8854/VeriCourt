# Phase 3.4: wallet connection and network verification

**Result:**
- **Built and tested with mocks:** a browser-wallet connection layer (detection, passive read, explicit Connect, strict validation, account/chain/disconnect events, an honest "stop showing" option, a header status chip) and a rebuilt wallet page.
- **Not verified with a real wallet:** none was available. The real browser was used only to confirm the no-wallet state and that the Phase 3.3 read-only check still works.
- **Writes:** still disabled everywhere, with the reason shown.

**Labels:**
- **[Live]**: observed in a real browser.
- **[Mock]**: verified with mocked EIP-1193 providers in automated tests.
- **[Code]**: verified from code.
- **[Assumption]**: not verified.

## 1. Files changed (all under `frontend/` except this report)

| File | Change |
|---|---|
| `src/wallet/eip1193.ts` | **Rewritten.** Detection (guards against a missing, null, non-function or throwing `window.ethereum`); passive `readWalletRaw` (`eth_chainId`, `eth_accounts`); explicit `requestWalletRaw` (`eth_requestAccounts`); `readChainIdRaw`. Strict validators: `interpretChainId` accepts only `0x`-hex strings (rejects numbers, decimal strings, `0x0`, oversized values); `interpretAccounts` treats any invalid entry as malformed instead of silently dropping it. Also `classifyProviderError` (4001 rejected, -32002 pending), `shortAddress`, and `subscribeToWallet` (one listener each for `accountsChanged` / `chainChanged` / `disconnect`; idempotent unsubscribe; reports providers without `on`/`removeListener`) |
| `src/wallet/walletState.ts` | **New.** Pure reducer and status view (§3) |
| `src/wallet/WalletContext.tsx` | **New.** App-wide provider and `useWallet()` (§4) |
| `src/components/WalletStatusChip.tsx` | **New.** Header status on every page; links to `#/wallet`; makes no wallet calls |
| `src/components/AddressDisplay.tsx` | **New.** Short address with the full one in `title`, an accessible label, a "Full address" disclosure, and "Copy full address" (falls back to a message if the clipboard is unavailable) |
| `src/pages/WalletDiagnostics.tsx` | **Rewritten** on the shared context: status, account, wallet network vs expected, wrong-network help, change notes, Connect / Re-check / "Stop showing this account", and a section separating the wallet's network from the read-only data source |
| `src/config/network.ts` | `WRITES_DISABLED_REASON` |
| `src/pages/Dashboard.tsx` | Disabled write controls now give that reason (via `aria-describedby`) |
| `src/components/Layout.tsx`, `src/App.tsx` | Header chip; `<WalletProvider>` around the app |
| `src/styles/global.css` | Chip, small button, callout, address disclosure, visually-hidden |
| `src/test/mockProvider.ts` | **Rewritten.** Configurable mock with real event emission, listener counts, injectable errors; any method outside the three allowed ones throws |
| Tests | `src/wallet/eip1193.test.ts` (rewritten), `src/wallet/walletState.test.ts` (new), `src/pages/WalletDiagnostics.test.tsx` (new), `src/App.test.tsx` (wallet cases moved to the page test; shell cases added) |
| `frontend/README.md` | Wallet section |

**Unchanged:**
- `contracts/vericourt.py` (MD5 `D7E5DFA0…`), the Python tests, the harness;
- `package.json` / `package-lock.json` (no dependency changes; the lockfile was last written during the Phase 3.2 install);
- the Live Check, its gateway, and the display-safety modules.

genlayer-js is not used for wallet connection. Its `client.connect()` requires MetaMask Snaps and adds or switches networks (Phase 3.1), which this phase forbids. The direct EIP-1193 calls above are all that is needed [Code].

## 2. Provider calls

Allowed and used [Code; Mock-enforced]:
- **`eth_chainId`, `eth_accounts`:** passive. Run once on load, on "Re-check wallet", and after a chain-change event.
- **`eth_requestAccounts`:** only from the "Connect wallet" button.
- **Events:** `accountsChanged`, `chainChanged`, `disconnect` listeners.

**Never called:** `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `eth_sendTransaction`, `eth_signTransaction`, `personal_sign`, `eth_signTypedData*`, deploy or contract-write methods.
- The test mock throws on any method outside the allowed three, and every wallet-page test asserts this afterwards.
- The built app chunk contains `eth_requestAccounts` once and none of the forbidden method names (bundle scan).

## 3. State model (`walletReducer`)

**States:** `no_provider`, `checking`, `not_connected`, `connecting`, `connected` (shown as "Connected to StudioNet" or "Connected, wrong network"), `rejected`, `provider_error`, `disconnected`.

How each required state arises:

| Required state | How it arises |
|---|---|
| No compatible wallet | No valid injected provider at mount |
| Detected, not connected | Passive read returns `[]` |
| Connection pending | Connect clicked → `connecting` (button disabled; a second click is ignored) |
| Connected on StudioNet | Valid account + chain `0xf22f` (61999) → `readyForStudioNet: true` |
| Connected on another chain | Valid account + any other valid chain → `readyForStudioNet: false`, wrong-network help |
| Access rejected | `eth_requestAccounts` rejects with code 4001 |
| Provider unavailable or malformed data | Any read failure, a malformed account list or chain ID (from a read or an event), or a provider `disconnect` event. Account and chain are cleared, so nothing unvalidated is shown |
| Disconnected / empty list | `accountsChanged([])`, or a later passive read returning `[]`, after an account was shown |
| Account or chain changed | Immediate update from the event payload, a change note, `accountEpoch` incremented |

**Properties:**
- **Stale results ignored:** every read and superseding event carries an operation number, and a result from an older read is ignored. A slow initial read can't overwrite a newer connection or event (tested).
- **`accountEpoch`:** increments whenever the displayed account or chain changes or is cleared. There is no account-dependent data in the app yet; future views (for example "my cases") must key on it so stale state is dropped.
- **Chain check order:** an account reported before any chain is known is not shown as connected until the chain has been read.

**Forget ("Stop showing this account"):**
- clears the account from the app only, and passive reads and account events no longer re-show it until the user presses Connect again;
- the UI says plainly that VeriCourt cannot revoke the wallet's permission (do that in the wallet's connected-sites settings), and that after a reload VeriCourt will see the account again;
- there is no "disconnect" button that pretends otherwise.

## 4. Events and lifecycle (`WalletProvider`)

- **Detection and listeners:** the provider is detected once per mount. A single `useEffect` registers exactly one listener per event and removes them on unmount. Under React StrictMode's mount, unmount and remount there is still exactly one of each, and none after unmounting [Mock, tested].
- **`accountsChanged`:** the payload is validated and the displayed account updated immediately. No prompt and no repeat of earlier actions. If no chain is known yet, one passive read follows.
- **`chainChanged`:** the payload is validated and applied immediately, so a wrong chain shows as incompatible at once. One `eth_chainId` re-read then confirms it.
  - If no account was known, one passive read of both values is done instead. Writing the reducer tests exposed a stuck "Checking" state in the first version, and the fix is tested.
- **`disconnect`:** shown as a wallet problem, with the account cleared.
- **Retries:** none. "Re-check wallet" is an explicit user action.
- **Wallets without event support:** reported in the UI ("This wallet does not report account or network changes. Use 'Re-check wallet' after changing them."). Nothing is invented.
- **Late results:** results arriving after unmount are dropped.

## 5. Network verification

- The chain shown is read from the **wallet** (`eth_chainId` on the injected provider). It is never inferred from the RPC configuration or the SDK chain [Code].
- **Wrong network:**
  - the page shows an alert with the observed and expected chain IDs, says that VeriCourt will not switch or add networks, and gives manual instructions: select chain ID 61999, RPC `https://studio.genlayer.com/api`, adding it in the wallet's own settings if needed;
  - the header chip shows "Connected, wrong network" on every page [Mock].
- **Kept separate from the data source:** the wallet page explains that VeriCourt reads contract data from the RPC independently. In the real browser [Live], the Live Check passed while the chip correctly stayed "No compatible wallet detected".

## 6. Tests and build

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm test` | **290 passed** in 17 files (Phase 3.3: 230). All network APIs stubbed to throw |
| `npm run build` | Pass. App chunk 268 KB (83 KB gzipped); SDK chunk unchanged at 519 KB, lazy |
| Wallet mutation check (scratch script; files restored byte-for-byte) | 8/8 behaviour mutations caught; the no-op control survived as expected |

**Mutations caught:**
- a prompt on load;
- stale results applied;
- forget ignored;
- any chain treated as StudioNet;
- malformed accounts accepted;
- a listener not removed;
- a chain change not applied immediately;
- rejection not recognised.

**Required cases [Mock]:**

| Case | Test |
|---|---|
| No provider | page and header |
| Empty `eth_accounts` | reducer and page |
| Successful explicit connection | page |
| User rejection | reducer and page |
| Malformed account | reducer (4 shapes) and page |
| Malformed or unsupported chain ID | reducer (`61999`, `"61999"`, `"0xZZ"`, `null`), page, validator table |
| Correct StudioNet / wrong chain | reducer, page, header |
| Account change event | reducer and page |
| Chain change event | reducer and page (immediate change, then re-read) |
| Empty account list after connection | event and passive-read paths |
| Provider error during reads | reducer and page |
| Listener cleanup | unit and StrictMode page test |
| No prompt on initial load | page and app shell (`eth_chainId`, `eth_accounts` only) |
| No transaction, signing, switching or deployment calls | mock throws on them; asserted after every wallet-page test; bundle scan |
| Writes disabled | every route's write-type buttons disabled; Dashboard reason via `aria-describedby`; a connected StudioNet wallet still enables nothing |

## 7. Real wallet

**No injected wallet was available.** The Claude desktop browser pane (Chromium 152) has no `window.ethereum`. The user's real Chrome was deliberately not used: the project rules forbid involving the user's wallet or keys.

**Observed [Live]:**
- "No compatible wallet detected" in the header and on the page, with no wallet buttons;
- the writes-disabled reason;
- no horizontal overflow at desktop or 375 px. The header is 279 px tall on a phone because the navigation wraps, a layout point for later;
- the Phase 3.3 Live Check: 24 steps all `ok`, 23 requests all HTTP 200.

**Everything else** is verified only with mocks:
- connecting, rejection, wrong network, events;
- **real-wallet compatibility (MetaMask, Rabby, Coinbase Wallet, …) is not claimed**.

## 8. Assumptions and limitations

- **[Assumption] EIP-1193 conformance:** the wallet behaves as EIP-1193 specifies: hex `eth_chainId`, an array for `eth_accounts`, code 4001 for rejection, and `accountsChanged` / `chainChanged` payloads in the standard shapes. Deviations are caught as malformed data, not interpreted.
- **[Assumption] One wallet:** a single injected provider (`window.ethereum`). EIP-6963 multi-wallet discovery is not implemented, so with several wallet extensions the one that claims `window.ethereum` is used.
- **Detection timing:** the provider is detected once per page load. A wallet injected after load needs a reload (the page says so).
- **Checksums:** the EIP-55 checksum is not verified (that needs keccak, and adding a dependency wasn't allowed). Addresses are validated by format and shown as returned.
- **Forget isn't persisted:** "Stop showing this account" is not saved. A reload shows the account again, as the UI states.
- **Copy:** depends on `navigator.clipboard`, with a fallback message when it's unavailable.

## 9. Remaining blockers for transaction submission

1. **Phase 3.1 B2:** whether genlayer-js `writeContract` with a browser wallet on StudioNet returns a usable GenLayer transaction ID.
2. **Phase 3.1 B3:** the SDK's static consensus-contract address (`0xb727…`) versus the zero address Studio reports.
3. **Phase 3.1 B9:** whether a real wallet will sign and submit a gasless (0 GEN) transaction on chain 61999. This needs the user to add the network manually.
4. **Real-wallet behaviour is unverified:** events, rejection codes and payloads have only been tested with mocks.
5. **No application deployment**, and no approved write plan (which writes, which accounts, how many).
6. **The write state machine** (Phase 3.2 `tx/state.ts`) is not yet connected to the wallet layer; that wiring is transaction work for a later phase.

## 10. Confirmation

- No transactions, signatures, deployments, network switches or new keys.
- No automatic retries.
- No backend, no dependency changes, no commits.
- No changes to the contract or Python tests.
- Network activity this phase: one read-only Live Check run (23 StudioNet RPC reads), plus loading the local app.
- No wallet calls were made in the real browser; no wallet existed there.
