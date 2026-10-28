import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { ROUTES } from "./app/routes";
import { WRITES_DISABLED_REASON, parseContractAddress } from "./config/network";
import { NOTICE_EXTERNAL_NOT_OPENED, NOTICE_NO_RESPONSE } from "./contract/notices";
import { Dashboard } from "./pages/Dashboard";
import { MOCK_ACCOUNT, mockProvider } from "./test/mockProvider";
import { WalletProvider } from "./wallet/WalletContext";

async function goTo(path: string) {
  await act(async () => {
    window.location.hash = `#${path}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

/** Buttons that would start a contract write if enabled. */
const WRITE_ACTION = /start a case|create|submit|reply|request assessment|process|deadline|open case|send|sign/i;

describe("app shell and navigation", () => {
  it("renders the landing page with the key disclaimers", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Evidence in. A structured, reasoned assessment out.");
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent(/not legal advice, a court judgment or a binding arbitration award/);
    expect(main).toHaveTextContent(/does not escrow or hold funds, pay anyone, issue refunds, or enforce any remedy/);
  });

  it("has a skip link, a labelled main navigation and a current-page marker", async () => {
    render(<App />);
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(ROUTES.map((r) => r.label));
    expect(within(nav).getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");
    await goTo("/wallet");
    expect(within(nav).getByRole("link", { name: "Wallet & network" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "About" })).not.toHaveAttribute("aria-current");
  });

  it.each(ROUTES.map((r) => [r.path]))("route %s renders one h1 and a footer disclaimer", async (path) => {
    render(<App />);
    await goTo(path);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("contentinfo")).toHaveTextContent(/does not hold funds, make payments, issue refunds or enforce anything/);
  });

  it("unknown routes fall back to the landing page", async () => {
    render(<App />);
    await goTo("/no-such-page");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Evidence in/);
  });

  it.each(["/case/VC-000001", "/report/VC-000001"])("%s without a configured contract reads nothing and says why", async (path) => {
    render(<App />);
    await goTo(path);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "No contract to read" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Cases" })).toHaveAttribute("aria-current", "page");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("no enabled contract-write action anywhere", () => {
  it.each(ROUTES.map((r) => [r.path]))("route %s", async (path) => {
    window.ethereum = mockProvider();
    render(<App />);
    await goTo(path);
    for (const button of screen.queryAllByRole("button")) {
      if (WRITE_ACTION.test(button.textContent ?? "")) expect(button).toBeDisabled();
    }
  });

  it("dashboard explains why actions are unavailable and fabricates no cases", () => {
    render(
      <WalletProvider>
        <Dashboard contract={{ status: "unset" }} />
      </WalletProvider>,
    );
    expect(screen.getByRole("button", { name: "Start a case" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open case" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Case ID" })).toBeDisabled();
    expect(screen.getByText(/No VeriCourt contract address is configured/)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(WRITES_DISABLED_REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length).toBe(2);
    expect(screen.getByRole("button", { name: "Start a case" })).toHaveAccessibleDescription(/transaction submission has not been approved/);
    expect(screen.queryByText(/CLAIM_|INCONCLUSIVE|UNRESOLVED/)).toBeNull();
  });

  it("dashboard reports an invalid configured address", () => {
    render(
      <WalletProvider>
        <Dashboard contract={parseContractAddress("0x123")} />
      </WalletProvider>,
    );
    expect(screen.getByText(/configured contract address is not valid/)).toBeInTheDocument();
  });

  it("a connected wallet on StudioNet still enables no write", async () => {
    window.ethereum = mockProvider("0xf22f", [MOCK_ACCOUNT]);
    render(<App />);
    await goTo("/app");
    await waitFor(() => expect(screen.getByRole("link", { name: /Wallet status: Connected to StudioNet/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start a case" })).toBeDisabled();
  });
});

describe("wallet in the app shell", () => {
  it("on initial load: only a passive read, no prompt; header shows the status", async () => {
    const provider = mockProvider("0xf22f", []);
    window.ethereum = provider;
    render(<App />);
    expect(await screen.findByRole("link", { name: /Wallet status: Wallet detected, not connected/ })).toBeInTheDocument();
    expect(provider.methods()).toEqual(["eth_chainId", "eth_accounts"]);
  });

  it("no wallet: header says so and makes no calls", () => {
    render(<App />);
    expect(screen.getByRole("link", { name: /Wallet status: No compatible wallet detected/ })).toBeInTheDocument();
  });

  it("wrong network is visible in the header on every page", async () => {
    window.ethereum = mockProvider("0x1", [MOCK_ACCOUNT]);
    render(<App />);
    await goTo("/limitations");
    expect(await screen.findByRole("link", { name: /Wallet status: Connected, wrong network/ })).toBeInTheDocument();
  });
});

describe("limitations page", () => {
  it("quotes the contract notices verbatim and warns about sensitive data", async () => {
    render(<App />);
    await goTo("/limitations");
    const main = screen.getByRole("main");
    expect(main).toHaveTextContent(NOTICE_NO_RESPONSE);
    expect(main).toHaveTextContent(NOTICE_EXTERNAL_NOT_OPENED);
    expect(main).toHaveTextContent(/Do not submit passwords, private keys, seed phrases/);
    expect(main).toHaveTextContent(/may also be publicly accessible, depending on where and how it is stored/);
  });
});

describe("no network access from the app", () => {
  it("rendering every route makes no fetch call", async () => {
    render(<App />);
    for (const r of ROUTES) await goTo(r.path);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

declare global {
  interface Window {
    ethereum?: unknown;
  }
}
