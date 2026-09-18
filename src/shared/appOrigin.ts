/**
 * Public marketing and the private wallet workspace intentionally use different
 * origins.  A tab-scoped owner session never crosses this boundary: the public
 * site simply sends a person to the app entry point, where wallet verification
 * happens on the app origin.
 */
export const ARCFX_APP_ORIGIN = "https://app.arcfx.app";

export function appPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "app.arcfx.app") return normalized;
  return `${ARCFX_APP_ORIGIN}${normalized}`;
}

export function isAppOrigin(): boolean {
  return window.location.hostname === "app.arcfx.app" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}
