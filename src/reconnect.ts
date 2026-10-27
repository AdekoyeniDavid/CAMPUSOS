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

  const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
  const clearRetry = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
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
    try {
      const stop = await factory(
        (value) => {
          if (stopped || attemptEpoch !== epoch) return;
          if (!options.isHealthy || options.isHealthy(value)) retryDelayMs = initialDelayMs;
          listener(value);
        },
        (error) => {
          if (stopped || attemptEpoch !== epoch) return;
          const activeStop = unsubscribe;
          unsubscribe = undefined;
          try { activeStop?.(); } catch { /* A failed subscription is already closed. */ }
          onError(error);
          scheduleRetry(attemptEpoch);
        },
      );
      if (stopped || attemptEpoch !== epoch) stop();
      else unsubscribe = stop;
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
    retryDelayMs = initialDelayMs;
    void connect();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);

  void connect();
  return () => {
    stopped = true;
    epoch += 1;
    clearRetry();
    try { unsubscribe?.(); } catch { /* Ignore cleanup failures. */ }
    unsubscribe = undefined;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resume);
  };
}
