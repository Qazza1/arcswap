import "./trade.css";
import { BrowserProvider, Contract } from "ethers";
import { arcfxWallet, ARC_MAINNET_CHAIN_ID_HEX, type Eip1193Provider } from "../shared/wallet";
import { appPath } from "../shared/appOrigin";
import { formatUsdc, MAINNET, NATIVE_PER_ATOMIC } from "./mainnetPayments";
import { bridgeAmountMaxFeeIssue, CIRCLE_SDK_ID, createControlledBridgeClient, createControlledSwapClient, createLocalBridgeProofClient, createLocalSwapProofClient, createReadonlyCircleClient, probeInstalledCircleCapabilities, PROOF_MAX_BRIDGE_USDC_ATOMIC, type ArcCapability, type ReadonlyCircleClient } from "./circleAppKit";
import { createSwapSnapshot, swapSnapshotIsCurrent, validateSwapForm, type SwapForm, type SwapQuoteSnapshot, type WalletBinding } from "./swapCore";
import { BRIDGE_CHAINS, bridgeSnapshotIsCurrent, createBridgeSnapshot, validateBridgeForm, type BridgeChain, type BridgeForm, type BridgeQuoteSnapshot } from "./bridgeCore";
import { ARCFX_MAINNET_TRADE_EXECUTION_ENABLED, LOCAL_BRIDGE_PROOF_ENABLED, LOCAL_SWAP_PROOF_ENABLED } from "./tradeExecutionGate";
import { BRIDGE_NETWORKS, bridgeRoute, destinationMintText, destinationsFor, minimumDelivered, routeExecutionIssue, sourcesOffered, switchWalletMessage, type BridgeNetwork } from "./bridgeRoutes";

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
const $ = (root: ParentNode, selector: string): any => root.querySelector(selector) as HTMLElement;
const text = (target: HTMLElement, value: string) => { target.textContent = value; };
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const slippageText = (bps: number) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
const feeText = (fees: readonly { type: string; token: string; amount: string | null; network?: string }[]) => fees.length
  ? fees.map(fee => `${fee.type}${fee.network ? ` · ${fee.network}` : ""}: ${fee.amount ?? "unavailable"} ${fee.token}`).join(" · ")
  : "No fee breakdown returned by the provider.";
const formatNative = (wei: bigint) => { const whole = wei / 10n ** 18n; const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, ""); return `${whole}${fraction ? `.${fraction}` : ""}`; };
const txHash = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value);
const FEE_LABEL: Record<string, string> = { forwarder: "Circle forwarder fee", provider: "CCTP fast-transfer fee" };
const serviceFeeText = (fees: readonly { type: string; token: string; amount: string | null }[], maxFee: string | null) => fees.length
  ? `${fees.map(fee => `${FEE_LABEL[fee.type] || fee.type}: ${fee.amount ?? "unavailable"} ${fee.token}`).join(" · ")} · maximum bridge fee (burn maxFee): ${maxFee ?? "unavailable"} USDC`
  : "No provider or forwarder fee returned by Circle.";
const sourceGasText = (source: BridgeNetwork, fees: readonly { type: string; token: string; amount: string | null; network?: string }[]) => {
  const own = fees.filter(fee => fee.network === BRIDGE_NETWORKS[source].sdk);
  return own.length ? `Source (${source}): ${own.map(fee => `${fee.type} ≈ ${fee.amount ?? "unavailable"} ${fee.token}`).join(", ")}` : `Source (${source}): gas estimate not returned by Circle`;
};
function showTransactions(target: HTMLElement, label: string, hashes: readonly string[], chain: BridgeNetwork): void {
  target.replaceChildren(document.createTextNode(`${label}: `));
  if (!hashes.length) { target.append(document.createTextNode("not returned")); return; }
  hashes.filter(txHash).forEach((hash, index) => {
    if (index) target.append(document.createTextNode(", "));
    const link = document.createElement("a");
    link.href = `${BRIDGE_NETWORKS[chain].explorerTx}${hash}`;
    link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = hash;
    target.append(link);
  });
}

function currentBinding(): WalletBinding | null {
  const provider = arcfxWallet.provider;
  const account = arcfxWallet.address;
  const chainId = arcfxWallet.chainId;
  return provider && account && chainId ? { provider, account, chainId } : null;
}

function sameBinding(left: WalletBinding | null, right: WalletBinding): boolean {
  return Boolean(left && left.provider === right.provider && left.account.toLowerCase() === right.account.toLowerCase()
    && left.chainId.toLowerCase() === right.chainId.toLowerCase());
}

let circleCache: { provider: Eip1193Provider; client: Promise<ReadonlyCircleClient> } | null = null;
function circleFor(provider: Eip1193Provider): Promise<ReadonlyCircleClient> {
  if (circleCache?.provider !== provider) {
    const client = createReadonlyCircleClient(provider).catch(error => { if (circleCache?.provider === provider) circleCache = null; throw error; });
    circleCache = { provider, client };
  }
  return circleCache.client;
}

