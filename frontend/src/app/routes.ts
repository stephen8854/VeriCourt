import { useEffect, useState } from "react";

/** Hash routes keep the app a static bundle (no server routing). These appear in the main navigation. */
export const ROUTES = [
  { path: "/", label: "About" },
  { path: "/app", label: "Cases" },
  { path: "/wallet", label: "Wallet & network" },
  { path: "/live", label: "Live read-only check" },
  { path: "/review", label: "Transaction review (preview)" },
  { path: "/limitations", label: "Limitations & privacy" },
] as const;

export type RoutePath = (typeof ROUTES)[number]["path"];

/** Parameterised routes (not in the navigation): `#/case/VC-000001`, `#/report/VC-000001`. */
export type ParamRoute = "/case" | "/report";

export interface Location {
  route: RoutePath | ParamRoute;
  /** The raw case segment of /case/… or /report/… (validated by the page, never trusted). */
  caseId: string | null;
  /** Query parameters after `?` (e.g. `#/review?action=submit_evidence&case=VC-000003`). */
  query: Readonly<Record<string, string>>;
}

/** Contract case IDs: "VC-" plus the case number zero-padded to at least 6 digits. */
export const CASE_ID_PATTERN = /^VC-\d{6,}$/;

export function isCaseId(value: unknown): value is string {
  return typeof value === "string" && CASE_ID_PATTERN.test(value);
}

export function parseRoute(hash: string): RoutePath {
  const path = hash.replace(/^#/, "").split("?")[0] || "/";
  return (ROUTES.find((r) => r.path === path)?.path ?? "/") as RoutePath;
}

export function parseLocation(hash: string): Location {
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const path = (q === -1 ? raw : raw.slice(0, q)) || "/";
  const query: Record<string, string> = {};
  if (q !== -1) {
    for (const [k, v] of new URLSearchParams(raw.slice(q + 1))) query[k] = v;
  }
  const param = /^\/(case|report)\/([^/]*)$/.exec(path);
  if (param) {
    let id: string;
    try {
      id = decodeURIComponent(param[2] ?? "");
    } catch {
      id = param[2] ?? "";
    }
    return { route: `/${param[1]}` as ParamRoute, caseId: id, query };
  }
  return { route: parseRoute(path), caseId: null, query };
}

export function caseHref(caseId: string): string {
  return `#/case/${encodeURIComponent(caseId)}`;
}

export function reportHref(caseId: string): string {
  return `#/report/${encodeURIComponent(caseId)}`;
}

/** Link to a write action on the review page (the gated experiment build handles it; the ordinary build shows a preview). */
export function actionHref(action: string, caseId?: string): string {
  const q = new URLSearchParams({ action });
  if (caseId !== undefined) q.set("case", caseId);
  return `#/review?${q.toString()}`;
}

export function useLocation(): Location {
  const [loc, setLoc] = useState<Location>(() => parseLocation(window.location.hash));
  useEffect(() => {
    const onChange = () => setLoc(parseLocation(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return loc;
}

export function useHashRoute(): RoutePath | ParamRoute {
  return useLocation().route;
}
