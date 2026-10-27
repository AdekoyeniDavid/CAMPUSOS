const CACHE_NAME = "campusos-shell-v2";
const APP_SHELL = ["/", "/manifest.webmanifest", "/campusos-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("campusos-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => "focus" in client);
    return existing ? existing.focus() : self.clients.openWindow(event.notification.data?.url || "/");
  }));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() ?? "You have a CampusOS reminder." };
  }
  const title = typeof payload.title === "string" ? payload.title : "CampusOS reminder";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "Open CampusOS to review your reminders.",
    icon: "/campusos-icon.svg",
    badge: "/campusos-icon.svg",
    tag: typeof payload.tag === "string" ? payload.tag : "campusos-reminder",
    renotify: false,
    data: { url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/" },
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: "campusos:refresh" });
    }),
  ]));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && response.headers.get("content-type")?.includes("text/html")) event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put("/", response.clone())));
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match("/")) || Response.error()));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(fetch(request).then((response) => {
      const contentType = response.headers.get("content-type") || "";
      const isAppAsset = contentType.includes("javascript") || contentType.includes("text/css");
      if (response.ok && isAppAsset) event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone())));
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error()));
  }
});
