import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const payerSource = fs.readFileSync(new URL("../src/payer/main.ts", import.meta.url), "utf8");

const base = {
  id: "inv_live_test",
  network: "arc-mainnet",
  number: "INV-MAINNET-001",
  paymentId: "0x" + "11".repeat(32),
  payTo: "0x1111111111111111111111111111111111111111",
  status: "sent",
  token: "USDC",
  tokenAddress: "0x3600000000000000000000000000000000000000",
  amount: "1.000000",
  amountAtomic: "1000000",
  paid: "0.000000",
  paidAtomic: "0",
  outstanding: "1.000000",
  outstandingAtomic: "1000000",
  dueDate: null,
  note: null,
  issuedAt: "2026-09-17T00:00:00.000Z",
};

test("Mainnet public payer accepts only a coherent authoritative invoice", async (t) => {
  const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const payer = await server.ssrLoadModule("/src/payer/mainnetInvoice.ts");
    const intent = payer.authoritativeMainnetPayment(base);
    assert.equal(intent.network, "arc-mainnet");
    assert.equal(intent.netAtomic, 1000000n);
    assert.equal(intent.tokenAddress.toLowerCase(), base.tokenAddress);
    assert.equal(intent.recipient.toLowerCase(), base.payTo.toLowerCase());
    assert.equal(intent.paymentId, base.paymentId);

    for (const [label, changed] of [
      ["wrong network", { network: "arc-testnet" }],
      ["network null", { network: null }],
      ["wrong token", { tokenAddress: "0x2222222222222222222222222222222222222222" }],
      ["invalid recipient", { payTo: "not-an-address" }],
      ["invalid payment ID", { paymentId: "0x1234" }],
      ["settled invoice", { status: "paid", paidAtomic: "1000000", outstandingAtomic: "0" }],
      ["cancelled invoice", { status: "cancelled" }],
      ["mismatched outstanding", { outstandingAtomic: "999999" }],
    ]) {
      assert.throws(() => payer.authoritativeMainnetPayment({ ...base, ...changed }), Error, label);
    }

    const changedRecipient = payer.authoritativeMainnetPayment({ ...base, payTo: "0x2222222222222222222222222222222222222222" });
    const changedPaymentId = payer.authoritativeMainnetPayment({ ...base, paymentId: "0x" + "22".repeat(32) });
    assert.equal(payer.sameAuthoritativePayment(intent, changedRecipient), false, "recipient substitution is rejected at recheck");
    assert.equal(payer.sameAuthoritativePayment(intent, changedPaymentId), false, "payment ID substitution is rejected at recheck");
  } finally { await server.close(); }
});

test("Mainnet payer uses exact allowance and fee math", async (t) => {
  const server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const payer = await server.ssrLoadModule("/src/payer/mainnetInvoice.ts");
    // Contract-exact: 1_001_503 would net 1_000_001 (one unit overpaid).
    assert.equal(payer.grossForNet(1_000_000n, 15n), 1_001_502n);
    assert.equal(payer.contractNet(1_001_502n, 15n), 1_000_000n);
    assert.equal(payer.allowanceAction(1_001_502n, 1_001_502n), "pay", "sufficient allowance skips approval");
    assert.equal(payer.allowanceAction(1_001_501n, 1_001_502n), "approve", "insufficient allowance requests only the exact gross amount");
    assert.throws(() => payer.allowanceAction(-1n, 1n));
  } finally { await server.close(); }
});

test("payer path keeps approval, payment, and status authority separate", () => {
  assert.match(payerSource, /arcfxWallet\.connectCurrentNetwork\(\)/, "uses the pinned selected provider without a network switch");
  assert.doesNotMatch(payerSource, /window\.ethereum/, "never accesses an unpinned provider");
  const connect = payerSource.slice(payerSource.indexOf("async function connectWallet"), payerSource.indexOf("async function establishWallet"));
  assert.doesNotMatch(connect, /wallet_switchEthereumChain|switchToArcMainnet/, "connecting never changes the wallet network automatically");
  const switchPath = payerSource.slice(payerSource.indexOf("async function switchWalletToMainnet"), payerSource.indexOf("async function approveExact"));
  assert.match(switchPath, /arcfxWallet\.switchToArcMainnet\(\)/, "a user-selected wrong-network action uses the pinned wallet helper");
  assert.doesNotMatch(switchPath, /\.approve\(|\.pay\(/, "network switching cannot request an approval or payment");
  const approval = payerSource.slice(payerSource.indexOf("async function approveExact"), payerSource.indexOf("async function submitPayment"));
  const recheck = payerSource.slice(payerSource.indexOf("async function recheckReviewed"), payerSource.indexOf("const sleep"));
  assert.match(recheck, /await loadAuthoritativeInvoice\(\)/, "rechecks re-read the authoritative invoice");
  assert.match(approval, /await recheckReviewed\(reviewed\)/, "approval rechecks authoritative fields before the wallet prompt");
  assert.match(approval, /token\.approve\(ARC_MAINNET_PAYER\.paymentsAddress, reviewed\.grossAtomic\)/);
  assert.doesNotMatch(approval, /payments\.pay\(/, "approval rejection cannot reach payment");
  const payment = payerSource.slice(payerSource.indexOf("async function submitPayment"));
  assert.match(payment, /await recheckReviewed\(reviewed\)/, "payment rechecks the server record before submit");
  assert.match(payment, /arcfxApi\.publicInvoice\(invoiceId\)/, "and refreshes it after receipt");
  assert.match(payment, /paymentIncluded = true/, "a receipt disables repeated payment attempts in this page");
  assert.doesNotMatch(payment, /status\s*=\s*["']paid/, "the browser never marks an invoice paid");
});
