import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateWriteGate } from "../config/writeGate";
import { WritePreview } from "../pages/WritePreview";
import { CONNECTED, ENABLED_GATE, fakeStudio, makeDeps } from "../test/experimentHarness";
import { TX_HASH, eventfulWallet, fakeStorage } from "../test/writeHarness";
import { WalletProvider } from "../wallet/WalletContext";
import { DurableWriteSession } from "../write/durableSession";
import { PendingStore } from "../write/pendingStore";
import { memoryLock } from "../write/writeLock";
import { ExperimentWritePanel, fictionalCase } from "./ExperimentWritePanel";
import { submitCreateCase } from "./createCaseFlow";

const INPUT = fictionalCase("2026-10-18T00:00:00");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function harness(walletOpts: Parameters<typeof eventfulWallet>[0] = {}, storage = fakeStorage()) {
  const studio = fakeStudio();
  const wallet = eventfulWallet({
    send: () => {
      studio.accept(INPUT);
      return { result: TX_HASH };
    },
    ...walletOpts,
  });
  const lock = memoryLock();
  const openSession = () => DurableWriteSession.open(new PendingStore(storage), lock);
  const createDeps = async (session: DurableWriteSession) => makeDeps(session, wallet, studio).deps;
  return { studio, wallet, storage, openSession, createDeps };
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  // The panel has no Connect button: connection happens on the Wallet page. Simulate it via the context.
  await user.click(await screen.findByRole("button", { name: "test-connect" }));
}

/** Renders the panel with a tiny Connect trigger wired to the real WalletContext. */
async function renderPanel(h: ReturnType<typeof harness>, gate = ENABLED_GATE) {
  const { useWallet } = await import("../wallet/WalletContext");
  function ConnectButton() {
    const { connect: c } = useWallet();
    return (
      <button type="button" onClick={c}>
        test-connect
      </button>
    );
  }
  render(
    <WalletProvider provider={h.wallet}>
      <ConnectButton />
      <ExperimentWritePanel gate={gate} openSession={h.openSession} createDeps={h.createDeps} input={INPUT} />
    </WalletProvider>,
  );
}

describe("ordinary (non-experiment) build", () => {
  it("the review page shows the disabled preview, not the experiment panel", async () => {
    render(
      <WalletProvider provider={null}>
        <WritePreview />
      </WalletProvider>,
    );
    expect(screen.getByRole("heading", { name: "Transaction review" })).toBeInTheDocument();
    expect(screen.queryByText("Write experiment build")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
  });
});

describe("experiment build, gate disabled", () => {
  it("explains why and never enables the final action", async () => {
    const user = userEvent.setup();
    const h = harness();
    const gate = evaluateWriteGate({ mode: "write-experiment", ack: undefined, contract: undefined, hostname: "127.0.0.1" });
    await renderPanel(h, gate);
    await connect(user);
    expect((await screen.findAllByText(/acknowledgement phrase/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
    expect(h.wallet.sends).toHaveLength(0);
  });
});

describe("experiment build, gate enabled", () => {
  it("requires an explicit Connect in this tab (a remembered account is not enough)", async () => {
    const user = userEvent.setup();
    const h = harness();
    await renderPanel(h);
    await screen.findByText(/Press Connect on the Wallet page/);
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
  });

  it("Connect enables writes even when the wallet emits accountsChanged while connecting (Phase 3.6 live finding)", async () => {
    const user = userEvent.setup();
    const h = harness();
    const inner = h.wallet.request;
    // Like MetaMask: the event fires before eth_requestAccounts resolves.
    h.wallet.request = (async (args: { method: string; params?: unknown[] }) => {
      if (args.method === "eth_requestAccounts") {
        h.wallet.emit("accountsChanged", ["0x" + "1a".repeat(20)]);
        await new Promise((r) => setTimeout(r, 0));
      }
      return inner(args);
    }) as typeof h.wallet.request;
    await renderPanel(h);
    await connect(user);
    await waitFor(() => expect(screen.queryByText(/Press Connect/)).toBeNull());
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
    expect(h.wallet.sends).toHaveLength(0); // enabling the button sends nothing
  });

  it("full flow: review → acknowledge → one wallet request → finality → confirmed case", async () => {
    const user = userEvent.setup();
    const h = harness();
    await renderPanel(h);
    await connect(user);
    await waitFor(() => expect(screen.queryByText(/Press Connect/)).toBeNull());
    expect(screen.getByText(INPUT.title)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Sign in wallet" });
    expect(button).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    await user.dblClick(button);
    expect(await screen.findByRole("region", { name: "Case created and confirmed" })).toHaveTextContent(TX_HASH);
    expect(h.wallet.sends).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Sign in wallet" })).toBeNull();
    // Settled: may be cleared, then a NEW review (fresh acknowledgement) is required.
    await user.click(screen.getByRole("button", { name: "Clear this settled result" }));
    expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
  });

  it("an unresolved write found on load: status, recovery steps and read-only actions only; no review screen", async () => {
    const storage = fakeStorage();
    const h = harness({ send: () => ({ result: "not-a-hash" }) }, storage);
    // Earlier visit: a malformed wallet response left the write uncertain.
    const s = await h.openSession();
    await submitCreateCase(await h.createDeps(s), { gate: ENABLED_GATE, wallet: CONNECTED, input: INPUT, acknowledged: true });
    const user = userEvent.setup();
    await renderPanel(h);
    expect(await screen.findByRole("region", { name: "The write may have been sent" })).toHaveTextContent(/not proof that the write failed/);
    expect(screen.getByText(/Do not try the write again/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in wallet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear this settled result" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Run read-only check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Still unresolved/);
    expect(h.wallet.sends).toHaveLength(1); // only the earlier visit's one request
  });

  it("a refused preflight sends nothing and asks for a new, deliberate review", async () => {
    const user = userEvent.setup();
    const h = harness({ accounts: ["0x" + "1a".repeat(20)] });
    h.studio.reader.gasPrice = async () => "0x5";
    await renderPanel(h);
    await connect(user);
    await waitFor(() => expect(screen.queryByText(/Press Connect/)).toBeNull());
    await user.click(screen.getByRole("checkbox", { name: /cannot be deleted/ }));
    await user.click(screen.getByRole("button", { name: "Sign in wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Nothing was sent.*gas price is not 0/);
    expect(h.wallet.sends).toHaveLength(0);
    expect(screen.getByRole("checkbox", { name: /cannot be deleted/ })).not.toBeChecked();
  });
});
