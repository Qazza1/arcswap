/**
 * analytics.ts — Live Arc Testnet data via RPC + ArcScan API
 */

import { JsonRpcProvider, Contract, formatUnits, id as keccak256id } from "ethers";

const ARC_RPC      = "https://rpc.testnet.arc.network";
const ARCSCAN_API  = "https://testnet.arcscan.app/api/v2";

const ADDR = {
  USDC:        "0x3600000000000000000000000000000000000000",
  EURC:        "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  PAYMENTS:    "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3",
  MULTISENDER: "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398",
};

const PAYMENT_TOPIC = keccak256id(
  "PaymentExecuted(bytes32,address,address,address,uint256,uint256,uint256)"
);

const ERC20_ABI = ["function totalSupply() view returns (uint256)"];
const provider  = new JsonRpcProvider(ARC_RPC);

// ── DOM helpers ───────────────────────────────────────────────────────────

const el  = (id: string) => document.getElementById(id);
const txt = (id: string, val: string) => { const n = el(id); if (n) n.textContent = val; };

function fmtSupply(raw: bigint, dec = 6): string {
  const n = Number(formatUnits(raw, dec));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

function fmtUSD(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function short(addr: string): string  { return `${addr.slice(0,8)}…${addr.slice(-6)}`; }
function shortHash(h: string): string { return `${h.slice(0,8)}…${h.slice(-4)}`; }

// ── ArcScan API helper ────────────────────────────────────────────────────

async function arcScanGet(path: string): Promise<any> {
  const res = await fetch(`${ARCSCAN_API}${path}`);
  if (!res.ok) throw new Error(`ArcScan ${res.status}`);
  return res.json();
}

// ── Network stats ─────────────────────────────────────────────────────────

async function fetchNetwork(): Promise<void> {
  // Current block
  const latest = await provider.getBlockNumber();
  txt("stat-block", latest.toLocaleString());
  txt("stat-block-sub", "Arc Testnet");

  // Avg block time
  try {
    const [bNow, bOld] = await Promise.all([
      provider.getBlock(latest),
      provider.getBlock(Math.max(1, latest - 10)),
    ]);
    if (bNow?.timestamp && bOld?.timestamp) {
      txt("stat-blocktime", `${((bNow.timestamp - bOld.timestamp) / 10).toFixed(1)}s`);
    }
  } catch { txt("stat-blocktime", "~0.5s"); }

  // Token supplies via ArcScan (more reliable than precompile totalSupply)
  for (const [id, addr] of [
    ["stat-usdc-supply", ADDR.USDC],
    ["stat-eurc-supply", ADDR.EURC],
  ] as const) {
    try {
      const data = await arcScanGet(`/tokens/${addr}`);
      const supply = parseFloat(data?.total_supply ?? "0") / 1e6;
      const label  = supply >= 1_000_000
        ? `${(supply / 1_000_000).toFixed(2)}M`
        : supply >= 1_000 ? `${(supply / 1_000).toFixed(1)}K` : supply.toFixed(2);
      txt(id, label);
    } catch {
      // Fallback to RPC
      try {
        const c = new Contract(addr, ERC20_ABI, provider);
        txt(id, fmtSupply(await c.totalSupply(), 6));
      } catch { txt(id, "—"); }
    }
  }
}

// ── Protocol data via ArcScan token transfers ─────────────────────────────

interface TxEntry {
  type:     "Pay" | "Multisend" | "Swap";
  token:    string;
  amount:   number;
  from:     string;
  blockNum: number;
  txHash:   string;
}

async function fetchTokenTransfers(tokenAddr: string, page = 1): Promise<any[]> {
  try {
    const data = await arcScanGet(
      `/tokens/${tokenAddr}/transfers?limit=50&page=${page}`
    );
    return data?.items ?? [];
  } catch { return []; }
}

async function fetchContractTxs(contractAddr: string): Promise<any[]> {
  try {
    const data = await arcScanGet(
      `/addresses/${contractAddr}/transactions?limit=50&filter=to`
    );
    return data?.items ?? [];
  } catch { return []; }
}

async function fetchProtocol(): Promise<void> {
  const entries: TxEntry[] = [];

  // ── 1. PaymentExecuted logs (most reliable — our own contract) ─────────
  try {
    const latest    = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - 50_000);
    const chunkSize = 5_000;

    for (let from = fromBlock; from <= latest; from += chunkSize) {
      const to = Math.min(from + chunkSize - 1, latest);
      try {
        const logs = await provider.getLogs({
          address: ADDR.PAYMENTS, topics: [PAYMENT_TOPIC],
          fromBlock: from, toBlock: to,
        });
        for (const log of logs) {
          try {
            const payer = "0x" + log.topics[2].slice(26);
            const d     = log.data.slice(2);
            const token = "0x" + d.slice(24, 64);
            const gross = Number(formatUnits(BigInt("0x" + d.slice(64, 128)), 6));
            entries.push({ type:"Pay", token, amount:gross, from:payer,
              blockNum:log.blockNumber, txHash:log.transactionHash });
          } catch { /* skip */ }
        }
      } catch { /* skip chunk */ }
    }
  } catch(e) { console.warn("PaymentExecuted:", e); }

  // ── 2. USDC transfers via ArcScan API ─────────────────────────────────
  const knownContracts = new Set([
    ADDR.PAYMENTS.toLowerCase(),
    ADDR.MULTISENDER.toLowerCase(),
    ADDR.USDC.toLowerCase(),
    ADDR.EURC.toLowerCase(),
    "0x0000000000000000000000000000000000000000",
  ]);

  for (const tokenAddr of [ADDR.USDC, ADDR.EURC]) {
    try {
      const transfers = await fetchTokenTransfers(tokenAddr);
      for (const tx of transfers) {
        const alreadyCaptured = entries.some(e => e.txHash === tx.tx_hash);
        if (alreadyCaptured) continue;

        const from   = (tx.from?.hash ?? "").toLowerCase();
        const to     = (tx.to?.hash ?? "").toLowerCase();
        const amount = parseFloat(tx.total?.value ?? "0") / 1e6;

        if (!from || !to || amount <= 0) continue;
        if (knownContracts.has(from) && knownContracts.has(to)) continue;

        // Classify by destination
        let type: TxEntry["type"] = "Swap";
        if (to === ADDR.MULTISENDER.toLowerCase()) type = "Multisend";
        else if (to === ADDR.PAYMENTS.toLowerCase()) type = "Pay";

        entries.push({
          type, token: tokenAddr, amount,
          from: tx.from?.hash ?? from,
          blockNum: parseInt(tx.block_number ?? "0"),
          txHash: tx.tx_hash ?? "",
        });
      }
    } catch(e) { console.warn("ArcScan transfers:", e); }
  }

  // ── 3. Multisender contract transactions ───────────────────────────────
  try {
    const txs = await fetchContractTxs(ADDR.MULTISENDER);
    for (const tx of txs) {
      const alreadyCaptured = entries.some(e => e.txHash === tx.hash);
      if (alreadyCaptured) continue;
      if (tx.status !== "ok") continue;
      entries.push({
        type: "Multisend",
        token: ADDR.USDC,
        amount: 0, // value not easily parsed from tx list
        from: tx.from?.hash ?? "",
        blockNum: parseInt(tx.block ?? "0"),
        txHash: tx.hash ?? "",
      });
    }
  } catch(e) { console.warn("Multisender txs:", e); }

  // ── Stats ─────────────────────────────────────────────────────────────
  const totalVol = entries.reduce((s, e) => s + e.amount, 0);
  const wallets  = new Set(entries.map(e => e.from.toLowerCase()).filter(Boolean)).size;
  const count    = entries.length;
  const avgTrade = count > 0 ? totalVol / count : 0;

  txt("stat-volume",    count ? fmtUSD(totalVol) : "$0.00");
  txt("stat-revenue",   count.toString());
  txt("stat-wallets",   wallets.toString());
  txt("stat-avg-trade", count ? fmtUSD(avgTrade) : "$0.00");

  // ── Feed ──────────────────────────────────────────────────────────────
  const feedBody = el("feed-body");
  if (!feedBody) return;

  if (!count) {
    feedBody.innerHTML = `<tr><td colspan="5" class="feed-empty">No transactions found · try refreshing</td></tr>`;
    return;
  }

  const seen   = new Set<string>();
  const unique = entries
    .filter(e => e.txHash && !seen.has(e.txHash) && seen.add(e.txHash))
    .sort((a, b) => b.blockNum - a.blockNum)
    .slice(0, 20);

  const badgeClass: Record<string, string> = {
    Pay: "badge-pay", Multisend: "badge-multisend", Swap: "badge-swap",
  };

  feedBody.innerHTML = unique.map(tx => {
    const isUSDC = tx.token.toLowerCase() === ADDR.USDC.toLowerCase();
    const sym    = isUSDC ? "USDC" : "EURC";
    const amount = tx.amount > 0 ? tx.amount.toFixed(4) : "—";
    const url    = `https://testnet.arcscan.app/tx/${tx.txHash}`;
    return `
      <tr>
        <td><span class="type-badge ${badgeClass[tx.type]}">${tx.type}</span></td>
        <td><span class="feed-amount">${amount} ${sym}</span></td>
        <td><span class="feed-addr">${tx.from ? short(tx.from) : "—"}</span></td>
        <td class="hide-sm"><span class="feed-block">${tx.blockNum ? tx.blockNum.toLocaleString() : "—"}</span></td>
        <td><a href="${url}" target="_blank" rel="noopener" class="arcscan-link">${shortHash(tx.txHash)} ↗</a></td>
      </tr>`;
  }).join("");
}

// ── Refresh ───────────────────────────────────────────────────────────────

async function refreshAll(): Promise<void> {
  const btn = el("refresh-btn");
  if (btn) btn.classList.add("loading");
  try {
    await Promise.all([fetchNetwork(), fetchProtocol()]);
    txt("last-updated", new Date().toLocaleTimeString());
    const eb = el("fetch-error");
    if (eb) eb.style.display = "none";
  } catch (err: any) {
    console.error(err);
    const eb = el("fetch-error");
    if (eb) { eb.textContent = `Error: ${err.message}`; eb.style.display = "block"; }
  } finally {
    if (btn) btn.classList.remove("loading");
  }
}

(window as any).refreshAll = refreshAll;
refreshAll();
setInterval(refreshAll, 15_000);
