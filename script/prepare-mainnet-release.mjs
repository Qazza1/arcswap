import { bindPublicRoles, loadManifest, writeManifest } from "./mainnet-release.mjs";

// This command handles public addresses only. It never reads or writes signer
// private material. Run it before the final owner review/approval.
const manifest = bindPublicRoles(loadManifest());
writeManifest(manifest);
console.log("Bound reviewed Arc Mainnet owner, treasury, and constructor parameters in the release manifest.");
console.log("No transaction was signed or broadcast.");
