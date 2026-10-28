import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

/** No test may reach any network: every network API fails loudly. */
function refuse(name: string) {
  return () => {
    throw new Error(`Network access attempted in a test (${name})`);
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(refuse("fetch")));
  vi.stubGlobal("XMLHttpRequest", vi.fn(refuse("XMLHttpRequest")));
  vi.stubGlobal("WebSocket", vi.fn(refuse("WebSocket")));
  vi.stubGlobal("EventSource", vi.fn(refuse("EventSource")));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  delete (window as { ethereum?: unknown }).ethereum;
});
