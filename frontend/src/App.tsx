import { useEffect, useRef } from "react";
import { useLocation, type Location } from "./app/routes";
import { Layout } from "./components/Layout";
import { CaseDetail } from "./pages/CaseDetail";
import { CaseReport } from "./pages/CaseReport";
import { Dashboard } from "./pages/Dashboard";
import { Landing } from "./pages/Landing";
import { Limitations } from "./pages/Limitations";
import { LiveCheck } from "./pages/LiveCheck";
import { WalletDiagnostics } from "./pages/WalletDiagnostics";
import { WritePreview } from "./pages/WritePreview";
import { WalletProvider } from "./wallet/WalletContext";

function Page({ location }: { location: Location }) {
  switch (location.route) {
    case "/app":
      return <Dashboard />;
    case "/case":
      return <CaseDetail key={location.caseId} caseId={location.caseId ?? ""} />;
    case "/report":
      return <CaseReport key={location.caseId} caseId={location.caseId ?? ""} />;
    case "/wallet":
      return <WalletDiagnostics />;
    case "/limitations":
      return <Limitations />;
    case "/live":
      return <LiveCheck />;
    case "/review":
      return <WritePreview query={location.query} />;
    default:
      return <Landing />;
  }
}

export function App() {
  const location = useLocation();
  const first = useRef(true);
  const key = `${location.route}|${location.caseId ?? ""}`;

  useEffect(() => {
    // Move focus to the new page's content on navigation (not on first load).
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById("main")?.focus();
  }, [key]);

  return (
    <WalletProvider>
      <Layout route={location.route}>
        <Page location={location} />
      </Layout>
    </WalletProvider>
  );
}
