import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NOTICE_NO_RESPONSE } from "../contract/notices";
import { UNCOMPARED_CITATIONS_NOTE, UNRESOLVED_HEADING } from "../display/citations";
import { fakeGateway, nodeSha256Hex } from "../test/fakeGateway";
import { LiveCheck } from "./LiveCheck";

// Offline: the gateway is the recorded-data fake. These tests prove rendering
// and safety behaviour, not live connectivity.

describe("LiveCheck page", () => {
  it("sends nothing until the user presses the button", () => {
    const load = vi.fn();
    render(<LiveCheck loadGateway={load} sha256Hex={nodeSha256Hex} />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByText("No requests have been sent.")).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("renders recorded-shape data only through the display-safety helpers", async () => {
    const { gateway } = fakeGateway();
    render(<LiveCheck loadGateway={async () => gateway} sha256Hex={nodeSha256Hex} />);
    await userEvent.click(screen.getByRole("button", { name: "Run read-only check" }));
    expect(await screen.findByRole("heading", { name: /Live case/ }, { timeout: 5000 })).toBeInTheDocument();

    const main = document.body;
    expect(main).toHaveTextContent("Assessment recorded");
    expect(main).toHaveTextContent("Final (confirmed by a latest-final read)");
    expect(main).toHaveTextContent(NOTICE_NO_RESPONSE);
    expect(main).toHaveTextContent(UNRESOLVED_HEADING);
    expect(main).toHaveTextContent("a majority of the validators that voted");
    expect(main).toHaveTextContent("Explanation (AI-generated, not independently verified)");
    expect(main).toHaveTextContent("Advisory: AI-generated, not checked by validators");
    expect(main).toHaveTextContent("VeriCourt does not pay, refund, hold or enforce anything.");
    // UNRESOLVED evidence is never labelled as supporting or opposing, nor as overlap-checked.
    expect(main.textContent ?? "").not.toMatch(/Evidence cited for this finding \(each agreeing/);
    expect(main).toHaveTextContent(UNCOMPARED_CITATIONS_NOTE);
    expect(main.textContent ?? "").not.toMatch(/agreeing validators shared at least one item/);
    expect(main.textContent ?? "").not.toMatch(/\bverdict|\bwinner|\bloser/i);
    // No write controls appear.
    for (const b of screen.getAllByRole("button")) expect(b).toHaveTextContent("Run read-only check");
  });

  it("a stopped check shows an explicit state and no case data", async () => {
    const { gateway } = fakeGateway({ chainId: "0x1" });
    render(<LiveCheck loadGateway={async () => gateway} sha256Hex={nodeSha256Hex} />);
    await userEvent.click(screen.getByRole("button", { name: "Run read-only check" }));
    expect(await screen.findByText(/The check stopped at/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Live case/ })).toBeNull();
  });

  it("malformed live data is not rendered as a case", async () => {
    const { gateway } = fakeGateway({
      overrideRead: (m, v) => (m === "get_assessment" && v === "latest-final" ? Promise.resolve({ exists: true }) : undefined),
    });
    render(<LiveCheck loadGateway={async () => gateway} sha256Hex={nodeSha256Hex} />);
    await userEvent.click(screen.getByRole("button", { name: "Run read-only check" }));
    expect(await screen.findByText(/no case data is displayed/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Live case/ })).toBeNull();
  });

  it("a failure to load the SDK is shown, not hidden", async () => {
    render(<LiveCheck loadGateway={() => Promise.reject(new Error("chunk failed"))} sha256Hex={nodeSha256Hex} />);
    await userEvent.click(screen.getByRole("button", { name: "Run read-only check" }));
    expect(await screen.findByText(/Check could not run/)).toBeInTheDocument();
  });
});
