/**
 * analytics.ts
 * Fetches live protocol data from Arc Testnet and populates analytics.html.
 * Uses ethers.js JsonRpcProvider — read-only, no wallet required.
 */

import { JsonRpcProvider, Contract, formatUnits, Log } from "ethers";

// ── Config ────────────────────────────────────────────────────────────────────

const ARC_RPC = "https://rpc.testnet.arc.network";

const ADDRESSES = {
  USDC:     "0x3600000000000000000000000000000000000000",
  EURC:     "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  PAYMENTS: "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3",
};

// ── ABIs (minimal — only what we need) ────────────────────────────────────────

const ERC20_ABI = [
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const PAYMENTS_ABI = [
  // PaymentExecuted(bytes32 indexed paymentId, address indexed payer,
  //   address indexed recipient, address token, uint256 gross, uint256 fee, uint256 net)
  "event PaymentExecuted(bytes32 indexed paymentId, address indexed payer, address indexed recipient, address token, uint256 gross, uint256 fee, uint256 net)",
];

// ── Provider (read-only, no wallet needed) ────────────────────────────────────

const provider = new JsonRpcProvider(ARC_RPC);

// ── DOM helpers ───────────────────────────────────────────────────────────────

function setText(id: string, val: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setHTML(id: string, val: string): void {
  const el = document.getElementById(id);
  if (el) el.innerHTML = val;
}

function fmtNumber(n: number, decimals = 2): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(decimals)}`;
}

function fmtUsdc(raw: bigint, dec = 6): string {
  const n = Number(formatUnits(raw, dec));
  return fmtNumber(n, 2);
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

// ── Fetch: Network stats ──────────────────────────────────────────────────────

async function fetchNetworkStats(): Promise<void> {
  // Current block
  const latest = await provider.getBlockNumber();
  setText("stat-block", latest.toLocaleString());
  setText("stat-block-sub", `Arc Testnet`);

  // Avg block time — compare last 10 blocks
  try {
    const [blockNow, blockOld] = await Promise.all([
      provider.getBlock(latest),
      provider.getBlock(Math.max(1, latest - 10)),
    ]);
    if (blockNow && blockOld && blockNow.timestamp && blockOld.timestamp) {
      const elapsed = blockNow.timestamp - blockOld.timestamp;
      const avg     = elapsed / 10;
      setText("stat-blocktime", `${avg.toFixed(1)}s`);
    }
  } catch {
    setText("stat-blocktime", "~1.0s");
  }

  // USDC total supply
  try {
    const usdc    = new Contract(ADDRESSES.USDC, ERC20_ABI, provider);
    const supply  = await usdc.totalSupply();
    setText("stat-usdc-supply", fmtUsdc(supply, 6));
  } catch {
    setText("stat-usdc-supply", "—");
  }

  // EURC total supply
  try {
    const eurc   = new Contract(ADDRESSES.EURC, ERC20_ABI, provider);
    const supply = await eurc.totalSupply();
    setText("stat-eurc-supply", fmtUsdc(supply, 6));
  } catch {
    setText("stat-eurc-supply", "—");
  }
}

// ── Fetch: Protocol stats + live feed ────────────────────────────────────────

async function fetchProtocolData(): Promise<void> {
  const latest    = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - 100_000); // last ~100k blocks

  // Fetch PaymentExecuted logs
  let logs: Log[] = [];
  try {
    const iface = new Contract(ADDRESSES.PAYMENTS, PAYMENTS_ABI, provider);
    const filter = {
      address:   ADDRESSES.PAYMENTS,
      fromBlock,
      toBlock:   latest,
      topics: [
        // keccak256("PaymentExecuted(bytes32,address,address,address,uint256,uint256,uint256)")
        "0x" + await computeEventTopic(),
      ],
    };
    logs = await provider.getLogs(filter);
  } catch (err) {
    console.warn("getLogs failed:", err);
  }

  // Parse logs
  interface ParsedTx {
    payer:     string;
    recipient: string;
    token:     string;
    gross:     bigint;
    fee:       bigint;
    net:       bigint;
    blockNum:  number;
    txHash:    string;
  }

  const payments: ParsedTx[] = [];

  for (const log of logs) {
    try {
      // PaymentExecuted log layout:
      // topics[0] = event sig
      // topics[1] = paymentId (indexed bytes32)
      // topics[2] = payer (indexed address)
      // topics[3] = recipient (indexed address)
      // data      = abi.encode(token, gross, fee, net)
      const payer     = "0x" + log.topics[2].slice(26);
      const recipient = "0x" + log.topics[3].slice(26);

      // Decode non-indexed data: address (32 bytes) + uint256 (32 bytes) x3
      const data    = log.data.slice(2); // remove 0x
      const token   = "0x" + data.slice(24, 64);          // first 32 bytes, last 20 = address
      const gross   = BigInt("0x" + data.slice(64, 128));  // bytes 32-64
      const fee     = BigInt("0x" + data.slice(128, 192)); // bytes 64-96
      const net     = BigInt("0x" + data.slice(192, 256)); // bytes 96-128

      payments.push({
        payer, recipient, token, gross, fee, net,
        blockNum: log.blockNumber,
        txHash:   log.transactionHash,
      });
    } catch (e) {
      console.warn("Failed to parse log:", e);
    }
  }

  // ── Protocol stats ────────────────────────────────────────────────────────
  const totalVolume  = payments.reduce((s, p) => s + p.gross, 0n);
  const totalRevenue = payments.reduce((s, p) => s + p.fee, 0n);
  const uniqueWallets = new Set(payments.map(p => p.payer.toLowerCase())).size;
  const avgTrade      = payments.length > 0
    ? Number(formatUnits(totalVolume / BigInt(payments.length), 6))
    : 0;

  setText("stat-volume",    payments.length ? fmtUsdc(totalVolume, 6)  : "$0.00");
  setText("stat-revenue",   payments.length ? fmtUsdc(totalRevenue, 6) : "$0.00");
  setText("stat-wallets",   uniqueWallets.toString());
  setText("stat-avg-trade", payments.length ? `$${avgTrade.toFixed(2)}` : "$0.00");

  // ── Live feed ─────────────────────────────────────────────────────────────
  const feedBody = document.getElementById("feed-body");
  if (!feedBody) return;

  if (payments.length === 0) {
    feedBody.innerHTML = `<tr><td colspan="5" class="feed-empty">No transactions yet · Be the first to use ArcFX Pay</td></tr>`;
    return;
  }

  // Sort newest first, take top 20
  const sorted = [...payments].sort((a, b) => b.blockNum - a.blockNum).slice(0, 20);

  feedBody.innerHTML = sorted.map(tx => {
    const isUSDC  = tx.token.toLowerCase() === ADDRESSES.USDC.toLowerCase();
    const sym     = isUSDC ? "USDC" : "EURC";
    const amount  = Number(formatUnits(tx.gross, 6)).toFixed(4);
    const url     = `https://testnet.arcscan.app/tx/${tx.txHash}`;

    return `
      <tr>
        <td><span class="type-badge badge-pay">Pay</span></td>
        <td><span class="feed-amount">${amount} ${sym}</span></td>
        <td><span class="feed-addr">${shortAddr(tx.payer)}</span></td>
        <td class="hide-sm"><span class="feed-block">${tx.blockNum.toLocaleString()}</span></td>
        <td>
          <a href="${url}" target="_blank" rel="noopener" class="arcscan-link">
            ${shortHash(tx.txHash)} ↗
          </a>
        </td>
      </tr>
    `;
  }).join("");
}

