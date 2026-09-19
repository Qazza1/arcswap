/**
 * Public marketing and the private wallet workspace intentionally use different
 * origins.  A tab-scoped owner session never crosses this boundary: the public
 * site simply sends a person to the app entry point, where wallet verification
 * happens on the app origin.
 */
export const ARCFX_APP_ORIGIN = "https://app.arcfx.app";

// Vercel preview deployments of this project (team-scoped hostnames). A preview
// is its own origin with its own tab-scoped session, so app links must stay on
// it rather than jumping to production.
const PREVIEW_HOST = /^arcswap-[a-z0-9-]+-qazza-s-projects\.vercel\.app$/;

function appHost(host: string): boolean {
  return host === "app.arcfx.app" || host === "localhost" || host === "127.0.0.1" || PREVIEW_HOST.test(host);
}

export function appPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (appHost(window.location.hostname)) return normalized;
  return `${ARCFX_APP_ORIGIN}${normalized}`;
}

export function isAppOrigin(): boolean {
  return appHost(window.location.hostname);
}
