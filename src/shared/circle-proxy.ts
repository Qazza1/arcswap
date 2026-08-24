/**
 * Route Circle API calls through our own origin.
 *
 * api.circle.com does not send CORS headers for browser origins, so requests
 * from the page are rejected. vercel.json rewrites /circle-proxy/* to
 * https://api.circle.com/* — this patch rewrites the URL so the SDK's own
 * fetch calls take that path without the SDK knowing about it.
 *
 * This was an inline <script> in trade.html. It had to move out so the page
 * needs no 'unsafe-inline' in script-src, and it has to run before any Circle
 * SDK code issues a request — which is why main.ts imports it on the FIRST
 * line: ES module imports are evaluated in source order, so this patch is
 * installed before @circle-fin/app-kit is even initialised.
 */
const original = window.fetch.bind(window);

window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof input === "string" && input.includes("api.circle.com")) {
    input = input.replace("https://api.circle.com", "/circle-proxy");
  } else if (input instanceof Request && input.url.includes("api.circle.com")) {
    input = new Request(input.url.replace("https://api.circle.com", "/circle-proxy"), input);
  }
  return original(input as RequestInfo, init);
};

export {};