async function readArcBalances(provider: Eip1193Provider, account: string, capability: ArcCapability): Promise<{ usdc: bigint; eurc: bigint | null; native: bigint }> {
  const browser = new BrowserProvider(provider as any);
  const usdc = await new Contract(MAINNET.usdc, ERC20_BALANCE_ABI, browser).balanceOf(account) as bigint;
  const eurc = capability.eurcAddress ? await new Contract(capability.eurcAddress, ERC20_BALANCE_ABI, browser).balanceOf(account) as bigint : null;
  const native = await browser.getBalance(account);
  return { usdc, eurc, native };
}

export function mountTrade(root: HTMLElement): void {
  let capability: ArcCapability | null = null;
  let swapQuote: SwapQuoteSnapshot | null = null;
  let bridgeQuote: BridgeQuoteSnapshot | null = null;
  let localProofBusy = false;
  let localBridgeProofBusy = false;
  let bridgeProofSourceStarted = false;
  let recipientTouched = false;
  let balanceRequest = 0;
  let swapRequest = 0;
  let bridgeRequest = 0;

  const page = document.createElement("div");
  page.className = "trade-page";
  page.innerHTML = `<header class="trade-heading"><div><p class="trade-kicker">Treasury · Arc Mainnet</p><div class="trade-title-row"><h1>Swap &amp; Bridge</h1><span class="trade-badge">MAINNET</span></div><p>Review a current Circle quote, then confirm each required action in your selected wallet.</p></div><div class="trade-capability" id="trade-capability" role="status">Checking installed Circle capabilities…</div></header>
    <aside class="trade-safety"><strong>Wallet controlled</strong><span>Arc Mainnet · chain 5042. ArcFX never switches networks or submits a transaction without your wallet confirmation.</span></aside>
    <div class="trade-tabs" role="tablist" aria-label="Treasury movement"><button type="button" role="tab" aria-selected="true" data-tab="swap">Swap</button><button type="button" role="tab" aria-selected="false" data-tab="bridge">Bridge</button></div>
    <section class="trade-panel" id="trade-swap" role="tabpanel"><div class="trade-form-card"><div class="trade-section-head"><div><p class="trade-eyebrow">Treasury conversion</p><h2>Swap on Arc Mainnet</h2></div><span class="trade-network">Arc · 5042</span></div>
      <div class="trade-grid"><label>From token<select id="swap-from"><option>USDC</option><option>EURC</option></select></label><label>To token<select id="swap-to"><option>EURC</option><option>USDC</option></select></label><label class="trade-wide">Amount<input id="swap-amount" inputmode="decimal" autocomplete="off" placeholder="0.00"/><small id="swap-balance">Available balance: connect a wallet to read</small></label><label>Slippage<select id="swap-slippage"><option value="50">0.50%</option><option value="100">1.00%</option><option value="300">3.00%</option></select></label></div>
      <p class="trade-gas" id="swap-gas">Arc network fees use the native 18-decimal USDC representation. Keep a reserve; Max is intentionally unavailable.</p><div class="trade-actions"><button class="trade-button trade-button--primary" id="swap-quote" type="button">Get read-only quote</button><button class="trade-button" id="swap-review" type="button" disabled>Review swap</button><button class="trade-button trade-button--primary" id="swap-confirm" type="button" disabled ${ARCFX_MAINNET_TRADE_EXECUTION_ENABLED ? "" : "hidden"}>Confirm swap in wallet</button>${LOCAL_SWAP_PROOF_ENABLED ? '<button class="trade-button trade-button--danger" id="swap-local-proof" type="button" disabled>Run local ≤1 USDC proof</button>' : ""}</div><p class="trade-message" id="swap-message" role="status"></p></div>
      <article class="trade-quote" id="swap-output" hidden><p class="trade-eyebrow">Circle estimate</p><h3 id="swap-receive">—</h3><dl><div><dt>Minimum received</dt><dd id="swap-minimum">—</dd></div><div><dt>Route</dt><dd id="swap-route">—</dd></div><div><dt>Provider</dt><dd>Circle App Kit</dd></div><div><dt>Fees</dt><dd id="swap-fees">—</dd></div><div><dt>Approval metadata</dt><dd>Checked again before wallet confirmation</dd></div><div><dt>Quote window</dt><dd id="swap-time">—</dd></div></dl><div class="trade-review" id="swap-review-panel" hidden><strong>Review swap</strong><p id="swap-review-details"></p><p>USDC → EURC only, up to 1 USDC for this controlled release. An existing Circle adapter allowance blocks this flow; ArcFX never stacks an approval. The wallet may request an exact approval followed by a separate swap confirmation.</p></div><div class="trade-review" id="swap-proof-result" hidden><strong>Swap transaction status</strong><p id="swap-proof-approval">Approval: awaiting wallet result</p><p id="swap-proof-tx">Swap: awaiting wallet result</p></div></article>
    </section>
    <section class="trade-panel" id="trade-bridge" role="tabpanel" hidden><div class="trade-form-card"><div class="trade-section-head"><div><p class="trade-eyebrow">USDC movement</p><h2>Bridge route estimate</h2></div><span class="trade-network">CCTP-aware</span></div>
      <div class="trade-grid"><label>From network<select id="bridge-from">${sourcesOffered().map(name => `<option>${name}</option>`).join("")}</select></label><label>To network<select id="bridge-to">${destinationsFor("Arc").map(name => `<option>${name}</option>`).join("")}</select></label><label>Asset<input value="USDC" readonly aria-readonly="true"/></label><label>Amount<input id="bridge-amount" inputmode="decimal" autocomplete="off" placeholder="0.00"/><small id="bridge-balance">Source balance: connect a wallet to read</small></label><label class="trade-wide">Destination wallet<input id="bridge-recipient" autocomplete="off" spellcheck="false" placeholder="0x…"/><small>Defaults visually to the connected owner wallet; it remains editable.</small></label></div>
      <p class="trade-gas" id="bridge-context">Routes are shown only after the installed SDK validates the selected pair. Arc chain 5042 is distinct from CCTP domain 26.</p><div class="trade-actions"><button class="trade-button trade-button--primary" id="bridge-quote" type="button">Get route estimate</button><button class="trade-button" id="bridge-review" type="button" disabled>Review bridge</button><button class="trade-button trade-button--primary" id="bridge-confirm" type="button" disabled ${ARCFX_MAINNET_TRADE_EXECUTION_ENABLED ? "" : "hidden"}>Confirm bridge in wallet</button>${LOCAL_BRIDGE_PROOF_ENABLED ? '<button class="trade-button trade-button--danger" id="bridge-local-proof" type="button" disabled>Run local ≤0.5 USDC bridge proof</button>' : ""}</div><p class="trade-message" id="bridge-message" role="status"></p></div>
      <article class="trade-quote" id="bridge-output" hidden><p class="trade-eyebrow">Circle estimate</p><h3 id="bridge-receive">—</h3><dl><div><dt>Route</dt><dd id="bridge-route">—</dd></div><div><dt>Provider</dt><dd>Circle App Kit</dd></div><div><dt>Protocol / service fees</dt><dd id="bridge-fees">—</dd></div><div><dt>Network fees</dt><dd id="bridge-gas-fees">—</dd></div><div><dt>Minimum delivered</dt><dd id="bridge-min">—</dd></div><div><dt>Transfer / finality mode</dt><dd>Circle forwarder · same owner wallet</dd></div><div><dt>Estimated timing</dt><dd>Not returned by current provider</dd></div><div><dt>Quote identity</dt><dd id="bridge-quote-id">Not returned</dd></div><div><dt>Expected steps</dt><dd>Allowance check → approval if needed → source burn → attestation → destination mint</dd></div><div><dt>Estimate window</dt><dd id="bridge-time">—</dd></div></dl><div class="trade-review" id="bridge-review-panel" hidden><strong>Review bridge</strong><p id="bridge-review-details"></p><p id="bridge-review-scope">Same-wallet USDC up to 0.5 USDC for this controlled release. Existing Circle bridge allowance must be cleared before this attempt. A source attempt is never automatically retried.</p></div><div class="trade-review" id="bridge-proof-result" hidden><strong>Bridge transaction status</strong><p id="bridge-proof-source">Source: awaiting Circle result</p><p id="bridge-proof-attestation">Attestation: awaiting Circle result</p><p id="bridge-proof-destination">Destination: awaiting Circle result</p><p id="bridge-proof-diagnostic">Diagnostic: awaiting Circle result</p></div></article>
    </section>`;
  root.replaceChildren(page);

  const swapForm = (): SwapForm => ({ tokenIn: $(page, "#swap-from").value as SwapForm["tokenIn"], tokenOut: $(page, "#swap-to").value as SwapForm["tokenOut"], amount: $(page, "#swap-amount").value, slippageBps: Number($(page, "#swap-slippage").value) });
  const bridgeForm = (): BridgeForm => ({ source: $(page, "#bridge-from").value as BridgeChain, destination: $(page, "#bridge-to").value as BridgeChain, amount: $(page, "#bridge-amount").value, recipient: $(page, "#bridge-recipient").value });
  const invalidateSwap = () => { swapRequest++; swapQuote = null; $(page, "#swap-review").disabled = true; $(page, "#swap-confirm").disabled = true; const proof = $(page, "#swap-local-proof"); if (proof) proof.disabled = true; $(page, "#swap-review-panel").hidden = true; $(page, "#swap-proof-result").hidden = true; $(page, "#swap-output").hidden = true; };
  // A local proof attempt consumes the reviewed snapshot even if the wallet
  // rejects, times out, or only returns partial SDK information. The user must
  // explicitly request and review a new quote before another mutation attempt.
  const consumeLocalProofReview = () => { swapQuote = null; $(page, "#swap-review").disabled = true; $(page, "#swap-confirm").disabled = true; const proof = $(page, "#swap-local-proof"); if (proof) proof.disabled = true; };
  const invalidateBridge = () => { bridgeRequest++; bridgeQuote = null; $(page, "#bridge-review").disabled = true; $(page, "#bridge-confirm").disabled = true; const proof = $(page, "#bridge-local-proof"); if (proof) proof.disabled = true; $(page, "#bridge-review-panel").hidden = true; $(page, "#bridge-proof-result").hidden = true; $(page, "#bridge-output").hidden = true; };
  const consumeLocalBridgeReview = () => { bridgeQuote = null; $(page, "#bridge-review").disabled = true; $(page, "#bridge-confirm").disabled = true; const proof = $(page, "#bridge-local-proof"); if (proof) proof.disabled = true; };

  page.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(button => button.addEventListener("click", () => {
    page.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(item => item.setAttribute("aria-selected", String(item === button)));
    $(page, "#trade-swap").hidden = button.dataset.tab !== "swap";
    $(page, "#trade-bridge").hidden = button.dataset.tab !== "bridge";
  }));
  page.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#trade-swap input, #trade-swap select").forEach(input => input.addEventListener("input", invalidateSwap));
  page.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#trade-bridge input, #trade-bridge select").forEach(input => input.addEventListener("input", () => { if (input.id === "bridge-recipient") recipientTouched = true; invalidateBridge(); }));

  $(page, "#bridge-from").addEventListener("change", () => {
    const to = $(page, "#bridge-to") as HTMLSelectElement; const previous = to.value;
    const options = destinationsFor($(page, "#bridge-from").value as BridgeNetwork);
    to.replaceChildren(...options.map(name => Object.assign(document.createElement("option"), { textContent: name })));
    if (options.includes(previous as BridgeNetwork)) to.value = previous;
    invalidateBridge(); void refreshBalances();
  });

  const quoteGate = (sourceChain = "Arc"): { binding?: WalletBinding; error?: string } => {
    const binding = currentBinding();
    if (!binding) return { error: `Connect and verify a wallet at ${appPath("/entry")} before requesting a quote.` };
    const expected = BRIDGE_CHAINS[sourceChain as BridgeChain]?.chainIdHex;
    if (!expected || binding.chainId.toLowerCase() !== expected) return { error: switchWalletMessage(sourceChain as BridgeNetwork) };
    return { binding };
  };

  $(page, "#swap-quote").addEventListener("click", async () => {
    invalidateSwap(); const request = swapRequest; const message = $(page, "#swap-message"); text(message, "Checking the current read-only route…");
    const form = swapForm(); const valid = validateSwapForm(form); const gate = quoteGate("Arc");
    if (valid.error || gate.error || !gate.binding || !capability?.swap) { text(message, valid.error || gate.error || "Circle does not advertise Arc Mainnet swaps in this SDK."); return; }
    try {
      const result = await (await circleFor(gate.binding.provider as Eip1193Provider)).estimateSwap({ chain: capability.chainIdentifier, tokenIn: form.tokenIn, tokenOut: form.tokenOut, amount: form.amount.trim(), slippageBps: form.slippageBps });
      if (request !== swapRequest || !sameBinding(currentBinding(), gate.binding) || JSON.stringify(swapForm()) !== JSON.stringify(form)) throw new Error("The selected wallet or swap request changed. Request a fresh quote.");
      swapQuote = createSwapSnapshot({ binding: gate.binding, form, amountAtomic: valid.amountAtomic!, route: result.route, quoteId: result.quoteId, estimatedOutput: result.estimatedOutput, minimumReceived: result.minimumReceived, fees: result.fees, sdk: CIRCLE_SDK_ID });
      $(page, "#swap-output").hidden = false; text($(page, "#swap-receive"), `Estimated receive ${result.estimatedOutput} ${result.outputToken}`); text($(page, "#swap-minimum"), `${result.minimumReceived} ${result.outputToken}`); text($(page, "#swap-route"), result.route); text($(page, "#swap-fees"), feeText(result.fees)); text($(page, "#swap-time"), `${time(swapQuote.createdAt)} · refresh after ${time(swapQuote.validUntil)}`); $(page, "#swap-review").disabled = false; text(message, "Read-only quote ready. It expires locally after 60 seconds.");
    } catch (error: any) { if (request === swapRequest) text(message, `Quote unavailable: ${String(error?.message || error)}`); }
  });
  $(page, "#swap-review").addEventListener("click", () => {
    const current = swapSnapshotIsCurrent(swapQuote, swapForm(), currentBinding());
    if (!current) { invalidateSwap(); text($(page, "#swap-message"), "This quote is stale or the wallet context changed. Request a fresh quote."); return; }
    $(page, "#swap-review-panel").hidden = false;
    text($(page, "#swap-review-details"), `${swapQuote!.form.amount} ${swapQuote!.form.tokenIn} → approximately ${swapQuote!.estimatedOutput} ${swapQuote!.form.tokenOut} · minimum ${swapQuote!.minimumReceived} ${swapQuote!.form.tokenOut} · provider/service fee ${feeText(swapQuote!.fees.filter(fee => !/gas|network/i.test(fee.type)))} · gas estimate ${feeText(swapQuote!.fees.filter(fee => /gas|network/i.test(fee.type)))} · slippage ${slippageText(swapQuote!.form.slippageBps)} · wallet ${swapQuote!.binding.account} · Arc Mainnet / 5042 · quote expires ${time(swapQuote!.validUntil)}.`);
    $(page, "#swap-confirm").disabled = !ARCFX_MAINNET_TRADE_EXECUTION_ENABLED || swapQuote!.amountAtomic > 1_000_000n || swapQuote!.form.tokenIn !== "USDC" || swapQuote!.form.tokenOut !== "EURC";
    if ($(page, "#swap-confirm").disabled) text($(page, "#swap-message"), "Controlled execution currently supports USDC → EURC up to 1 USDC; this route remains quote-only.");
    const proof = $(page, "#swap-local-proof");
    if (proof && swapQuote!.amountAtomic <= 1_000_000n) proof.disabled = false;
  });

  const runSwap = async (action: HTMLButtonElement, production: boolean) => {
    if (localProofBusy) return;
    const binding = currentBinding(); const form = swapForm();
    if (!swapQuote || !binding || !swapSnapshotIsCurrent(swapQuote, form, binding) || binding.provider !== swapQuote.binding.provider) {
      invalidateSwap(); text($(page, "#swap-message"), "The reviewed quote or selected wallet changed. Request and review a fresh quote."); return;
    }
    if (swapQuote.amountAtomic > 1_000_000n || form.tokenIn !== "USDC" || form.tokenOut !== "EURC") {
      text($(page, "#swap-message"), "This controlled swap is limited to one USDC or less for USDC → EURC only."); return;
    }
    const reviewedQuote = swapQuote;
    const submittedHashes = new Set<string>();
    localProofBusy = true; action.disabled = true;
    text($(page, "#swap-message"), "Checking the fresh route, exact selected wallet, allowance, and gas reserve before any wallet prompt…");
    try {
      const proof = await (production ? createControlledSwapClient(binding.provider as Eip1193Provider) : createLocalSwapProofClient(binding.provider as Eip1193Provider));
      if (swapQuote !== reviewedQuote || !swapSnapshotIsCurrent(reviewedQuote, swapForm(), currentBinding())) throw new Error("The reviewed swap quote or wallet changed. Request a fresh quote.");
      $(page, "#swap-proof-result").hidden = false;
      text($(page, "#swap-proof-approval"), "Approval: awaiting wallet/Circle result");
      text($(page, "#swap-proof-tx"), "Swap: pending wallet/Circle confirmation");
      const result = await proof.executeExactUsdcToEurc({
        account: binding.account, amount: form.amount.trim(), slippageBps: form.slippageBps, expiresAt: reviewedQuote.validUntil,
        reviewed: { route: reviewedQuote.route, estimatedOutput: reviewedQuote.estimatedOutput, minimumReceived: reviewedQuote.minimumReceived, fees: reviewedQuote.fees },
        onWalletTransaction: hash => {
          submittedHashes.add(hash);
          $(page, "#swap-proof-result").hidden = false;
          showTransactions($(page, "#swap-proof-approval"), "Arc wallet transaction submitted", [...submittedHashes], "Arc");
          text($(page, "#swap-message"), "Wallet transaction submitted. Keep the displayed hash; do not retry while its status is uncertain.");
        },
      });
      $(page, "#swap-proof-result").hidden = false;
      showTransactions($(page, "#swap-proof-approval"), "Approval", result.approvalTxHashes, "Arc");
      showTransactions($(page, "#swap-proof-tx"), "Swap", [result.swapTxHash], "Arc");
      if (result.result.amountOut) $(page, "#swap-proof-tx").append(document.createTextNode(` · Circle reports ${result.result.amountOut} EURC`));
      let status = "pending";
      try {
        const receipt = await new BrowserProvider(binding.provider as any).getTransactionReceipt(result.swapTxHash);
        status = receipt ? (receipt.status === 1 ? "confirmed" : "failed") : "pending";
      } catch { /* The hash remains visible even when a receipt read is unavailable. */ }
      text($(page, "#swap-message"), `Swap ${status}. Check the linked transaction for updates; ArcFX will not retry automatically.`);
    } catch (error: any) {
      text($(page, "#swap-message"), `Swap stopped or status uncertain: ${String(error?.message || error)} ${submittedHashes.size ? "Check the linked transaction before any new attempt." : "No wallet transaction hash was returned; check wallet activity before any retry."}`);
    } finally {
      localProofBusy = false;
      consumeLocalProofReview();
    }
  };
  const localProof = $(page, "#swap-local-proof") as HTMLButtonElement | null;
  localProof?.addEventListener("click", () => void runSwap(localProof, false));
  const swapConfirm = $(page, "#swap-confirm") as HTMLButtonElement;
  swapConfirm.addEventListener("click", () => void runSwap(swapConfirm, true));

  $(page, "#bridge-quote").addEventListener("click", async () => {
    invalidateBridge(); const request = bridgeRequest; const message = $(page, "#bridge-message"); text(message, "Checking the selected route with Circle…");
    const form = bridgeForm(); const valid = validateBridgeForm(form); const route = bridgeRoute(form.source, form.destination);
    if (!route || route.status === "hidden") { text(message, "ArcFX does not offer this bridge route."); return; }
    const gate = quoteGate(form.source);
    if (valid.error || gate.error || !gate.binding || !capability?.bridge) { text(message, valid.error || gate.error || "Circle does not advertise Arc Mainnet bridges in this SDK."); return; }
    try {
      const result = await (await circleFor(gate.binding.provider as Eip1193Provider)).estimateBridge({ sourceChain: BRIDGE_CHAINS[form.source].sdk, destinationChain: BRIDGE_CHAINS[form.destination].sdk, recipient: form.recipient.trim(), amount: form.amount.trim() });
      if (request !== bridgeRequest || !sameBinding(currentBinding(), gate.binding) || JSON.stringify(bridgeForm()) !== JSON.stringify(form)) throw new Error("The selected wallet or bridge request changed. Request a fresh estimate.");
      const allFees = [...result.fees, ...result.gasFees];
      bridgeQuote = createBridgeSnapshot({ binding: gate.binding, form, amountAtomic: valid.amountAtomic!, route: result.route, quoteId: result.quoteId, estimatedReceive: result.amount, fees: allFees, warnings: result.warnings, sdk: CIRCLE_SDK_ID });
      // Quote-only routes still show Circle's real figures, but never become reviewable.
      const reviewIssue = route.status === "quote-only" ? routeExecutionIssue(route, "local") : bridgeAmountMaxFeeIssue(result.amount, result.maxFee);
      const delivered = minimumDelivered(result.amount, result.maxFee);
      const source = BRIDGE_NETWORKS[form.source];
      $(page, "#bridge-output").hidden = false; text($(page, "#bridge-receive"), `Bridge amount ${result.amount} USDC`); text($(page, "#bridge-route"), result.route); text($(page, "#bridge-fees"), serviceFeeText(result.fees, result.maxFee)); text($(page, "#bridge-gas-fees"), `${sourceGasText(form.source, result.gasFees)} · ${destinationMintText(form.destination, result.gasFees)}`); text($(page, "#bridge-min"), delivered ? `${delivered} USDC (bridge amount − maximum bridge fee; the actual fee can be lower)` : "Not calculable from this estimate"); text($(page, "#bridge-quote-id"), result.quoteId || "Not returned"); text($(page, "#bridge-time"), `${time(bridgeQuote.createdAt)} · refresh after ${time(bridgeQuote.validUntil)}`); $(page, "#bridge-review").disabled = Boolean(reviewIssue); text(message, reviewIssue || (result.warnings.length ? `Estimate ready with provider warning: ${result.warnings.join(" · ")}` : "Read-only route estimate ready. It expires locally after 60 seconds."));
      text($(page, "#bridge-review-details"), `${form.source} → ${form.destination} · ${form.amount} USDC · wallet ${gate.binding.account} on ${source.label} / ${source.chainId} (CCTP domain ${source.cctpDomain}) · destination ${form.recipient.trim()} on ${BRIDGE_NETWORKS[form.destination].label} (CCTP domain ${BRIDGE_NETWORKS[form.destination].cctpDomain}) · service fees ${serviceFeeText(result.fees, result.maxFee)} · ${sourceGasText(form.source, result.gasFees)} · minimum delivered ${delivered ?? "not calculable"} USDC · expires ${time(bridgeQuote.validUntil)}.`);
    } catch (error: any) { if (request === bridgeRequest) text(message, `Route unavailable: ${String(error?.message || error)}`); }
  });
  $(page, "#bridge-review").addEventListener("click", () => {
    const current = bridgeSnapshotIsCurrent(bridgeQuote, bridgeForm(), currentBinding());
    if (!current) { invalidateBridge(); text($(page, "#bridge-message"), "This estimate is stale or the wallet context changed. Request a fresh estimate."); return; }
    $(page, "#bridge-review-panel").hidden = false;
    const binding = currentBinding(); const form = bridgeForm(); const proof = $(page, "#bridge-local-proof");
    const route = bridgeRoute(form.source, form.destination);
    const bounded = Boolean(binding && !bridgeProofSourceStarted && bridgeQuote!.amountAtomic <= PROOF_MAX_BRIDGE_USDC_ATOMIC
      && form.recipient.trim().toLowerCase() === binding.account.toLowerCase());
    const productionIssue = routeExecutionIssue(route, "production");
    if (proof && bounded && !routeExecutionIssue(route, "local")) proof.disabled = false;
    $(page, "#bridge-confirm").disabled = !ARCFX_MAINNET_TRADE_EXECUTION_ENABLED || !bounded || Boolean(productionIssue);
    text($(page, "#bridge-review-scope"), `${form.source} → ${form.destination}: same-wallet USDC up to 0.5 USDC for this controlled release. Your wallet must stay on ${form.source}. Existing Circle bridge allowance must be cleared before this attempt. A source attempt is never automatically retried.`);
    if ($(page, "#bridge-confirm").disabled) text($(page, "#bridge-message"), productionIssue || "Controlled execution requires same-wallet USDC up to 0.5 USDC; this estimate remains read-only.");
  });

  const runBridge = async (action: HTMLButtonElement, production: boolean) => {
    if (localBridgeProofBusy) return;
    if (bridgeProofSourceStarted) { text($(page, "#bridge-message"), "A local bridge source attempt already began. Verify its displayed state manually; ArcFX will not repeat it."); return; }
    const binding = currentBinding(); const form = bridgeForm();
    if (!bridgeQuote || !binding || !bridgeSnapshotIsCurrent(bridgeQuote, form, binding) || binding.provider !== bridgeQuote.binding.provider) {
      invalidateBridge(); text($(page, "#bridge-message"), "The reviewed estimate or selected wallet changed. Request and review a fresh estimate."); return;
    }
    const routeIssue = routeExecutionIssue(bridgeRoute(form.source, form.destination), production ? "production" : "local");
    if (routeIssue || bridgeQuote.amountAtomic > PROOF_MAX_BRIDGE_USDC_ATOMIC || form.recipient.trim().toLowerCase() !== binding.account.toLowerCase()) {
      text($(page, "#bridge-message"), routeIssue || "This controlled bridge is limited to same-wallet USDC and 0.5 USDC or less."); return;
    }
    const reviewedQuote = bridgeQuote;
    const source = form.source as BridgeNetwork; const destination = form.destination as BridgeNetwork;
    localBridgeProofBusy = true; action.disabled = true;
    text($(page, "#bridge-message"), `Checking a fresh ${source} → ${destination} estimate, selected wallet, allowance, and ${source} gas reserve before any wallet prompt…`);
    const sourceEvents = new Set<string>();
    const showObservation = (observation: any, originalBridgeErrorDiagnostic?: any) => {
      if (!observation) return;
      $(page, "#bridge-proof-result").hidden = false;
      const sourceHashes = [...new Set([...(observation.sourceTxHashes || []), ...sourceEvents])];
      if (sourceHashes.length) showTransactions($(page, "#bridge-proof-source"), "Source", sourceHashes, source);
      else text($(page, "#bridge-proof-source"), `Source: ${observation.state || "stopped"}${observation.errorState ? ` (${observation.errorState})` : ""}; Circle returned no source transaction hash.`);
      text($(page, "#bridge-proof-attestation"), `Attestation: ${observation.attestationState || "not returned"}`);
      if (observation.destinationTxHashes?.length) showTransactions($(page, "#bridge-proof-destination"), `Destination (${observation.destinationState})`, observation.destinationTxHashes, destination);
      else text($(page, "#bridge-proof-destination"), `Destination: ${observation.destinationState || "not returned"}`);
      const original = originalBridgeErrorDiagnostic || observation.originalError;
      text($(page, "#bridge-proof-diagnostic"), `Diagnostic: state ${observation.state}; provider ${observation.provider}; ${observation.sourceChain} → ${observation.destinationChain}; steps ${observation.steps.map((step: any) => `${step.name}:${step.state}:${step.attempted ? "attempted" : "not-attempted"}${step.errorCategory ? `:${step.errorCategory}` : ""}${step.errorCode ? `:${step.errorCode}` : ""}${step.errorMessage ? `:${step.errorMessage}` : ""}`).join(" · ") || "none"}${observation.errorState ? `; error ${observation.errorState}` : ""}${observation.errorCode ? `:${observation.errorCode}` : ""}${observation.errorMessage ? `:${observation.errorMessage}` : ""}${original ? `; Original Circle error: name ${original.name || "not returned"}; code ${original.code || "not returned"}; message ${original.message || "not returned"}; shortMessage ${original.shortMessage || "not returned"}; reason ${original.reason || "not returned"}; details ${original.details || "not returned"}; cause ${original.cause.join(" | ") || "not returned"}; keys ${original.keys.join(", ") || "none"}` : ""}`);
    };
    try {
      const proof = await (production ? createControlledBridgeClient(binding.provider as Eip1193Provider) : createLocalBridgeProofClient(binding.provider as Eip1193Provider));
      if (bridgeQuote !== reviewedQuote || !bridgeSnapshotIsCurrent(reviewedQuote, bridgeForm(), currentBinding())) throw new Error("The reviewed bridge estimate or wallet changed. Request a fresh estimate.");
      $(page, "#bridge-proof-result").hidden = false;
      text($(page, "#bridge-proof-source"), "Source: pending wallet/Circle confirmation; do not start another bridge.");
      const result = await proof.executeBridgeUsdc({
        source, destination, account: binding.account, amount: form.amount.trim(), expiresAt: reviewedQuote.validUntil,
        reviewed: { route: reviewedQuote.route, amount: reviewedQuote.estimatedReceive, sourceChain: form.source, destinationChain: form.destination, recipient: form.recipient.trim(), maxFee: null, fees: reviewedQuote.fees.filter(fee => !fee.network), gasFees: reviewedQuote.fees.filter(fee => Boolean(fee.network)), warnings: reviewedQuote.warnings },
        onSourceSubmissionStart: () => { bridgeProofSourceStarted = true; },
        onSourceTransaction: (kind, hash) => {
          sourceEvents.add(hash);
          $(page, "#bridge-proof-result").hidden = false;
          showTransactions($(page, "#bridge-proof-source"), `Source ${kind} submitted`, [hash], source);
          text($(page, "#bridge-message"), `Source ${kind} submitted. Keep this transaction hash; ArcFX will not retry this bridge.`);
        },
      });
      showObservation(result);
      text($(page, "#bridge-message"), /^(success|complete)$/i.test(result.state) ? "Circle returned a completed bridge state. Check source and destination transaction status; no automatic retry will occur." : "Bridge state is pending or uncertain. Verify the displayed source transaction; ArcFX will not retry or resume it.");
    } catch (error: any) {
      showObservation(error?.bridgeProofObservation, error?.originalBridgeErrorDiagnostic);
      text($(page, "#bridge-message"), `Bridge stopped or status uncertain: ${String(error?.message || error)}`);
    } finally {
      localBridgeProofBusy = false;
      consumeLocalBridgeReview();
    }
  };
  const localBridgeProof = $(page, "#bridge-local-proof") as HTMLButtonElement | null;
  localBridgeProof?.addEventListener("click", () => void runBridge(localBridgeProof, false));
  const bridgeConfirm = $(page, "#bridge-confirm") as HTMLButtonElement;
  bridgeConfirm.addEventListener("click", () => void runBridge(bridgeConfirm, true));

  const refreshBalances = async () => {
    const request = ++balanceRequest; const binding = currentBinding();
    const bridgeSource = $(page, "#bridge-from").value as BridgeNetwork;
    if (binding && bridgeSource !== "Arc") {
      const network = BRIDGE_NETWORKS[bridgeSource];
      if (binding.chainId.toLowerCase() !== network.chainIdHex) text($(page, "#bridge-balance"), `Source balance: switch wallet to ${bridgeSource} to read it`);
      else {
        const browser = new BrowserProvider(binding.provider as any);
        Promise.all([new Contract(network.usdc, ERC20_BALANCE_ABI, browser).balanceOf(binding.account) as Promise<bigint>, browser.getBalance(binding.account)])
          .then(([usdc, eth]) => { if (request === balanceRequest) text($(page, "#bridge-balance"), `Source balance: ${formatUsdc(usdc)} USDC on ${bridgeSource} · gas ${formatNative(eth)} ETH`); })
          .catch(() => { if (request === balanceRequest) text($(page, "#bridge-balance"), "Source balance: read unavailable"); });
      }
    }
    if (!binding || binding.chainId.toLowerCase() !== ARC_MAINNET_CHAIN_ID_HEX || !capability) { text($(page, "#swap-balance"), "Available balance: Arc Mainnet wallet required"); if (bridgeSource === "Arc") text($(page, "#bridge-balance"), "Source balance: available on Arc when selected"); return; }
    try {
      const balances = await readArcBalances(binding.provider as Eip1193Provider, binding.account, capability); if (request !== balanceRequest) return;
      const token = swapForm().tokenIn; const atomic = token === "USDC" ? balances.usdc : balances.eurc;
      text($(page, "#swap-balance"), `Available balance: ${atomic == null ? "unavailable" : `${formatUsdc(atomic)} ${token}`}`);
      if (bridgeSource === "Arc") text($(page, "#bridge-balance"), `Source balance: ${formatUsdc(balances.usdc)} USDC`);
      const reserveAtomic = balances.native / NATIVE_PER_ATOMIC;
      text($(page, "#swap-gas"), `Arc native gas balance: ${formatUsdc(reserveAtomic)} USDC equivalent. Keep a reserve; Max is intentionally unavailable.`);
    } catch { if (request === balanceRequest) { text($(page, "#swap-balance"), "Available balance: read unavailable"); text($(page, "#bridge-balance"), "Source balance: read unavailable"); } }
  };
  $(page, "#swap-from").addEventListener("change", () => void refreshBalances());

  try {
    capability = probeInstalledCircleCapabilities();
    text($(page, "#trade-capability"), `${capability.title} · chain ${capability.chainId} · Swap ${capability.swap ? "available" : "unavailable"} · Bridge ${capability.bridge ? "available" : "unavailable"}`);
  } catch (error: any) {
    text($(page, "#trade-capability"), `Capability blocked: ${String(error?.message || error)}`);
    $(page, "#swap-quote").disabled = true; $(page, "#bridge-quote").disabled = true;
  }

  arcfxWallet.watch(() => {
    invalidateSwap(); invalidateBridge();
    const binding = currentBinding();
    if (circleCache && circleCache.provider !== binding?.provider) circleCache = null;
    const recipient = $(page, "#bridge-recipient") as HTMLInputElement;
    if (!recipientTouched) recipient.value = binding?.account || "";
    void refreshBalances();
  });
}
