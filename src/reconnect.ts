type WatchFactory<T> = (
  next: (value: T) => void,
  error: (reason: unknown) => void,
) => Promise<() => void> | (() => void);

export type ReconnectOptions<T> = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  isHealthy?: (value: T) => boolean;
};

/** Rebuild a live subscription after errors and when a suspended browser resumes. */
export function watchWithReconnect<T>(
  factory: WatchFactory<T>,
  listener: (value: T) => void,
  onError: (error: unknown) => void,
  options: ReconnectOptions<T> = {},
) {
  const initialDelayMs = Math.max(100, options.initialDelayMs ?? 250);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 30_000);
  let retryDelayMs = initialDelayMs;
  let stopped = false;
  let connecting = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let hiddenAt: number | undefined;
  let lastRestartAt = 0;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;

  const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
  const clearRetry = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const clearHealthTimer = () => {
    if (healthTimer !== undefined) clearTimeout(healthTimer);
    healthTimer = undefined;
  };
  const scheduleRetry = (attemptEpoch: number) => {
    if (stopped || !isOnline() || timer !== undefined) return;
    // Small jitter spreads reconnects from multiple listeners after a shared outage.
    const delay = Math.max(100, Math.round(retryDelayMs * (0.8 + Math.random() * 0.2)));
    retryDelayMs = Math.min(retryDelayMs * 2, maxDelayMs);
    timer = setTimeout(() => {
      timer = undefined;
      if (attemptEpoch === epoch) void connect();
    }, delay);
  };

  async function connect() {
    if (stopped || connecting || unsubscribe || !isOnline()) return;
    connecting = true;
    const attemptEpoch = ++epoch;
    let healthy = false;
    try {
      const stop = await factory(
        (value) => {
          if (stopped || attemptEpoch !== epoch) return;
          if (!options.isHealthy || options.isHealthy(value)) {
            healthy = true;
            clearHealthTimer();
            retryDelayMs = initialDelayMs;
          }
          listener(value);
        },
        (error) => {
          if (stopped || attemptEpoch !== epoch) return;
          clearHealthTimer();
          const activeStop = unsubscribe;
          unsubscribe = undefined;
          try { activeStop?.(); } catch { /* A failed subscription is already closed. */ }
          onError(error);
          scheduleRetry(attemptEpoch);
        },
      );
      if (stopped || attemptEpoch !== epoch) stop();
      else {
        unsubscribe = stop;
        // Some browsers can leave a realtime channel open without delivering its
        // first server snapshot. Restart it instead of remaining stuck connecting.
        // A cache-only snapshot is not healthy, so the timer stays active until
        // Firestore confirms that the server has responded.
        if (options.isHealthy && !healthy) {
          healthTimer = setTimeout(() => {
            healthTimer = undefined;
            if (stopped || attemptEpoch !== epoch || healthy) return;
            const activeStop = unsubscribe;
            unsubscribe = undefined;
            try { activeStop?.(); } catch { /* Retry with a fresh realtime channel. */ }
            const retryEpoch = ++epoch;
            onError(new Error("Realtime listener did not receive a server snapshot."));
            scheduleRetry(retryEpoch);
          }, 15_000);
        }
      }
    } catch (error) {
      if (!stopped && attemptEpoch === epoch) {
        onError(error);
        scheduleRetry(attemptEpoch);
      }
    } finally {
      if (attemptEpoch === epoch) connecting = false;
    }
  }

  const resume = () => {
    if (stopped || !isOnline() || connecting || unsubscribe) return;
    clearRetry();
    clearHealthTimer();
    retryDelayMs = initialDelayMs;
    void connect();
  };

  const restart = () => {
    if (stopped || !isOnline()) return;
    // Several lifecycle events can fire together when a mobile app resumes.
    // Collapse them into one listener refresh to avoid duplicate connections.
    const now = Date.now();
    if (now - lastRestartAt < 1_000) return;
    lastRestartAt = now;
    clearRetry();
    clearHealthTimer();
    const activeStop = unsubscribe;
    unsubscribe = undefined;
    epoch += 1;
    connecting = false;
    try { activeStop?.(); } catch { /* Recreate the listener below. */ }
    retryDelayMs = initialDelayMs;
    void connect();
  };

  const onFocus = () => {
    const wasSuspended = hiddenAt !== undefined && Date.now() - hiddenAt >= 15_000;
    hiddenAt = undefined;
    if (wasSuspended) restart();
    else resume();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    hiddenAt = undefined;
    if (event.persisted) restart();
    else resume();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt ??= Date.now();
      return;
    }
    const wasSuspended = hiddenAt !== undefined && Date.now() - hiddenAt >= 15_000;
    hiddenAt = undefined;
    if (wasSuspended) restart();
    else resume();
  };
  const onBlur = () => { hiddenAt ??= Date.now(); };

  const suspend = () => {
    if (stopped) return;
    // Invalidate a subscription that may still be connecting so its eventual handle is closed.
    epoch += 1;
    connecting = false;
    clearRetry();
    clearHealthTimer();
    const activeStop = unsubscribe;
    unsubscribe = undefined;
    try { activeStop?.(); } catch { /* Recreate the listener when the browser reports connectivity again. */ }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", restart);
    window.addEventListener("offline", suspend);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pageshow", onPageShow);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);

  void connect();
  return () => {
    stopped = true;
    epoch += 1;
    clearRetry();
    clearHealthTimer();
    try { unsubscribe?.(); } catch { /* Ignore cleanup failures. */ }
    unsubscribe = undefined;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", restart);
      window.removeEventListener("offline", suspend);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pageshow", onPageShow);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
