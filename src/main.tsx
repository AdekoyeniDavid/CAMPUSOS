import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <main className="auth-screen"><section className="auth-card liquid-glass app-load-error" role="alert">
        <p className="profile-kicker">CAMPUSOS</p>
        <h1>CampusOS could not finish loading</h1>
        <p className="auth-subtitle">A page component stopped unexpectedly. Reload to reconnect and try again.</p>
        <button className="primary-button auth-submit" onClick={() => window.location.reload()}>Reload CampusOS</button>
      </section></main>;
    }
    return this.props.children;
  }
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
  }, { once: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
);
