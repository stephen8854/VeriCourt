import { vi } from "vitest";
import { ALLOWED_WALLET_METHODS, type Eip1193Provider } from "../wallet/eip1193";

export const MOCK_ACCOUNT = `0x${"1a".repeat(20)}`;
export const MOCK_ACCOUNT_2 = `0x${"2b".repeat(20)}`;

export interface MockConfig {
  chainId: unknown;
  accounts: unknown;
  /** Result of eth_requestAccounts (default: [MOCK_ACCOUNT]). */
  requested: unknown;
  /** Per-method value to THROW (rejects the request). */
  errors: Partial<Record<string, unknown>>;
}

type Listener = (...args: unknown[]) => void;

/**
 * In-memory EIP-1193 provider. Methods outside the diagnostics/connection set
 * throw, so any attempt to send, sign, switch or add a network fails a test.
 */
export function mockProvider(chainId: unknown = "0xf22f", accounts: unknown = [], overrides: Partial<MockConfig> = {}) {
  const config: MockConfig = { chainId, accounts, requested: [MOCK_ACCOUNT], errors: {}, ...overrides };
  const listeners = new Map<string, Set<Listener>>();
  const request = vi.fn(async ({ method }: { method: string; params?: unknown[] }) => {
    if (!(ALLOWED_WALLET_METHODS as readonly string[]).includes(method)) throw new Error(`forbidden wallet method ${method}`);
    if (method in config.errors) throw config.errors[method];
    if (method === "eth_chainId") return config.chainId;
    if (method === "eth_accounts") return config.accounts;
    return config.requested;
  });
  const on = vi.fn((event: string, listener: Listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)?.add(listener);
  });
  const removeListener = vi.fn((event: string, listener: Listener) => {
    listeners.get(event)?.delete(listener);
  });
  return {
    request,
    on,
    removeListener,
    config,
    emit(event: string, ...args: unknown[]) {
      for (const l of [...(listeners.get(event) ?? [])]) l(...args);
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    methods() {
      return request.mock.calls.map(([args]) => args.method);
    },
  } satisfies Eip1193Provider & Record<string, unknown>;
}

export type MockProvider = ReturnType<typeof mockProvider>;
