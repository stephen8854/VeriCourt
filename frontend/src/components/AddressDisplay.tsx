import { useState } from "react";
import { shortAddress } from "../wallet/eip1193";

interface Props {
  address: string;
  label: string;
}

/** Short form for reading, full form available in a disclosure and via copy. */
export function AddressDisplay({ address, label }: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">("idle");

  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      setCopyState("unavailable");
      return;
    }
    clipboard.writeText(address).then(
      () => setCopyState("copied"),
      () => setCopyState("unavailable"),
    );
  };

  return (
    <span className="address">
      <code title={address} aria-label={`${label}: ${address}`}>
        {shortAddress(address)}
      </code>{" "}
      <details className="address__details">
        <summary>Full address</summary>
        <code className="block">{address}</code>
        <button className="button button--small button--secondary" type="button" onClick={copy}>
          Copy full address
        </button>
        <span role="status" className="hint">
          {copyState === "copied" ? " Copied." : copyState === "unavailable" ? " Copying is not available here; select the address text instead." : ""}
        </span>
      </details>
    </span>
  );
}
