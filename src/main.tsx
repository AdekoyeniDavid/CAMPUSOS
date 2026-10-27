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
  const dirtyForms = new WeakSet<HTMLFormElement>();
  const refreshStorageKey = "campusos-reconnect-build";
  let deployedBuild: string | null = null;
  let refreshTimer = 0;
  let refreshing = false;

  const formFor = (target: EventTarget | null) => target instanceof HTMLElement ? target.closest("form") : null;
  const markFormDirty = (event: Event) => {
    const form = formFor(event.target);
    if (form) dirtyForms.add(form);
  };
  const markFormClean = (event: Event) => {
    const form = formFor(event.target);
    if (form) dirtyForms.delete(form);
    scheduleAutomaticRefresh();
  };
  const hasUnsavedForm = () => Array.from(document.forms).some((form) => dirtyForms.has(form));
  const currentBuild = () => {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? "";
    const styles = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')).map((link) => link.href).sort();
    return { script, styles };
  };
  const scheduleAutomaticRefresh = () => {
    if (!deployedBuild || refreshing || hasUnsavedForm()) return;
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      if (!deployedBuild || hasUnsavedForm()) return;
      try { sessionStorage.setItem(refreshStorageKey, deployedBuild); } catch { /* Refresh is still safe without this loop guard. */ }
      refreshing = true;
      window.location.reload();
    }, document.visibilityState === "hidden" ? 250 : 100);
  };
  const checkForDeployedBuild = async () => {
    if (!navigator.onLine || refreshing) return;
    try {
      const response = await fetch("/", { cache: "no-store", credentials: "same-origin", headers: { Accept: "text/html" } });
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return;
      const html = await response.text();
      const remoteDocument = new DOMParser().parseFromString(html, "text/html");
      const remoteScriptPath = remoteDocument.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
      if (!remoteScriptPath) return;
      const remoteScript = new URL(remoteScriptPath, location.origin).href;
      const remoteStyles = Array.from(remoteDocument.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'))
        .map((link) => new URL(link.getAttribute("href") ?? "", location.origin).href).sort();
      const remoteSignature = JSON.stringify({ script: remoteScript, styles: remoteStyles });
      const loaded = currentBuild();
      const loadedSignature = JSON.stringify(loaded);
      if (remoteSignature === loadedSignature) {
        deployedBuild = null;
        try { sessionStorage.removeItem(refreshStorageKey); } catch { /* Session storage is optional. */ }
        return;
      }
      let lastAttemptedBuild: string | null = null;
      try { lastAttemptedBuild = sessionStorage.getItem(refreshStorageKey); } catch { /* Session storage is optional. */ }
      if (lastAttemptedBuild === remoteSignature) return;
      deployedBuild = remoteSignature;
      if (hasUnsavedForm()) return;
      scheduleAutomaticRefresh();
    } catch {
      // Keep the cached app running; the next online/visible event retries this check.
    }
  };

  document.addEventListener("input", markFormDirty, true);
  document.addEventListener("change", markFormDirty, true);
  document.addEventListener("reset", markFormClean, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") scheduleAutomaticRefresh();
    else if (navigator.onLine) {
      void checkForDeployedBuild();
      void navigator.serviceWorker.ready.then((registration) => registration.update()).catch(() => undefined);
    }
  });
  new MutationObserver(() => scheduleAutomaticRefresh()).observe(document.documentElement, { childList: true, subtree: true });

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type === "campusos:refresh") {
      void checkForDeployedBuild();
      void navigator.serviceWorker.ready.then((registration) => registration.update()).catch(() => undefined);
    }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (navigator.onLine) void checkForDeployedBuild();
  });

  window.addEventListener("online", () => {
    void checkForDeployedBuild();
    void navigator.serviceWorker.ready.then((registration) => registration.update()).catch(() => undefined);
  });
  window.setInterval(() => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    void checkForDeployedBuild();
    void navigator.serviceWorker.ready.then((registration) => registration.update()).catch(() => undefined);
  }, 60_000);
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js").then((registration) => {
      if (navigator.onLine) {
        void registration.update().catch(() => undefined);
        void checkForDeployedBuild();
      }
    }).catch(() => undefined);
  }, { once: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
);
