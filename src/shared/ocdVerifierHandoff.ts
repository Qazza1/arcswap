/**
 * Hand off one already-sealed ArcFX Agent Evidence bundle to the independent
 * OnChainDiligence verifier. This module deliberately accepts only the bundle:
 * it has no access to ArcFX owner sessions, wallet providers, or API tokens.
 */

export const OCD_VERIFIER_ORIGIN = "https://onchaindiligence.com";
export const OCD_VERIFIER_URL = `${OCD_VERIFIER_ORIGIN}/verify?source=arcfx`;
export const OCD_VERIFIER_PROTOCOL_VERSION = 1;
export const OCD_VERIFIER_WINDOW_TARGET = "_blank";

export type SealedAgentEvidenceBundle = Record<string, unknown>;

interface OcdVerifierWindow {
  closed?: boolean;
  postMessage(message: unknown, targetOrigin: string): void;
}

interface OcdHandoffHost {
  open(url?: string, target?: string, features?: string): OcdVerifierWindow | null;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface OcdVerifierHandoff {
  cancel(): void;
}

export interface OcdProofDownloadHost {
  Blob: typeof Blob;
  URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  document: Pick<Document, "createElement">;
}

function isReadyMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.type === "onchaindiligence:verifier-ready"
    && message.version === OCD_VERIFIER_PROTOCOL_VERSION;
}

/**
 * Open OCD and wait for its verifier-ready signal. The bundle is sent exactly
 * once, only to the exact window ArcFX opened and the exact OCD HTTPS origin.
 */
export function openOcdVerifierHandoff(
  bundle: SealedAgentEvidenceBundle,
  host: OcdHandoffHost = window,
): OcdVerifierHandoff {
  // A fresh browsing context prevents a delayed ready event from a prior
  // verification attempt being reused for a newer proof.
  const verifier = host.open(OCD_VERIFIER_URL, OCD_VERIFIER_WINDOW_TARGET);
  if (!verifier) throw new Error("The verifier window was blocked. Allow pop-ups and try again.");

  let active = true;
  const onMessage = (event: MessageEvent) => {
    if (!active || event.origin !== OCD_VERIFIER_ORIGIN || event.source !== verifier || !isReadyMessage(event.data)) {
      return;
    }

    // No wildcard origin and no ArcFX credentials: only the sealed proof leaves
    // this page. The verifier independently validates the proof after receipt.
    verifier.postMessage({
      type: "onchaindiligence:verify-bundle",
      version: OCD_VERIFIER_PROTOCOL_VERSION,
      source: "arcfx",
      bundle,
    }, OCD_VERIFIER_ORIGIN);
    cancel();
  };

  const cancel = () => {
    if (!active) return;
    active = false;
    host.removeEventListener("message", onMessage);
  };

  host.addEventListener("message", onMessage);
  return { cancel };
}

/** Download the same immutable sealed proof that is handed to OCD. */
export function downloadSealedAgentEvidenceBundle(
  bundle: SealedAgentEvidenceBundle,
  bundleId: string,
  host?: OcdProofDownloadHost,
): void {
  const browser = host ?? { Blob, URL, document };
  const blob = new browser.Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = browser.URL.createObjectURL(blob);
  const link = browser.document.createElement("a");
  link.href = url;
  link.download = `arcfx-agent-evidence-${bundleId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  link.click();
  browser.URL.revokeObjectURL(url);
}
