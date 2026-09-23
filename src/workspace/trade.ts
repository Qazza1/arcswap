import "./trade.css";
import { BrowserProvider, Contract } from "ethers";
import { arcfxWallet, ARC_MAINNET_CHAIN_ID_HEX, type Eip1193Provider } from "../shared/wallet";
import { appPath } from "../shared/appOrigin";
import { formatUsdc, MAINNET, NATIVE_PER_ATOMIC } from "./mainnetPayments";
import { bridgeAmountMaxFeeIssue, CIRCLE_SDK_ID, createLocalBridgeProofClient, createLocalSwapProofClient, createReadonlyCircleClient, probeInstalledCircleCapabilities, type ArcCapability, type ReadonlyCircleClient } from "./circleAppKit";
import { createSwapSnapshot, swapSnapshotIsCurrent, validateSwapForm, type SwapForm, type SwapQuoteSnapshot, type WalletBinding } from "./swapCore";
import { BRIDGE_CHAINS, bridgeSnapshotIsCurrent, createBridgeSnapshot, validateBridgeForm, type BridgeChain, type BridgeForm, type BridgeQuoteSnapshot } from "./bridgeCore";
import { LOCAL_BRIDGE_PROOF_ENABLED, LOCAL_SWAP_PROOF_ENABLED, TRADE_EXECUTION_DISABLED_REASON } from "./tradeExecutionGate";

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];
const $ = (root: ParentNode, selector: string): any => root.querySelector(selector) as HTMLElement;
const text = (target: HTMLElement, value: string) => { target.textContent = value; };
const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const feeText = (fees: readonly { type: string; token: string; amount: string | null; network?: string }[]) => fees.length
  ? fees.map(fee => `${fee.type}${fee.network ? ` · ${fee.network}` : ""}: ${fee.amount ?? "unavailable"} ${fee.token}`).join(" · ")
  : "No fee breakdown returned by the provider.";

