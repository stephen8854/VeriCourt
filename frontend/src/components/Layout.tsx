import type { ReactNode } from "react";
import { ROUTES, type ParamRoute, type RoutePath } from "../app/routes";
import { WalletStatusChip } from "./WalletStatusChip";

interface Props {
  route: RoutePath | ParamRoute;
  children: ReactNode;
}

export function Layout({ route, children }: Props) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="site-header__inner">
          <a className="wordmark" href="#/">
            <span className="wordmark__mark" aria-hidden="true">
              VC
            </span>
            VeriCourt
          </a>
          <nav className="site-nav" aria-label="Main">
            <ul>
              {ROUTES.map((r) => (
                <li key={r.path}>
                  <a href={`#${r.path}`} aria-current={r.path === route || (r.path === "/app" && (route === "/case" || route === "/report")) ? "page" : undefined}>
                    {r.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <WalletStatusChip />
        </div>
      </header>
      <main id="main" className="site-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="site-footer__inner">
          <p>
            VeriCourt provides AI-assisted assessments of a submitted record. It is not legal advice, a court, or
            arbitration, and it does not hold funds, make payments, issue refunds or enforce anything.
          </p>
        </div>
      </footer>
    </>
  );
}