// ── Compute event topic hash ───────────────────────────────────────────────────

async function computeEventTopic(): Promise<string> {
  // keccak256("PaymentExecuted(bytes32,address,address,address,uint256,uint256,uint256)")
  const sig    = "PaymentExecuted(bytes32,address,address,address,uint256,uint256,uint256)";
  const encoder = new TextEncoder();
  const data    = encoder.encode(sig);
  const hash    = await crypto.subtle.digest("SHA-256", data);
  // Use ethers instead — more reliable
  const { id }  = await import("ethers");
  return id(sig).slice(2); // remove 0x, already hex
}

// ── Last updated ──────────────────────────────────────────────────────────────

function updateTimestamp(): void {
  const now = new Date();
  setText("last-updated", now.toLocaleTimeString());
}

// ── Refresh all ───────────────────────────────────────────────────────────────

async function refreshAll(): Promise<void> {
  const btn = document.getElementById("refresh-btn");
  if (btn) btn.classList.add("loading");

  const errBanner = document.getElementById("fetch-error");

  try {
    await Promise.all([
      fetchNetworkStats(),
      fetchProtocolData(),
    ]);
    updateTimestamp();
    if (errBanner) errBanner.style.display = "none";
  } catch (err: any) {
    console.error("Analytics fetch error:", err);
    if (errBanner) {
      errBanner.textContent = `RPC error: ${err.message || "Could not connect to Arc Testnet"}`;
      errBanner.style.display = "block";
    }
  } finally {
    if (btn) btn.classList.remove("loading");
  }
}

// Expose for nav button
(window as any).refreshAll = refreshAll;

// ── Init ──────────────────────────────────────────────────────────────────────

// Initial load
refreshAll();

// Auto-refresh every 15 seconds
setInterval(refreshAll, 15_000);
