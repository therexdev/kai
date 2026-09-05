"use strict";

/*
 * The web app's service worker — deliberately the smallest one that does the
 * job, because the job is narrow.
 *
 * What was asked for: install Koinos AI to a homescreen and run it without
 * browser chrome. That is the manifest's doing, not this file's. A service
 * worker is here because install prompts have historically required one, and
 * because a PWA that opens to a browser error page when the train goes into a
 * tunnel is a bad first impression.
 *
 * What this worker deliberately does NOT do is cache the application:
 *
 *   - The shell is served `Cache-Control: no-store, private` and is
 *     account-specific. Caching it would put one person's signed-in HTML in a
 *     store the next person on that device could be served from.
 *   - app.js and the API are a matched pair. A cached client talking to a
 *     newer server is the classic PWA failure — everything looks fine and
 *     behaves subtly wrong, and the user cannot tell because there is no
 *     visible "you are stale" state.
 *   - /app/api responses are chats, documents and MONEY. A stale balance
 *     served confidently from a cache is worse than an error.
 *
 * So: navigations go to the network, and if the network is not there the
 * offline page says so honestly. Everything else is not intercepted at all —
 * no respondWith, so the browser does exactly what it would have done without
 * a worker installed. The only thing this file can serve from cache is a
 * static page that says "you're offline".
 */

// Bump to invalidate. The offline page is the only thing in here, so this
// changes about as often as that page does.
const CACHE = "koinos-ai-shell-v1";
const OFFLINE_URL = "/app/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.add(new Request(OFFLINE_URL, { cache: "reload" })))
  );
  // One page, no application state: there is nothing for a half-updated
  // worker to be inconsistent with, so take over straight away rather than
  // leaving the old one live until every tab has closed.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  /*
   * Navigations only. `mode === "navigate"` is the browser asking for a
   * PAGE — it is not set on fetch() calls the app makes, which is exactly the
   * distinction needed here: the API must never come from this worker.
   */
  if (req.mode !== "navigate") return;

  event.respondWith(
    fetch(req).catch(async () => {
      /*
       * Only a genuine network failure lands here. A 401, a redirect to
       * /account, a 500 — all of those RESOLVE, and are passed through
       * untouched, because the server's answer is the truth and this worker
       * has no business editing it. An expired session should show the
       * sign-in page, not "you're offline".
       */
      const cached = await caches.match(OFFLINE_URL);
      return (
        cached ||
        new Response("You're offline.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        })
      );
    })
  );
});
