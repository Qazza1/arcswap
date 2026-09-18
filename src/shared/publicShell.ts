import "./publicShell.css";

const PUBLIC_ORIGIN = "https://www.arcfx.app";
const APP_ENTRY = "https://app.arcfx.app/entry";

/**
 * The marketing and documentation surfaces deliberately share one small shell.
 * It contains no wallet state: the app origin owns connection and verification.
 */
export function mountPublicShell(): void {
  document.body.classList.add("public-site");
  document.getElementById("arcfx-stats-bar")?.remove();

  const header = document.getElementById("arcfx-nav");
  if (header) {
    header.className = "public-header";
    header.innerHTML = `<div class="public-wrap public-header-row">
      <a class="public-brand" href="${PUBLIC_ORIGIN}/" aria-label="ArcFX homepage"><img src="/arcfx-logo-transparent.png" alt="ArcFX" /></a>
      <nav class="public-nav-links" aria-label="Primary navigation">
        <a href="${PUBLIC_ORIGIN}/#product">Product</a><a href="${PUBLIC_ORIGIN}/#invoicing">Invoicing</a><a href="${PUBLIC_ORIGIN}/#payments">Payments</a><a href="${PUBLIC_ORIGIN}/security">Security</a><a href="${PUBLIC_ORIGIN}/developers">Developers</a><a href="${PUBLIC_ORIGIN}/pricing">Pricing</a>
      </nav>
      <a class="public-open-app" href="${APP_ENTRY}">Open ArcFX <span aria-hidden="true">→</span></a>
    </div>`;
  }

  if (!document.querySelector(".public-footer")) {
    const footer = document.createElement("footer");
    footer.className = "public-footer";
    footer.innerHTML = `<div class="public-wrap public-footer-row"><div><a class="public-footer-brand" href="${PUBLIC_ORIGIN}/" aria-label="ArcFX homepage"><img src="/arcfx-logo-transparent.png" alt="ArcFX" /></a><p>Wallet-first financial operations on Arc Mainnet.</p></div><nav aria-label="Footer navigation"><a href="${PUBLIC_ORIGIN}/security">Security</a><a href="${PUBLIC_ORIGIN}/developers">Developers</a><a href="${PUBLIC_ORIGIN}/pricing">Pricing</a><a href="${APP_ENTRY}">Open ArcFX</a></nav></div>`;
    document.body.append(footer);
  }
}