function currentBinding(): WalletBinding | null {
  const provider = arcfxWallet.provider;
  const account = arcfxWallet.address;
  const chainId = arcfxWallet.chainId;
  return provider && account && chainId ? { provider, account, chainId } : null;
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

  const page = document.createElement("div");
  page.className = "trade-page";
  page.innerHTML = `<header class="trade-heading"><div><p class="trade-kicker">Treasury · development surface</p><div class="trade-title-row"><h1>Swap &amp; Bridge</h1><span class="trade-badge">TESTNET</span></div><p>Inspect Mainnet treasury routes, exact estimates, and fees before execution support is separately enabled.</p></div><div class="trade-capability" id="trade-capability" role="status">Checking installed Circle capabilities…</div></header>
    <aside class="trade-safety"><strong>Execution gated off</strong><span>${TRADE_EXECUTION_DISABLED_REASON} Quotes and reviews cannot approve tokens, sign messages, switch networks, burn, mint, swap, or bridge.</span></aside>
    <div class="trade-tabs" role="tablist" aria-label="Treasury movement"><button type="button" role="tab" aria-selected="true" data-tab="swap">Swap</button><button type="button" role="tab" aria-selected="false" data-tab="bridge">Bridge</button></div>
    <section class="trade-panel" id="trade-swap" role="tabpanel"><div class="trade-form-card"><div class="trade-section-head"><div><p class="trade-eyebrow">Treasury conversion</p><h2>Swap on Arc Mainnet</h2></div><span class="trade-network">Arc · 5042</span></div>
      <div class="trade-grid"><label>From token<select id="swap-from"><option>USDC</option><option>EURC</option></select></label><label>To token<select id="swap-to"><option>EURC</option><option>USDC</option></select></label><label class="trade-wide">Amount<input id="swap-amount" inputmode="decimal" autocomplete="off" placeholder="0.00"/><small id="swap-balance">Available balance: connect a wallet to read</small></label><label>Slippage<select id="swap-slippage"><option value="50">0.50%</option><option value="100">1.00%</option><option value="300">3.00%</option></select></label></div>
      <p class="trade-gas" id="swap-gas">Arc network fees use the native 18-decimal USDC representation. Keep a reserve; Max is intentionally unavailable.</p><div class="trade-actions"><button class="trade-button trade-button--primary" id="swap-quote" type="button">Get read-only quote</button><button class="trade-button" id="swap-review" type="button" disabled>Review swap</button>${LOCAL_SWAP_PROOF_ENABLED ? '<button class="trade-button trade-button--danger" id="swap-local-proof" type="button" disabled>Run local ≤1 USDC proof</button>' : ""}</div><p class="trade-message" id="swap-message" role="status"></p></div>
      <article class="trade-quote" id="swap-output" hidden><p class="trade-eyebrow">Circle estimate</p><h3 id="swap-receive">—</h3><dl><div><dt>Minimum received</dt><dd id="swap-minimum">—</dd></div><div><dt>Route</dt><dd id="swap-route">—</dd></div><div><dt>Provider</dt><dd>Circle App Kit</dd></div><div><dt>Fees</dt><dd id="swap-fees">—</dd></div><div><dt>Approval metadata</dt><dd>Not exposed by this read-only estimate</dd></div><div><dt>Quote window</dt><dd id="swap-time">—</dd></div></dl><div class="trade-review" id="swap-review-panel" hidden><strong>Review only — execution is not enabled</strong><p>This snapshot is bound to the selected wallet, account, network, amount, assets, and slippage. There is no approval or swap action in the normal product.</p>${LOCAL_SWAP_PROOF_ENABLED ? '<p><strong>Local proof mode:</strong> this dev-server-only control requires USDC → EURC, 1 USDC or less, zero existing adapter allowance, and the native Arc gas reserve. The pinned wallet will ask separately for exact approval and swap confirmation.</p>' : ""}</div><div class="trade-review" id="swap-proof-result" hidden><strong>Local proof result</strong><p id="swap-proof-approval">Approval: awaiting wallet result</p><p id="swap-proof-tx">Swap: awaiting wallet result</p></div></article>
    </section>
    <section class="trade-panel" id="trade-bridge" role="tabpanel" hidden><div class="trade-form-card"><div class="trade-section-head"><div><p class="trade-eyebrow">USDC movement</p><h2>Bridge route estimate</h2></div><span class="trade-network">CCTP-aware</span></div>
      <div class="trade-grid"><label>From network<select id="bridge-from"><option>Arc</option><option>Ethereum</option><option>Base</option></select></label><label>To network<select id="bridge-to"><option>Base</option><option>Ethereum</option><option>Arc</option></select></label><label>Asset<input value="USDC" readonly aria-readonly="true"/></label><label>Amount<input id="bridge-amount" inputmode="decimal" autocomplete="off" placeholder="0.00"/><small id="bridge-balance">Source balance: connect a wallet to read</small></label><label class="trade-wide">Destination wallet<input id="bridge-recipient" autocomplete="off" spellcheck="false" placeholder="0x…"/><small>Defaults visually to the connected owner wallet; it remains editable.</small></label></div>
      <p class="trade-gas" id="bridge-context">Routes are shown only after the installed SDK validates the selected pair. Arc chain 5042 is distinct from CCTP domain 26.</p><div class="trade-actions"><button class="trade-button trade-button--primary" id="bridge-quote" type="button">Get route estimate</button><button class="trade-button" id="bridge-review" type="button" disabled>Review bridge</button>${LOCAL_BRIDGE_PROOF_ENABLED ? '<button class="trade-button trade-button--danger" id="bridge-local-proof" type="button" disabled>Run local ≤0.01 USDC bridge proof</button>' : ""}</div><p class="trade-message" id="bridge-message" role="status"></p></div>
      <article class="trade-quote" id="bridge-output" hidden><p class="trade-eyebrow">Circle estimate</p><h3 id="bridge-receive">—</h3><dl><div><dt>Route</dt><dd id="bridge-route">—</dd></div><div><dt>Provider</dt><dd>Circle App Kit</dd></div><div><dt>Protocol / service fees</dt><dd id="bridge-fees">—</dd></div><div><dt>Network fees</dt><dd id="bridge-gas-fees">—</dd></div><div><dt>Transfer / finality mode</dt><dd>Provider default · not returned by current estimate</dd></div><div><dt>Estimated timing</dt><dd>Not returned by current provider</dd></div><div><dt>Quote identity</dt><dd id="bridge-quote-id">Not returned</dd></div><div><dt>Expected steps</dt><dd>Allowance check → approval if needed → source burn → attestation → destination mint (not executed)</dd></div><div><dt>Estimate window</dt><dd id="bridge-time">—</dd></div></dl><div class="trade-review" id="bridge-review-panel" hidden><strong>Review only — bridge execution is not enabled</strong><p>No approval, burn, attestation relay, retry, or destination mint can be started from this page in Step 8B.</p>${LOCAL_BRIDGE_PROOF_ENABLED ? '<p><strong>Local bridge proof mode:</strong> this dev-server-only control accepts Arc → Base USDC only, 0.01 USDC or less, to the same selected wallet. It performs one source attempt only; no automatic network switch, retry, resume, or re-attestation is available.</p>' : ""}</div><div class="trade-review" id="bridge-proof-result" hidden><strong>Local bridge proof result</strong><p id="bridge-proof-source">Source: awaiting Circle result</p><p id="bridge-proof-attestation">Attestation: awaiting Circle result</p><p id="bridge-proof-destination">Destination: awaiting Circle result</p><p id="bridge-proof-diagnostic">Diagnostic: awaiting Circle result</p></div></article>
    </section>`;
  root.replaceChildren(page);

  const swapForm = (): SwapForm => ({ tokenIn: $(page, "#swap-from").value as SwapForm["tokenIn"], tokenOut: $(page, "#swap-to").value as SwapForm["tokenOut"], amount: $(page, "#swap-amount").value, slippageBps: Number($(page, "#swap-slippage").value) });
  const bridgeForm = (): BridgeForm => ({ source: $(page, "#bridge-from").value as BridgeChain, destination: $(page, "#bridge-to").value as BridgeChain, amount: $(page, "#bridge-amount").value, recipient: $(page, "#bridge-recipient").value });
  const invalidateSwap = () => { swapQuote = null; $(page, "#swap-review").disabled = true; const proof = $(page, "#swap-local-proof"); if (proof) proof.disabled = true; $(page, "#swap-review-panel").hidden = true; $(page, "#swap-proof-result").hidden = true; $(page, "#swap-output").hidden = true; };
  // A local proof attempt consumes the reviewed snapshot even if the wallet
  // rejects, times out, or only returns partial SDK information. The user must
  // explicitly request and review a new quote before another mutation attempt.
  const consumeLocalProofReview = () => { swapQuote = null; $(page, "#swap-review").disabled = true; const proof = $(page, "#swap-local-proof"); if (proof) proof.disabled = true; };
  const invalidateBridge = () => { bridgeQuote = null; $(page, "#bridge-review").disabled = true; const proof = $(page, "#bridge-local-proof"); if (proof) proof.disabled = true; $(page, "#bridge-review-panel").hidden = true; $(page, "#bridge-proof-result").hidden = true; $(page, "#bridge-output").hidden = true; };
  const consumeLocalBridgeReview = () => { bridgeQuote = null; $(page, "#bridge-review").disabled = true; const proof = $(page, "#bridge-local-proof"); if (proof) proof.disabled = true; };

  page.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(button => button.addEventListener("click", () => {
    page.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(item => item.setAttribute("aria-selected", String(item === button)));
    $(page, "#trade-swap").hidden = button.dataset.tab !== "swap";
    $(page, "#trade-bridge").hidden = button.dataset.tab !== "bridge";
  }));
  page.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#trade-swap input, #trade-swap select").forEach(input => input.addEventListener("input", invalidateSwap));
  page.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#trade-bridge input, #trade-bridge select").forEach(input => input.addEventListener("input", () => { if (input.id === "bridge-recipient") recipientTouched = true; invalidateBridge(); }));

  const quoteGate = (sourceChain = "Arc"): { binding?: WalletBinding; error?: string } => {
    const binding = currentBinding();
    if (!binding) return { error: `Connect and verify a wallet at ${appPath("/entry")} before requesting a quote.` };
    const expected = BRIDGE_CHAINS[sourceChain as BridgeChain]?.chainIdHex;
    if (!expected || binding.chainId.toLowerCase() !== expected) return { error: `Switch to ${sourceChain} manually in the selected wallet before requesting this source-chain quote. ArcFX will not switch networks automatically.` };
    return { binding };
  };

  $(page, "#swap-quote").addEventListener("click", async () => {
    invalidateSwap(); const message = $(page, "#swap-message"); text(message, "Checking the current read-only route…");
    const form = swapForm(); const valid = validateSwapForm(form); const gate = quoteGate("Arc");
    if (valid.error || gate.error || !gate.binding || !capability?.swap) { text(message, valid.error || gate.error || "Circle does not advertise Arc Mainnet swaps in this SDK."); return; }
    try {
      const result = await (await circleFor(gate.binding.provider as Eip1193Provider)).estimateSwap({ chain: capability.chainIdentifier, tokenIn: form.tokenIn, tokenOut: form.tokenOut, amount: form.amount.trim(), slippageBps: form.slippageBps });
      if (currentBinding()?.provider !== gate.binding.provider) throw new Error("The selected wallet provider changed. Request a fresh quote.");
      swapQuote = createSwapSnapshot({ binding: gate.binding, form, amountAtomic: valid.amountAtomic!, route: result.route, quoteId: result.quoteId, estimatedOutput: result.estimatedOutput, minimumReceived: result.minimumReceived, fees: result.fees, sdk: CIRCLE_SDK_ID });
      $(page, "#swap-output").hidden = false; text($(page, "#swap-receive"), `Estimated receive ${result.estimatedOutput} ${result.outputToken}`); text($(page, "#swap-minimum"), `${result.minimumReceived} ${result.outputToken}`); text($(page, "#swap-route"), result.route); text($(page, "#swap-fees"), feeText(result.fees)); text($(page, "#swap-time"), `${time(swapQuote.createdAt)} · refresh after ${time(swapQuote.validUntil)}`); $(page, "#swap-review").disabled = false; text(message, "Read-only quote ready. It expires locally after 60 seconds.");
    } catch (error: any) { text(message, `Quote unavailable: ${String(error?.message || error)}`); }
  });
  $(page, "#swap-review").addEventListener("click", () => {
    const current = swapSnapshotIsCurrent(swapQuote, swapForm(), currentBinding());
    if (!current) { invalidateSwap(); text($(page, "#swap-message"), "This quote is stale or the wallet context changed. Request a fresh quote."); return; }
    $(page, "#swap-review-panel").hidden = false;
    const proof = $(page, "#swap-local-proof");
    if (proof && swapQuote!.amountAtomic <= 1_000_000n) proof.disabled = false;
  });

  const localProof = $(page, "#swap-local-proof") as HTMLButtonElement | null;
  localProof?.addEventListener("click", async () => {
    if (localProofBusy) return;
    const binding = currentBinding(); const form = swapForm();
    if (!swapQuote || !binding || !swapSnapshotIsCurrent(swapQuote, form, binding) || binding.provider !== swapQuote.binding.provider) {
      invalidateSwap(); text($(page, "#swap-message"), "The reviewed quote or selected wallet changed. Request and review a fresh quote."); return;
    }
    if (swapQuote.amountAtomic > 1_000_000n || form.tokenIn !== "USDC" || form.tokenOut !== "EURC") {
      text($(page, "#swap-message"), "Local proof is limited to one USDC or less for USDC → EURC only."); return;
    }
    localProofBusy = true; localProof.disabled = true;
    text($(page, "#swap-message"), "Checking the fresh route, exact selected wallet, allowance, and gas reserve before any wallet prompt…");
    try {
      const proof = await createLocalSwapProofClient(binding.provider as Eip1193Provider);
      const result = await proof.executeExactUsdcToEurc({
        account: binding.account, amount: form.amount.trim(), slippageBps: form.slippageBps,
        reviewed: { route: swapQuote.route, estimatedOutput: swapQuote.estimatedOutput, minimumReceived: swapQuote.minimumReceived, fees: swapQuote.fees },
      });
      $(page, "#swap-proof-result").hidden = false;
      text($(page, "#swap-proof-approval"), result.approvalTxHashes.length ? `Approval: ${result.approvalTxHashes.join(", ")}` : "Approval: Circle reported no separate approval hash.");
      text($(page, "#swap-proof-tx"), `Swap: ${result.swapTxHash}${result.result.amountOut ? ` · received ${result.result.amountOut} EURC` : ""}`);
      console.info("ArcFX local swap proof result", { approvalTxHashes: result.approvalTxHashes, swapTxHash: result.swapTxHash, progress: result.result.progress, amountOut: result.result.amountOut });
      text($(page, "#swap-message"), "Local proof returned. Record the displayed transaction hashes; no automatic retry will occur.");
    } catch (error: any) {
      text($(page, "#swap-message"), `Local proof stopped: ${String(error?.message || error)}`);
    } finally {
      localProofBusy = false;
      consumeLocalProofReview();
    }
  });

  $(page, "#bridge-quote").addEventListener("click", async () => {
    invalidateBridge(); const message = $(page, "#bridge-message"); text(message, "Checking the selected route with Circle…");
    const form = bridgeForm(); const valid = validateBridgeForm(form); const gate = quoteGate(form.source);
    if (valid.error || gate.error || !gate.binding || !capability?.bridge) { text(message, valid.error || gate.error || "Circle does not advertise Arc Mainnet bridges in this SDK."); return; }
    try {
      const result = await (await circleFor(gate.binding.provider as Eip1193Provider)).estimateBridge({ sourceChain: BRIDGE_CHAINS[form.source].sdk, destinationChain: BRIDGE_CHAINS[form.destination].sdk, recipient: form.recipient.trim(), amount: form.amount.trim() });
      if (currentBinding()?.provider !== gate.binding.provider) throw new Error("The selected wallet provider changed. Request a fresh estimate.");
      const allFees = [...result.fees, ...result.gasFees];
      bridgeQuote = createBridgeSnapshot({ binding: gate.binding, form, amountAtomic: valid.amountAtomic!, route: result.route, quoteId: result.quoteId, estimatedReceive: result.amount, fees: allFees, warnings: result.warnings, sdk: CIRCLE_SDK_ID });
      const maxFeeIssue = bridgeAmountMaxFeeIssue(result.amount, result.maxFee);
      $(page, "#bridge-output").hidden = false; text($(page, "#bridge-receive"), `Estimated destination amount ${result.amount} USDC`); text($(page, "#bridge-route"), result.route); text($(page, "#bridge-fees"), feeText(result.fees)); text($(page, "#bridge-gas-fees"), feeText(result.gasFees)); text($(page, "#bridge-quote-id"), result.quoteId || "Not returned"); text($(page, "#bridge-time"), `${time(bridgeQuote.createdAt)} · refresh after ${time(bridgeQuote.validUntil)}`); $(page, "#bridge-review").disabled = Boolean(maxFeeIssue); text(message, maxFeeIssue || (result.warnings.length ? `Estimate ready with provider warning: ${result.warnings.join(" · ")}` : "Read-only route estimate ready. It expires locally after 60 seconds."));
    } catch (error: any) { text(message, `Route unavailable: ${String(error?.message || error)}`); }
  });
  $(page, "#bridge-review").addEventListener("click", () => {
    const current = bridgeSnapshotIsCurrent(bridgeQuote, bridgeForm(), currentBinding());
    if (!current) { invalidateBridge(); text($(page, "#bridge-message"), "This estimate is stale or the wallet context changed. Request a fresh estimate."); return; }
    $(page, "#bridge-review-panel").hidden = false;
    const binding = currentBinding(); const form = bridgeForm(); const proof = $(page, "#bridge-local-proof");
    if (proof && binding && !bridgeProofSourceStarted && bridgeQuote!.amountAtomic <= 10_000n
      && form.source === "Arc" && form.destination === "Base" && form.recipient.trim().toLowerCase() === binding.account.toLowerCase()) proof.disabled = false;
  });

  const localBridgeProof = $(page, "#bridge-local-proof") as HTMLButtonElement | null;
  localBridgeProof?.addEventListener("click", async () => {
    if (localBridgeProofBusy) return;
    if (bridgeProofSourceStarted) { text($(page, "#bridge-message"), "A local bridge source attempt already began. Verify its displayed state manually; ArcFX will not repeat it."); return; }
    const binding = currentBinding(); const form = bridgeForm();
    if (!bridgeQuote || !binding || !bridgeSnapshotIsCurrent(bridgeQuote, form, binding) || binding.provider !== bridgeQuote.binding.provider) {
      invalidateBridge(); text($(page, "#bridge-message"), "The reviewed estimate or selected wallet changed. Request and review a fresh estimate."); return;
    }
    if (bridgeQuote.amountAtomic > 10_000n || form.source !== "Arc" || form.destination !== "Base" || form.recipient.trim().toLowerCase() !== binding.account.toLowerCase()) {
      text($(page, "#bridge-message"), "Local bridge proof is limited to Arc → Base, same-wallet USDC, and 0.01 USDC or less."); return;
    }
    localBridgeProofBusy = true; localBridgeProof.disabled = true;
    text($(page, "#bridge-message"), "Checking a fresh Arc → Base estimate, selected wallet, and native gas reserve before any wallet prompt…");
    const showObservation = (observation: any, originalBridgeErrorDiagnostic?: any) => {
      if (!observation) return;
      $(page, "#bridge-proof-result").hidden = false;
      text($(page, "#bridge-proof-source"), observation.sourceTxHashes?.length ? `Source: ${observation.sourceTxHashes.join(", ")}` : `Source: ${observation.state || "stopped"}${observation.errorState ? ` (${observation.errorState})` : ""}; Circle returned no source transaction hash.`);
      text($(page, "#bridge-proof-attestation"), `Attestation: ${observation.attestationState || "not returned"}`);
      text($(page, "#bridge-proof-destination"), observation.destinationTxHashes?.length ? `Destination (${observation.destinationState}): ${observation.destinationTxHashes.join(", ")}` : `Destination: ${observation.destinationState || "not returned"}`);
      const original = originalBridgeErrorDiagnostic || observation.originalError;
      text($(page, "#bridge-proof-diagnostic"), `Diagnostic: state ${observation.state}; provider ${observation.provider}; ${observation.sourceChain} → ${observation.destinationChain}; steps ${observation.steps.map((step: any) => `${step.name}:${step.state}:${step.attempted ? "attempted" : "not-attempted"}${step.errorCategory ? `:${step.errorCategory}` : ""}${step.errorCode ? `:${step.errorCode}` : ""}${step.errorMessage ? `:${step.errorMessage}` : ""}`).join(" · ") || "none"}${observation.errorState ? `; error ${observation.errorState}` : ""}${observation.errorCode ? `:${observation.errorCode}` : ""}${observation.errorMessage ? `:${observation.errorMessage}` : ""}${original ? `; Original Circle error: name ${original.name || "not returned"}; code ${original.code || "not returned"}; message ${original.message || "not returned"}; shortMessage ${original.shortMessage || "not returned"}; reason ${original.reason || "not returned"}; details ${original.details || "not returned"}; cause ${original.cause.join(" | ") || "not returned"}; keys ${original.keys.join(", ") || "none"}` : ""}`);
    };
    try {
      const proof = await createLocalBridgeProofClient(binding.provider as Eip1193Provider);
      const result = await proof.executeArcToBaseUsdc({
        account: binding.account, amount: form.amount.trim(),
        reviewed: { route: bridgeQuote.route, amount: bridgeQuote.estimatedReceive, sourceChain: form.source, destinationChain: form.destination, recipient: form.recipient.trim(), maxFee: null, fees: bridgeQuote.fees.filter(fee => !fee.network), gasFees: bridgeQuote.fees.filter(fee => Boolean(fee.network)), warnings: bridgeQuote.warnings },
        onSourceSubmissionStart: () => { bridgeProofSourceStarted = true; },
      });
      showObservation(result);
      console.info("ArcFX local bridge proof result", { state: result.state, provider: result.provider, sourceChain: result.sourceChain, destinationChain: result.destinationChain, errorState: result.errorState, errorCode: result.errorCode, errorMessage: result.errorMessage, steps: result.steps, sourceTxHashes: result.sourceTxHashes, destinationTxHashes: result.destinationTxHashes, attestationState: result.attestationState, destinationState: result.destinationState });
      text($(page, "#bridge-message"), /^(success|complete)$/i.test(result.state) ? "Local bridge proof completed. Record the displayed source and destination state; no automatic retry or recovery will occur." : "Local bridge proof stopped after source activity. Verify the displayed source state; ArcFX will not retry or resume it.");
    } catch (error: any) {
      showObservation(error?.bridgeProofObservation, error?.originalBridgeErrorDiagnostic);
      text($(page, "#bridge-message"), `Local bridge proof stopped: ${String(error?.message || error)}`);
    } finally {
      localBridgeProofBusy = false;
      consumeLocalBridgeReview();
    }
  });

  const refreshBalances = async () => {
    const request = ++balanceRequest; const binding = currentBinding();
    if (!binding || binding.chainId.toLowerCase() !== ARC_MAINNET_CHAIN_ID_HEX || !capability) { text($(page, "#swap-balance"), "Available balance: Arc Mainnet wallet required"); text($(page, "#bridge-balance"), "Source balance: available on Arc when selected"); return; }
    try {
      const balances = await readArcBalances(binding.provider as Eip1193Provider, binding.account, capability); if (request !== balanceRequest) return;
      const token = swapForm().tokenIn; const atomic = token === "USDC" ? balances.usdc : balances.eurc;
      text($(page, "#swap-balance"), `Available balance: ${atomic == null ? "unavailable" : `${formatUsdc(atomic)} ${token}`}`);
      text($(page, "#bridge-balance"), `Source balance: ${formatUsdc(balances.usdc)} USDC`);
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
