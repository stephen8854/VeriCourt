/**
 * Gate for the Phase 3.5C write experiment. The ordinary build has no write
 * path at all: the experiment UI is only reachable behind
 * `import.meta.env.MODE === WRITE_EXPERIMENT_MODE`, which Vite replaces with a
 * literal at build time, so the ordinary bundle contains none of it.
 *
 * Even in an experiment-mode build, writes stay off unless ALL hold:
 * 1. the build mode is exactly "write-experiment" (`vite --mode write-experiment`);
 * 2. VITE_VERICOURT_WRITE_EXPERIMENT equals the exact acknowledgement phrase;
 * 3. VITE_VERICOURT_CONTRACT_ADDRESS is a known throwaway TEST deployment;
 * 4. the page is served from this machine (localhost / 127.0.0.1 / [::1]),
 *    so an experiment bundle copied to a server stays inert;
 * 5. the ordinary flag CONTRACT_WRITES_ENABLED is still false (the experiment
 *    never repurposes it; if someone flips it, the experiment refuses).
 * Every failed condition is reported. Pure function; no I/O.
 */
import { CONTRACT_WRITES_ENABLED } from "./network";
import { PHASE_2_17C_NO_REPLY } from "./testDeployments";

export const WRITE_EXPERIMENT_MODE = "write-experiment";
export const WRITE_EXPERIMENT_ACK = "I-UNDERSTAND-THIS-SENDS-ONE-REAL-STUDIONET-TRANSACTION";

/** Contracts the experiment may write to: throwaway test deployments only. */
export const EXPERIMENT_CONTRACTS: readonly `0x${string}`[] = [PHASE_2_17C_NO_REPLY.address];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface WriteGateInput {
  mode: string | undefined;
  ack: string | undefined;
  contract: string | undefined;
  hostname: string | undefined;
  /** Injected for tests; defaults to the real flag. */
  ordinaryWritesFlag?: boolean;
}

export type WriteGate =
  | { enabled: true; contract: `0x${string}` }
  | { enabled: false; reasons: string[] };

export function evaluateWriteGate(input: WriteGateInput): WriteGate {
  const reasons: string[] = [];
  if (input.mode !== WRITE_EXPERIMENT_MODE) reasons.push(`this is not a write-experiment build (mode "${input.mode ?? ""}")`);
  if (input.ack !== WRITE_EXPERIMENT_ACK) reasons.push("VITE_VERICOURT_WRITE_EXPERIMENT does not carry the exact acknowledgement phrase");
  const contract = (input.contract ?? "").trim();
  const known = EXPERIMENT_CONTRACTS.find((c) => c.toLowerCase() === contract.toLowerCase());
  if (known === undefined) reasons.push("VITE_VERICOURT_CONTRACT_ADDRESS is not a known throwaway test deployment");
  if (!LOCAL_HOSTS.has(input.hostname ?? "")) reasons.push(`the page is not served from this machine (host "${input.hostname ?? ""}")`);
  if ((input.ordinaryWritesFlag ?? CONTRACT_WRITES_ENABLED) !== false) reasons.push("CONTRACT_WRITES_ENABLED must stay false; the experiment does not use it");
  return reasons.length === 0 && known !== undefined ? { enabled: true, contract: known } : { enabled: false, reasons };
}
