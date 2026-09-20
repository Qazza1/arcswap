/**
 * Step 6H.2: the Mainnet payer grosses up contract-exactly (bigint only) and
 * treats its own confirmed approval as an expected transition, while every
 * authoritative payment input still fails closed when it changes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const payerSource = fs.readFileSync(new URL("../src/payer/main.ts", import.meta.url), "utf8");
const FEE = 15n; // ArcFXPayments.FEE_BPS (deployed, constant)

let server, p;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  p = await server.ssrLoadModule("/src/payer/mainnetInvoice.ts");
});
test.after(async () => { await server?.close(); });

// Independent re-statement of the deployed Solidity: fee = gross*15/10000 (floor).
const solidityNet = (gross) => gross - (gross * FEE) / 10_000n;

function assertExactMinimal(net) {
  const gross = p.grossForNet(net, FEE);
  assert.equal(typeof gross, "bigint");
  assert.equal(solidityNet(gross), net, `net(${gross}) must equal ${net}`);
  assert.equal(p.contractNet(gross, FEE), net);
  if (gross > 1n) assert.ok(solidityNet(gross - 1n) < net, `gross ${gross} must be minimal for ${net}`);
  return gross;
}

test("0.01 USDC invoice: gross 0.010015, fee 0.000015, net exactly 0.010000", () => {
  const gross = assertExactMinimal(10_000n);
  assert.equal(gross, 10_015n);
  assert.equal(p.contractFee(gross, FEE), 15n);
  // The production payment used the old continuous ceiling: 10016 → net 10001.
  assert.equal(solidityNet(10_016n), 10_001n, "the observed 1-unit overpayment is reproduced by the old gross");
});

test("boundaries: tiny, around 9999/10000/10001, 1 USDC, and large values", () => {
  for (const net of [1n, 2n, 3n, 665n, 666n, 667n, 9_998n, 9_999n, 10_000n, 10_001n, 10_002n, 999_999n, 1_000_000n, 1_000_001n,
    123_456_789n, 1_000_000_000_000n, 10n ** 30n, 10n ** 59n]) {
    assertExactMinimal(net);
  }
  assert.equal(p.grossForNet(1_000_000n, FEE), 1_001_502n, "1 USDC");
});

test("every net around fee-floor increments is exact and minimal (exhaustive sweep)", () => {
  // The fee steps every 10000/15 ≈ 666.67 units of gross; sweep many steps.
  for (let net = 1n; net <= 60_000n; net++) assertExactMinimal(net);
  // …and a window at a large magnitude.
  for (let net = 10n ** 18n; net <= 10n ** 18n + 2_000n; net++) assertExactMinimal(net);
});

test("invalid fee configuration and amounts fail closed", () => {
  assert.throws(() => p.grossForNet(0n, FEE));
  assert.throws(() => p.grossForNet(-1n, FEE));
  assert.throws(() => p.grossForNet(1n, 10_000n));
  assert.throws(() => p.grossForNet(1n, -1n));
  assert.equal(p.grossForNet(5n, 0n), 5n, "zero fee grosses to the net itself");
});

// ── Approval transition and stale-data protection ─────────────────────────

const intent = {
  invoiceId: "inv_1", invoiceNumber: "INV-1", network: "arc-mainnet",
  tokenAddress: "0x3600000000000000000000000000000000000000",
  recipient: "0x63c347d7e42b940e79AfEC3D172bFc2921b6c897",
  paymentId: "0x" + "1c".repeat(32), netAtomic: 10_000n, status: "sent",
};
const reviewed = { intent, grossAtomic: 10_015n, feeAtomic: 15n, account: "0x4F81E3939232815e3C98B124A17BaC75304C82D8", chainIdHex: "0x13b2" };
const change = (patch, intentPatch = {}) => ({ ...reviewed, ...patch, intent: { ...intent, ...intentPatch } });

test("an unchanged re-read passes review", () => {
  assert.equal(p.reviewChange(reviewed, change({})), null);
  assert.equal(p.reviewChange(reviewed, change({ account: reviewed.account.toLowerCase(), chainIdHex: "0x13B2" })), null, "case-only differences are not changes");
});

test("allowance increase after ArcFX's own confirmed approval is the expected transition", () => {
  assert.equal(p.allowanceTransition(0n, 10_015n, null), "needs-approval", "insufficient allowance path");
  assert.equal(p.allowanceTransition(10_015n, 10_015n, 10_015n), "approval-confirmed");
  assert.equal(p.allowanceTransition(50_000n, 10_015n, null), "already-sufficient", "already-sufficient path is surfaced for review, not an error");
  assert.equal(p.allowanceTransition(10_015n, 10_015n, 10_016n), "already-sufficient", "an approval for a different gross is not treated as ours");
  assert.equal(p.allowanceTransition(10_014n, 10_015n, 10_015n), "needs-approval", "a short allowance still needs approval");
});

test("invoice, amount, token, recipient, payment ID, gross, account, and network mutations fail closed", () => {
  const cases = [
    [change({}, { invoiceId: "inv_2" }), /invoice changed/],
    [change({}, { network: "arc-testnet" }), /invoice changed/],
    [change({}, { netAtomic: 9_000n }), /outstanding amount changed/],
    [change({}, { tokenAddress: "0x2222222222222222222222222222222222222222" }), /token changed/],
    [change({}, { recipient: "0x2222222222222222222222222222222222222222" }), /recipient changed/],
    [change({}, { paymentId: "0x" + "22".repeat(32) }), /payment ID changed/],
    [change({ grossAtomic: 10_016n }), /payment amount or fee changed/],
    [change({ feeAtomic: 16n }), /payment amount or fee changed/],
    [change({ account: "0x1111111111111111111111111111111111111111" }), /account changed/],
    [change({ chainIdHex: "0x4cef52" }), /network changed/],
  ];
  for (const [latest, reason] of cases) assert.match(p.reviewChange(reviewed, latest) || "", reason);
});

test("payer source: exact approval only, reviewed values reach pay(), one payment per page", () => {
  const approval = payerSource.slice(payerSource.indexOf("async function approveExact"), payerSource.indexOf("async function submitPayment"));
  const payment = payerSource.slice(payerSource.indexOf("async function submitPayment"));
  assert.match(approval, /token\.approve\(ARC_MAINNET_PAYER\.paymentsAddress, reviewed\.grossAtomic\)/, "approves exactly the reviewed gross");
  assert.doesNotMatch(payerSource, /MaxUint256|2n \*\* 256n|ffffffffffffffff/i, "never an unlimited approval");
  assert.match(approval, /allowanceTransition\(allowance, reviewed\.grossAtomic, approvedGross\)/);
  assert.doesNotMatch(approval, /USDC allowance changed\. Reloaded data must be reviewed/, "the expected allowance increase is no longer reported as an error");
  assert.match(approval, /Approval confirmed\. Review the payment and click Pay\./);
  assert.doesNotMatch(approval, /payments\.pay\(/, "approval never submits the payment");
  assert.match(payment, /if \(paymentIncluded\) return;/, "a page that saw a payment included never submits another");
  assert.match(payment, /if \(busy \|\|/, "a click during an in-flight action is ignored");
  assert.match(payment, /payments\.pay\(reviewed\.intent\.tokenAddress, reviewed\.intent\.recipient, reviewed\.grossAtomic, reviewed\.intent\.paymentId\)/, "only reviewed values reach pay()");
  assert.match(payerSource, /BigInt\(quote\.net\) !== intent\.netAtomic/, "the contract quote must net exactly the outstanding amount");
  assert.doesNotMatch(payerSource.slice(payerSource.indexOf("async function readQuote"), payerSource.indexOf("async function readAllowance")), /Number\(/, "no JS Number in atomic math");
});

test("wallet listener: silent restore is not an error, but a change after connecting still clears the review", () => {
  const listener = payerSource.slice(payerSource.indexOf("arcfxWallet.onChange((state) => {"), payerSource.indexOf("void (async () => {"));
  assert.match(listener, /if \(!signerAddress\) return;/, "no false 'network changed' notice before a signer is established");
  assert.match(listener, /provider = null; signerAddress = null; grossAtomic = null; feeAtomic = null; allowance = null; approvedGross = null;/, "a real change clears every reviewed value");
  assert.match(listener, /signerAddress\.toLowerCase\(\) !== state\.address\?\.toLowerCase\(\)/, "account change still invalidates");
  assert.match(listener, /state\.chainId\?\.toLowerCase\(\) !== ARC_MAINNET_PAYER\.chainIdHex/, "chain change still invalidates");
});

test("a successful connect or network switch clears its transient progress notice", () => {
  for (const [start, end] of [["async function connectWallet", "async function establishWallet"], ["async function switchWalletToMainnet", "async function approveExact"]]) {
    const body = payerSource.slice(payerSource.indexOf(start), payerSource.indexOf(end));
    assert.match(body, /await establishWallet\([^)]*\);\s*notice = undefined;/, `${start} clears the stale notice`);
  }
});
