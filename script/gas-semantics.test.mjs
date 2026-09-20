/**
 * Step 7A: on Arc the native gas token is USDC (18 decimals) and the ERC-20 at
 * 0x3600… reports the SAME funds at 6 decimals. A payment and its network fee
 * come out of one balance, so the wallet must be able to cover both.
 *
 * Numbers below were read live from Arc Mainnet on 2026-09-20 (owner-session
 * wallet 0x63c3…c897): eth_getBalance 112830384026872152 wei, USDC.balanceOf
 * 112830, USDC.transfer gas estimate 49326, maxFeePerGas 40445768076 wei.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const OWNER = "0x63c347d7e42b940e79AfEC3D172bFc2921b6c897";
const BOB = "0x2222222222222222222222222222222222222222";
const MAINNET = "0x13b2";
const NATIVE = 112830384026872152n; // wei-style, 18 decimals
const ERC20 = 112830n; // atomic, 6 decimals: floor(NATIVE / 1e12)
const TRANSFER_FEE = 49326n * 40445768076n; // 1_995_027_956_116_776 wei ≈ 0.001995 USDC
const source = fs.readFileSync(new URL("../src/workspace/payments.ts", import.meta.url), "utf8");

let server, pay, send, ms;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  pay = await server.ssrLoadModule("/src/workspace/mainnetPayments.ts");
  send = await server.ssrLoadModule("/src/workspace/sendCore.ts");
  ms = await server.ssrLoadModule("/src/workspace/multisendCore.ts");
});
test.after(async () => { await server?.close(); });

const wallet = (patch = {}) => ({ account: OWNER, chainIdHex: MAINNET, balanceAtomic: ERC20, nativeWei: NATIVE, ...patch });
const addr = (i) => "0x" + (0x1000 + i).toString(16).padStart(40, "0");

test("live relationship: ERC-20 balance is the native balance at 6 decimals, floored", () => {
  assert.equal(NATIVE / pay.NATIVE_PER_ATOMIC, ERC20);
  assert.equal(NATIVE % pay.NATIVE_PER_ATOMIC, 384026872152n, "the sub-micro remainder is dust the ERC-20 view cannot show");
  assert.equal(pay.NATIVE_PER_ATOMIC, 10n ** 12n);
});

test("native amounts format exactly at 6 decimals", () => {
  assert.equal(pay.formatNative(NATIVE), "0.112830");
  assert.equal(pay.formatNative(TRANSFER_FEE), "0.001995");
  assert.equal(pay.formatNative(6841596011475001224n), "6.841596");
  assert.equal(pay.formatNative(1n), "< 0.000001");
  assert.equal(pay.formatNative(0n), "0.000000");
});

test("the payment plus the network fee must fit in one balance", () => {
  // 0.11 USDC + fee fits; 0.111 USDC passes the ERC-20 check but cannot pay the fee.
  assert.equal(pay.feeBlocker(NATIVE, 110_000n, TRANSFER_FEE), null);
  const blocked = pay.feeBlocker(NATIVE, 111_000n, TRANSFER_FEE);
  assert.match(blocked, /cannot cover 0\.111 USDC plus the network fee \(about 0\.001995 USDC\)\. Arc pays network fees in USDC from the same balance, and you have 0\.112830 USDC/);
  // Sending the entire ERC-20 balance can never work: nothing is left for gas.
  assert.ok(pay.feeBlocker(NATIVE, ERC20, TRANSFER_FEE));
  assert.ok(pay.feeBlocker(NATIVE, ERC20, 0n) === null || NATIVE >= ERC20 * pay.NATIVE_PER_ATOMIC, "without a fee only the dust remainder is spare");
  // Unknown values claim nothing.
  assert.equal(pay.feeBlocker(null, 111_000n, TRANSFER_FEE), null);
  assert.equal(pay.feeBlocker(undefined, 111_000n, TRANSFER_FEE), null);
  assert.match(pay.feeBlocker(NATIVE, 200_000n, null), /cannot cover 0\.20 USDC\. Arc pays network fees in USDC/);
});

test("Send: an amount within the ERC-20 balance but not within balance + fee is refused before review", () => {
  const input = { recipient: BOB, amount: "0.111" };
  const noFeeYet = send.buildSendReview(input, wallet());
  assert.equal(noFeeYet.blocker, null, "without a fee estimate only the amount is checked");
  const withFee = send.buildSendReview(input, wallet(), TRANSFER_FEE);
  assert.match(withFee.blocker, /plus the network fee/);
  assert.equal(withFee.review, undefined);
  const ok = send.buildSendReview({ recipient: BOB, amount: "0.01" }, wallet(), TRANSFER_FEE);
  assert.equal(ok.blocker, null);
  assert.equal(ok.review.feeEstimateWei, TRANSFER_FEE);
  assert.equal(ok.review.amountAtomic, 10_000n);
});

test("Send: the fee check is repeated immediately before the wallet prompt", async () => {
  const review = send.buildSendReview({ recipient: BOB, amount: "0.10" }, wallet(), TRANSFER_FEE).review;
  assert.ok(review);
  const run = async (nativeWei) => {
    const calls = { submit: 0 }; const states = [];
    const exec = send.createSendExecutor({
      readWallet: async () => wallet({ nativeWei }),
      live: () => ({ recipient: BOB, amountAtomic: 100_000n }),
      submit: async () => { calls.submit++; return { hash: "0x" + "ab".repeat(32), wait: async () => ({ status: 1, blockNumber: 1 }) }; },
      onState: (s) => states.push(s),
    });
    await exec(review);
    return { calls, states };
  };
  const enough = await run(NATIVE);
  assert.equal(enough.calls.submit, 1);
  // Another transaction spent gas in the meantime: native balance no longer covers amount + fee.
  const drained = await run(100_000n * pay.NATIVE_PER_ATOMIC + TRANSFER_FEE - 1n);
  assert.equal(drained.calls.submit, 0);
  assert.match(drained.states.at(-1).reason, /cannot cover 0\.10 USDC plus the network fee/);
});

test("Multisend: batch debit plus the next step's fee must fit in the same balance", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ line: i + 1, recipient: addr(i), amount: "0.018" })); // 0.108 + 0.000108 fee = 0.108108
  const batch = ms.buildBatch(rows, { sender: OWNER });
  assert.equal(batch.pullAtomic, 108_108n);
  const w = { ...wallet(), allowanceAtomic: 0n };
  assert.equal(ms.buildBatchReview(batch, w).blocker, null, "the ERC-20 balance alone would allow it");
  const blocked = ms.buildBatchReview(batch, w, 5_000_000_000_000_000n);
  assert.match(blocked.blocker, /cannot cover 0\.108108 USDC plus the network fee \(about 0\.005000 USDC\)/);
  const fits = ms.buildBatchReview(batch, w, 1_000_000_000_000_000n);
  assert.equal(fits.blocker, null);
  assert.equal(fits.review.feeEstimateWei, 1_000_000_000_000_000n);
});

test("Multisend: execution re-checks balance plus the refreshed batch fee", async () => {
  const rows = [{ line: 1, recipient: addr(1), amount: "0.05" }, { line: 2, recipient: addr(2), amount: "0.05" }];
  const batch = ms.buildBatch(rows, { sender: OWNER });
  const review = { ...ms.buildBatchReview(batch, { ...wallet(), allowanceAtomic: 100_000n }, 1_000_000_000_000_000n).review };
  const run = async (nativeWei) => {
    let executed = 0; const states = [];
    const exec = ms.createBatchExecutor({
      readWallet: async () => ({ ...wallet({ nativeWei }), allowanceAtomic: 100_000n }),
      live: () => batch,
      approve: async () => { throw new Error("unexpected"); },
      execute: async () => { executed++; return { hash: "0x" + "bb".repeat(32), wait: async () => ({ status: 1, blockNumber: 2 }) }; },
      onState: (s) => states.push(s),
    });
    await exec.execute(review);
    return { executed, states };
  };
  assert.equal((await run(NATIVE)).executed, 1);
  // The refreshed (post-approval) batch estimate is larger than the earlier one and no longer fits.
  review.feeEstimateWei = 20_000_000_000_000_000n;
  const short = await run(NATIVE);
  assert.equal(short.executed, 0);
  assert.match(short.states.at(-1).reason, /plus the network fee/);
});

test("UI source: the native balance is read, fees come from simulation (never guessed as zero), and the review says they share a balance", () => {
  assert.match(source, /provider\.getBalance\(identity\.account\)/);
  assert.match(source, /Arc's native token is USDC/);
  assert.match(source, /Estimated total from your wallet/);
  assert.match(source, /Estimated balance after/);
  assert.match(source, /return price === null \|\| price === undefined \? null : gas \* price/);
  assert.match(source, /catch \{ return null; \}/, "an estimate failure is null (unavailable), not zero");
  assert.doesNotMatch(source, /nativeFmt/, "one exact native formatter, shared");
  assert.match(source, /walletBlocker\(snapshot, prepared\.amountAtomic, feeWei\)/, "Send blocks review when amount + fee does not fit");
  assert.match(source, /batchWalletBlocker\(wallet, prepared\.pullAtomic, nextFee\)/, "Multisend blocks review when debit + fee does not fit");
  assert.match(source, /void refreshBatchFee\(\)/, "the batch fee is re-estimated once the approval is in place");
});
