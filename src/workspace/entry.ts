import "../shared/appShell.css";
import { arcfxWallet } from "../shared/wallet";
import { arcfxApi } from "../shared/arcfxApi";
import { appPath } from "../shared/appOrigin";

const root = document.getElementById("entry-root");
if (!root) throw new Error("Missing app entry root.");
document.body.classList.add("app-workspace");

function render(message = "") {
  const state = arcfxWallet.state;
  const wrong = state.connected && state.chainId?.toLowerCase() !== "0x13b2";
  root.innerHTML = `<main class="entry-page" aria-labelledby="entry-title"><a class="app-skip" href="#entry-title">Skip to content</a><section class="entry-card">
    <img class="entry-logo" src="/arcfx-logo-transparent.png" alt="ArcFX" />
    <p class="entry-eyebrow">Private workspace</p><h1 id="entry-title">Open your ArcFX workspace.</h1>
    <p class="entry-copy">Connect the wallet that owns your records. ArcFX verifies wallet ownership on this app origin and keeps ordinary navigation free of repeat signatures.</p>
    <div class="entry-network"><span></span> Arc Mainnet · Chain 5042</div>
    ${message ? `<p class="entry-message" role="status">${message}</p>` : ""}
    <button class="entry-primary" id="entry-action" type="button">${wrong ? "Switch to Arc Mainnet" : state.connected ? "Verify wallet ownership" : "Connect wallet"}</button>
    <p class="entry-note">A wallet signature proves ownership for your ArcFX session. It is not a transaction, payment authorization, or request to move funds.</p>
    <a class="entry-back" href="https://www.arcfx.app/">Back to ArcFX</a>
  </section></main>`;
  document.getElementById("entry-action")?.addEventListener("click", () => void proceed());
}

async function proceed() {
  try {
    if (!arcfxWallet.connected) {
      await arcfxWallet.connectCurrentNetwork();
      if (arcfxWallet.chainId?.toLowerCase() !== "0x13b2") {
        render("Your selected wallet is not on Arc Mainnet. Select “Switch to Arc Mainnet” to continue.");
        return;
      }
    }
    if (arcfxWallet.chainId?.toLowerCase() !== "0x13b2") {
      const switched = await arcfxWallet.switchToArcMainnet();
      if (!switched) throw new Error("Arc Mainnet was not selected. No workspace action was taken.");
    }
    if (arcfxWallet.chainId?.toLowerCase() !== "0x13b2") {
      render("Your selected wallet is not on Arc Mainnet. Switch it explicitly to continue.");
      return;
    }
    await arcfxApi.connectReceivablesOwner();
    window.location.assign(appPath("/dashboard"));
  } catch (error) {
    render(error instanceof Error ? error.message : "Could not open this workspace.");
  }
}

arcfxWallet.onChange(() => render());
// Existing same-origin sessions can continue to the dashboard without a new prompt.
void arcfxApi.hasReceivablesOwnerSession().then((hasSession) => {
  if (hasSession) window.location.replace(appPath("/dashboard"));
  else render();
});
