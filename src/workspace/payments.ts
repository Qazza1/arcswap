/**
 * Arc Mainnet Send and Multisend / Payouts inside the app shell.
 *
 * Page load performs only silent reads (eth_accounts, eth_chainId, eth_call,
 * gas estimates). Nothing is signed or sent until the owner clicks the final
 * Send / Approve / Execute button, and the pinned EIP-6963 provider is the only
 * provider used.
 */
import "./payments.css";
import { BrowserProvider, Contract } from "ethers";
import { arcfxApi } from "../shared/arcfxApi";
import { arcfxWallet } from "../shared/wallet";
import { appPath } from "../shared/appOrigin";
import { allowanceAction } from "../payer/mainnetInvoice";
import {
  MAINNET, MULTISENDER, NATIVE_PER_ATOMIC, explorerTx, formatNative, formatUsdc, sameAddress, sameChain, shortAddress,
} from "./mainnetPayments";
import { buildSendReview, createSendExecutor, validateSend, walletBlocker, type SendReview, type SendState, type WalletSnapshot } from "./sendCore";
import {
  CSV_MAX_BYTES, CSV_TEMPLATE, batchWalletBlocker, buildBatch, buildBatchReview, createBatchExecutor, parseCsv,
  type Batch, type BatchReview, type BatchState, type BatchWallet,
} from "./multisendCore";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const MULTISENDER_ABI = [
  "function multisendFree(address token, address[] recipients, uint256[] amounts) external",
  "function multisend(address token, address[] recipients, uint256[] amounts) external",
];

// ── small DOM helpers ────────────────────────────────────────────────────────

type Attrs = Record<string, string | boolean | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string, attrs: Attrs = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? "" : value);
  }
  return node;
}
let uid = 0;
const nextId = (prefix: string) => `${prefix}-${++uid}`;

function labelled(label: string, input: HTMLElement, help?: string) {
  const wrap = h("div", "pay-field");
  const id = input.id || (input.id = nextId("pay-input"));
  const lab = h("label", "", label, { for: id });
  const error = h("p", "pay-error", "", { id: `${id}-error`, hidden: true });
  wrap.append(lab, input);
  if (help) {
    const helpNode = h("p", "pay-help", help, { id: `${id}-help` });
    wrap.append(helpNode);
  }
  wrap.append(error);
  const setError = (text = "") => {
    error.textContent = text;
    error.hidden = !text;
    if (text) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", error.id); }
    else { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); }
  };
  return { wrap, input, setError };
}

function definition(rows: Array<[string, string | Node]>) {
  const dl = h("dl", "pay-summary");
  for (const [term, value] of rows) {
    const dt = h("dt", "", term);
    const dd = h("dd");
    if (typeof value === "string") dd.textContent = value; else dd.append(value);
    dl.append(dt, dd);
  }
  return dl;
}

// ── wallet reads (silent; never prompts) ─────────────────────────────────────

function pinnedProvider(): BrowserProvider | null {
  return arcfxWallet.provider ? new BrowserProvider(arcfxWallet.provider as any) : null;
}

/**
 * Live account and chain straight from the pinned provider, cross-checked with
 * ArcFX's own wallet state. Any disagreement is treated as "no account" so the
 * flow fails closed.
 */
async function liveIdentity(): Promise<{ account: string | null; chainIdHex: string | null }> {
  const raw = arcfxWallet.provider;
  if (!raw || arcfxWallet.isExplicitlySignedOut) return { account: null, chainIdHex: null };
  const [accounts, chainId] = await Promise.all([
    raw.request({ method: "eth_accounts" }) as Promise<string[]>,
    raw.request({ method: "eth_chainId" }) as Promise<string>,
  ]);
  const account = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
  if (!account || !sameAddress(account, arcfxWallet.address)) return { account: null, chainIdHex: typeof chainId === "string" ? chainId : null };
  return { account, chainIdHex: typeof chainId === "string" ? chainId : null };
}

async function readWallet(withAllowance: boolean): Promise<BatchWallet> {
  const identity = await liveIdentity();
  const base: BatchWallet = { ...identity, balanceAtomic: null, allowanceAtomic: null, nativeWei: null };
  if (!identity.account || !sameChain(identity.chainIdHex, MAINNET.chainIdHex)) return base;
  const provider = pinnedProvider();
  if (!provider) return base;
  const usdc = new Contract(MAINNET.usdc, ERC20_ABI, provider);
  try {
    base.balanceAtomic = BigInt(await usdc.balanceOf(identity.account));
    // On Arc the native balance and the ERC-20 balance are the same funds; the network fee is paid from it.
    base.nativeWei = BigInt(await provider.getBalance(identity.account));
    if (withAllowance) base.allowanceAtomic = BigInt(await usdc.allowance(identity.account, MAINNET.multisender));
  } catch { base.balanceAtomic = null; base.allowanceAtomic = null; base.nativeWei = null; }
  return base;
}

async function signerFor(account: string) {
  const provider = pinnedProvider();
  if (!provider) throw new Error("Connect your wallet first.");
  const signer = await provider.getSigner();
  if (!sameAddress(await signer.getAddress(), account)) throw new Error("The selected wallet account changed.");
  return signer;
}

/**
 * Estimated network fee in native wei: gas from the network's own simulation of
 * the exact prepared call (never sent) times the current maximum fee rate. Null
 * means "could not estimate", never zero.
 */
async function estimateFeeWei(estimate: (provider: BrowserProvider) => Promise<bigint>): Promise<bigint | null> {
  try {
    const provider = pinnedProvider();
    if (!provider) return null;
    const [gas, fee] = await Promise.all([estimate(provider), provider.getFeeData()]);
    const price = fee.maxFeePerGas ?? fee.gasPrice;
    return price === null || price === undefined ? null : gas * price;
  } catch { return null; }
}
const feeText = (wei: bigint | null): string =>
  wei === null ? "Unavailable (the network could not simulate this transaction)" : `≈ ${formatNative(wei)} USDC at the current maximum fee rate (the network usually charges less)`;
const FEE_SAME_BALANCE = "USDC, from the same balance as this payment (Arc's native token is USDC)";

// ── saved recipients ─────────────────────────────────────────────────────────

type Saved = { group: "Browser Contacts" | "Customers"; label: string; address: string };

function loadContacts(): Saved[] {
  try {
    const value = JSON.parse(localStorage.getItem("arcfx_address_book") || "[]");
    return Array.isArray(value)
      ? value.filter((x) => typeof x?.name === "string" && /^0x[0-9a-fA-F]{40}$/.test(x?.address)).map((x) => ({ group: "Browser Contacts" as const, label: x.name, address: x.address }))
      : [];
  } catch { return []; }
}

/** Customers only when an owner session already exists, so opening Send never triggers a signature. */
async function loadCustomerAddresses(): Promise<Saved[]> {
  try {
    if (!(await arcfxApi.hasReceivablesOwnerSession())) return [];
    const data = await arcfxApi.listReceivablesCustomersQuiet();
    const out: Saved[] = [];
    for (const c of data.customers || []) {
      for (const a of c.addresses || []) {
        if (typeof a?.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.address)) {
          out.push({ group: "Customers", label: `${c.name}${a.label ? ` — ${a.label}` : ""}`, address: a.address });
        }
      }
    }
    return out;
  } catch { return []; }
}

function savedSelect(target: HTMLInputElement, onPick?: () => void) {
  const select = h("select", "pay-input", undefined, { id: nextId("pay-saved") }) as HTMLSelectElement;
  select.append(Object.assign(h("option", "", "Choose a saved recipient (optional)"), { value: "" }));
  const groups = new Map<string, HTMLOptGroupElement>();
  const add = (items: Saved[]) => {
    for (const item of items) {
      let group = groups.get(item.group);
      if (!group) { group = h("optgroup", "", undefined, { label: item.group }); groups.set(item.group, group); select.append(group); }
      const option = Object.assign(h("option", "", `${item.label} · ${shortAddress(item.address)}`), { value: item.address });
      group.append(option);
    }
  };
  add(loadContacts());
  void loadCustomerAddresses().then(add);
  select.addEventListener("change", () => {
    if (!select.value) return;
    // The address is written into the visible input, where it stays editable and validated.
    target.value = select.value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    select.value = "";
    onPick?.();
  });
  return select;
}

// ── this tab's payments (not stored by ArcFX) ────────────────────────────────

const SESSION_KEY = "arcfx:session-payments:v1";
type SessionPayment = { kind: "send" | "multisend"; hash: string; at: number; summary: string };
function sessionPayments(): SessionPayment[] {
  try { const v = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function rememberPayment(entry: SessionPayment) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify([entry, ...sessionPayments()].slice(0, 20))); } catch { /* tab still works */ }
}
function sessionList(kind: SessionPayment["kind"]) {
  const box = h("section", "pay-card");
  const paint = () => {
    box.replaceChildren(h("h2", "", "Sent from this browser tab"));
    const items = sessionPayments().filter((p) => p.kind === kind);
    box.append(h("p", "pay-help", "Kept only in this tab. ArcFX does not yet record outbound payments in Activity."));
    if (!items.length) { box.append(h("p", "pay-muted", "Nothing sent from this tab yet.")); return; }
    const list = h("ul", "pay-history");
    for (const item of items) {
      const li = h("li");
      const link = h("a", "pay-link", `${shortAddress(item.hash)} ↗`, { href: explorerTx(item.hash), target: "_blank", rel: "noopener noreferrer" });
      li.append(h("span", "", item.summary), h("small", "", new Date(item.at).toLocaleString()), link);
      list.append(li);
    }
    box.append(list);
  };
  paint();
  return { box, paint };
}

// ── wallet gate shared by both pages ─────────────────────────────────────────

type Gate = "disconnected" | "wrong-network" | "ready";
function gateState(): Gate {
  if (!arcfxWallet.connected || !arcfxWallet.address || arcfxWallet.isExplicitlySignedOut) return "disconnected";
  return sameChain(arcfxWallet.chainId, MAINNET.chainIdHex) ? "ready" : "wrong-network";
}

function gatePanel(onChange: (state: Gate) => void) {
  const box = h("section", "pay-card pay-gate");
  const paint = () => {
    const state = gateState();
    box.replaceChildren();
    box.dataset.state = state;
    if (state === "ready") {
      box.append(definition([["Wallet", arcfxWallet.address ?? ""], ["Network", `Arc Mainnet · ${MAINNET.caip2}`]]));
    } else if (state === "wrong-network") {
      const switchButton = h("button", "pay-button pay-button--primary", "Switch to Arc Mainnet", { type: "button" });
      const note = h("p", "pay-error", "", { role: "alert", hidden: true });
      switchButton.addEventListener("click", async () => {
        switchButton.disabled = true;
        try {
          if (!(await arcfxWallet.switchToArcMainnet())) throw new Error("Arc Mainnet was not selected.");
        } catch (e) { note.textContent = e instanceof Error ? e.message : "Could not switch network."; note.hidden = false; }
        finally { switchButton.disabled = false; }
      });
      box.append(h("h2", "", "Switch to Arc Mainnet"), h("p", "pay-help", "Your selected wallet is on a different network (chain 5042 is required). ArcFX never switches it automatically."), switchButton, note);
    } else if (state === "disconnected") {
      box.append(h("h2", "", "Connect your wallet"), h("p", "pay-help", "Open secure entry to connect the wallet you want to pay from. Nothing is requested from your wallet on this page."), h("a", "pay-button pay-button--primary", "Open secure entry", { href: appPath("/entry") }));
    }
    onChange(state);
  };
  // Until the one silent wallet restore settles, say so instead of guessing.
  box.append(h("p", "pay-help", "Checking the selected wallet…"));
  return { box, paint };
}

/** One status line, announced politely; errors are announced assertively. */
function statusRegion() {
  const box = h("div", "pay-status", "", { role: "status", "aria-live": "polite" });
  const set = (text: string, tone: "" | "ok" | "warn" | "error" = "", link?: { href: string; label: string }) => {
    box.className = `pay-status${tone ? ` pay-status--${tone}` : ""}`;
    box.setAttribute("role", tone === "error" ? "alert" : "status");
    box.replaceChildren(text ? h("span", "", text) : "");
    if (link) box.append(" ", h("a", "pay-link", link.label, { href: link.href, target: "_blank", rel: "noopener noreferrer" }));
    box.hidden = !text;
  };
  set("");
  return { box, set };
}

function pageShell(root: HTMLElement, title: string, intro: string) {
  const page = h("div", "pay-page");
  page.append(
    h("p", "pay-kicker", "ArcFX workspace"),
    h("h1", "", title),
    h("p", "pay-intro", intro),
    h("span", "pay-pill", "Arc Mainnet · live"),
  );
  root.replaceChildren(page);
  return page;
}

// ═════════════════════════════════════════════════════════════════════════════
// SEND
// ═════════════════════════════════════════════════════════════════════════════

export function mountSend(root: HTMLElement) {
  const page = pageShell(root, "Send USDC", "Send USDC directly to a wallet on Arc Mainnet. You review the payment first, then confirm one transaction in your wallet.");
  const status = statusRegion();
  let review: SendReview | null = null;
  let executor: ReturnType<typeof createSendExecutor> | null = null;
  let balance: bigint | null = null;

  const gate = gatePanel((state) => {
    form.hidden = state !== "ready" || review !== null;
    if (state !== "ready" && review) { review = null; reviewPanel.hidden = true; status.set("Your wallet changed. Review the payment again.", "warn"); }
    if (state === "ready") void refreshBalance();
  });

  // Editing form
  const recipient = h("input", "pay-input pay-mono", undefined, { id: "send-recipient", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "0x…" }) as HTMLInputElement;
  const amount = h("input", "pay-input", undefined, { id: "send-amount", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "0.00" }) as HTMLInputElement;
  const recipientField = labelled("Recipient wallet address", recipient);
  const saved = savedSelect(recipient, () => recipient.focus());
  const savedField = labelled("Saved recipients", saved, "Browser Contacts are stored in this browser. Customers appear when you are signed in and they have a wallet address.");
  const amountField = labelled("Amount (USDC)", amount, "Up to 6 decimal places. Sent as canonical Arc Mainnet USDC.");
  const balanceLine = h("p", "pay-help", "");
  const reference = h("input", "pay-input", undefined, { id: "send-reference", type: "text", maxlength: "80", autocomplete: "off" }) as HTMLInputElement;
  const referenceField = labelled("Reference (optional)", reference, "A note for your own records. It is shown in this tab's list only and is never sent on chain or to ArcFX.");
  const reviewButton = h("button", "pay-button pay-button--primary", "Review payment", { type: "submit" });
  const form = h("form", "pay-card pay-form", undefined, { novalidate: true });
  form.hidden = true; // shown once the wallet is confirmed ready on Arc Mainnet
  form.append(h("h2", "", "Payment details"), savedField.wrap, recipientField.wrap, amountField.wrap, balanceLine, referenceField.wrap, reviewButton);

  const values = () => ({ recipient: recipient.value, amount: amount.value });
  let attempted = false;
  const revalidate = () => {
    if (!attempted) return;
    const checked = validateSend(values(), arcfxWallet.address);
    recipientField.setError(checked.errors.recipient);
    amountField.setError(checked.errors.amount);
  };
  recipient.addEventListener("input", revalidate);
  amount.addEventListener("input", revalidate);
  const refreshBalance = async () => {
    balanceLine.textContent = "Reading your USDC balance…";
    try {
      const wallet = await readWallet(false);
      balance = wallet.balanceAtomic;
      balanceLine.textContent = balance === null ? "Your USDC balance could not be read (Arc Mainnet RPC unavailable)." : `Your USDC balance: ${formatUsdc(balance)} USDC`;
    } catch { balance = null; balanceLine.textContent = "Your USDC balance could not be read (Arc Mainnet RPC unavailable)."; }
  };

  // Review panel
  const reviewPanel = h("section", "pay-card pay-review", undefined, { "aria-labelledby": "send-review-title" });
  reviewPanel.hidden = true;
  const sendButton = h("button", "pay-button pay-button--primary", "Send USDC", { type: "button" });
  const editButton = h("button", "pay-button", "Edit payment", { type: "button" });
  const result = h("section", "pay-card pay-result", undefined, { "aria-live": "polite" });
  result.hidden = true;
  const history = sessionList("send");

  const setBusy = (busy: boolean) => { sendButton.disabled = busy; editButton.disabled = busy; };
  const goEdit = () => { review = null; executor = null; reviewPanel.hidden = true; form.hidden = gateState() !== "ready"; status.set(""); setBusy(false); recipient.focus(); };
  editButton.addEventListener("click", goEdit);

  const showReview = (r: SendReview) => {
    reviewPanel.replaceChildren(h("h2", "", "Review payment", { id: "send-review-title" }));
    const spendWei = r.amountAtomic * NATIVE_PER_ATOMIC;
    reviewPanel.append(definition([
      ["Recipient", h("code", "pay-mono", r.recipient)],
      ["Amount", `${formatUsdc(r.amountAtomic)} USDC`],
      ["Token", `USDC · ${shortAddress(r.token)} (canonical Arc Mainnet USDC)`],
      ["Network", `Arc Mainnet · ${MAINNET.caip2}`],
      ["From", h("code", "pay-mono", r.account)],
      ["Your USDC balance", `${formatUsdc(r.balanceAtomic)} USDC`],
      ["Estimated network fee", feeText(r.feeEstimateWei)],
      ["Network fee is paid in", FEE_SAME_BALANCE],
      ["Estimated total from your wallet", r.feeEstimateWei === null ? `${formatUsdc(r.amountAtomic)} USDC plus the network fee` : `≈ ${formatNative(spendWei + r.feeEstimateWei)} USDC`],
      ["Estimated balance after", r.feeEstimateWei === null ? "Unavailable" : `≈ ${formatNative(r.balanceAtomic * NATIVE_PER_ATOMIC - spendWei - r.feeEstimateWei)} USDC`],
      ["Transaction type", "ERC-20 transfer: USDC.transfer(recipient, amount). No approval is involved."],
    ]));
    const actions = h("div", "pay-actions");
    actions.append(sendButton, editButton);
    reviewPanel.append(actions, h("p", "pay-help", "Clicking Send opens your wallet to confirm one transaction. ArcFX checks the wallet, network, recipient, amount and balance again first."));
    reviewPanel.hidden = false; form.hidden = true;
    sendButton.focus();
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.set("");
    attempted = true;
    reviewButton.disabled = true;
    try {
      const wallet = await readWallet(false);
      const snapshot: WalletSnapshot = { account: wallet.account, chainIdHex: wallet.chainIdHex, balanceAtomic: wallet.balanceAtomic, nativeWei: wallet.nativeWei };
      const built = buildSendReview(values(), snapshot);
      recipientField.setError(built.errors.recipient);
      amountField.setError(built.errors.amount);
      if (built.blocker) { status.set(built.blocker, "error"); return; }
      if (!built.review) { (built.errors.recipient ? recipient : amount).focus(); return; }
      // The network's own simulation of this exact call (never sent) gives the fee, and the fee is
      // paid from the same USDC balance, so it must fit alongside the amount.
      const prepared = built.review;
      const feeWei = await estimateFeeWei((p) => new Contract(MAINNET.usdc, ERC20_ABI, p).transfer.estimateGas(prepared.recipient, prepared.amountAtomic, { from: prepared.account }));
      const feeBlock = walletBlocker(snapshot, prepared.amountAtomic, feeWei);
      if (feeBlock) { status.set(feeBlock, "error"); return; }
      review = { ...prepared, feeEstimateWei: feeWei };
      executor = createSendExecutor({
        readWallet: async () => { const w = await readWallet(false); return { account: w.account, chainIdHex: w.chainIdHex, balanceAtomic: w.balanceAtomic, nativeWei: w.nativeWei }; },
        live: () => ({ recipient: recipient.value.trim(), amountAtomic: validateSend(values(), review?.account ?? null).amountAtomic ?? null }),
        submit: async (r) => {
          const signer = await signerFor(r.account);
          const tx = await new Contract(MAINNET.usdc, ERC20_ABI, signer).transfer(r.recipient, r.amountAtomic);
          return { hash: tx.hash, wait: () => tx.wait() };
        },
        onState: (state) => paintSend(state),
      });
      showReview(review);
    } catch (e) {
      status.set(e instanceof Error ? e.message : "Could not prepare the payment.", "error");
    } finally { reviewButton.disabled = false; }
  });

  const paintSend = (state: SendState) => {
    switch (state.phase) {
      case "checking": setBusy(true); status.set("Checking your wallet and the payment…"); break;
      case "blocked": setBusy(false); status.set(state.reason, "error"); break;
      case "awaiting-wallet": setBusy(true); status.set("Confirm the transfer in your wallet. This is the only transaction."); break;
      case "submitted": setBusy(true); status.set("Submitted. Waiting for Arc Mainnet to confirm it…", "", { href: explorerTx(state.hash), label: "View on explorer ↗" }); break;
      case "rejected": setBusy(false); status.set(state.message, "warn"); break;
      case "error": setBusy(false); status.set(state.message, "error"); break;
      case "reverted": setBusy(true); sendButton.disabled = true; editButton.disabled = false; status.set("The transaction was included but reverted. No USDC was transferred.", "error", { href: explorerTx(state.hash), label: "View on explorer ↗" }); break;
      case "confirmed": {
        setBusy(true);
        const r = review!;
        const when = new Date(state.at);
        result.replaceChildren(h("h2", "", "Payment confirmed"), definition([
          ["Amount sent", `${formatUsdc(r.amountAtomic)} USDC`],
          ["Recipient", h("code", "pay-mono", r.recipient)],
          ["Transaction", h("a", "pay-link", `${shortAddress(state.hash)} ↗`, { href: explorerTx(state.hash), target: "_blank", rel: "noopener noreferrer" })],
          ["Block", state.blockNumber === null ? "—" : String(state.blockNumber)],
          ["Confirmed", when.toLocaleString()],
        ]));
        const again = h("button", "pay-button", "Send another payment", { type: "button" });
        again.addEventListener("click", () => { review = null; executor = null; recipient.value = ""; amount.value = ""; reference.value = ""; result.hidden = true; reviewPanel.hidden = true; form.hidden = false; status.set(""); setBusy(false); void refreshBalance(); recipient.focus(); });
        result.append(again);
        result.hidden = false; reviewPanel.hidden = true;
        rememberPayment({ kind: "send", hash: state.hash, at: state.at, summary: `${formatUsdc(r.amountAtomic)} USDC → ${shortAddress(r.recipient)}${reference.value.trim() ? ` · ${reference.value.trim()}` : ""}` });
        history.paint();
        status.set("Confirmed on Arc Mainnet.", "ok");
        break;
      }
    }
  };

  sendButton.addEventListener("click", () => { if (review && executor) void executor(review); });
  page.append(gate.box, form, reviewPanel, status.box, result, history.box);
  arcfxWallet.watch(() => gate.paint());
}

// ═════════════════════════════════════════════════════════════════════════════
// MULTISEND / PAYOUTS
// ═════════════════════════════════════════════════════════════════════════════

type Row = { recipient: string; amount: string; reference: string };

export function mountMultisend(root: HTMLElement) {
  const page = pageShell(root, "Multisend / Payouts", "Pay up to 500 wallets in one Arc Mainnet transaction. The batch is atomic: if any transfer fails, none are sent.");
  const status = statusRegion();
  let rows: Row[] = [{ recipient: "", amount: "", reference: "" }];
  let allowDuplicates = false;
  let review: BatchReview | null = null;
  let executor: ReturnType<typeof createBatchExecutor> | null = null;

  const gate = gatePanel((state) => {
    editor.hidden = state !== "ready" || review !== null;
    if (state !== "ready" && review) { review = null; reviewPanel.hidden = true; status.set("Your wallet changed. Review the batch again.", "warn"); }
  });

  const sender = () => (arcfxWallet.connected ? arcfxWallet.address : null);
  const live = (): Batch => buildBatch(rows.map((r, i) => ({ line: i + 1, ...r })), { sender: sender(), allowDuplicates });

  // ── editor ──
  const editor = h("section", "pay-card pay-form");
  editor.hidden = true; // shown once the wallet is confirmed ready on Arc Mainnet
  const rowsBox = h("div", "ms-rows");
  const summaryLine = h("p", "ms-total", "", { "aria-live": "polite" });
  const tierLine = h("p", "pay-help");
  const batchError = h("p", "pay-error", "", { role: "alert", hidden: true });
  const addRow = h("button", "pay-button", "Add recipient", { type: "button" });
  const dupBox = h("label", "pay-check");
  const dupInput = h("input", "", undefined, { type: "checkbox", id: "ms-allow-dup" }) as HTMLInputElement;
  dupBox.append(dupInput, " The same address may appear more than once (intended)");
  dupBox.hidden = true;
  const reviewButton = h("button", "pay-button pay-button--primary", "Review batch", { type: "button" });

  // import
  const importBox = h("details", "pay-import");
  importBox.append(h("summary", "", "Import from CSV"));
  const file = h("input", "pay-input", undefined, { type: "file", id: "ms-file", accept: ".csv,.tsv,.txt,text/csv,text/plain" }) as HTMLInputElement;
  const paste = h("textarea", "pay-input pay-mono", undefined, { id: "ms-paste", rows: "4", spellcheck: "false", placeholder: "recipient,amount,reference" }) as HTMLTextAreaElement;
  const importPasted = h("button", "pay-button", "Import pasted CSV", { type: "button" });
  const template = h("button", "pay-button pay-button--quiet", "Download template", { type: "button" });
  const importErrors = h("div", "pay-error-list", "", { role: "alert", hidden: true });
  importBox.append(
    h("p", "pay-help", `Columns: recipient, amount, optional reference. Parsed in this browser only; nothing is uploaded. Any invalid line stops the import and is listed with its line number. Up to ${MULTISENDER.maxLimit} recipients.`),
    labelled("CSV file", file).wrap, labelled("Or paste CSV", paste).wrap,
    (() => { const a = h("div", "pay-actions"); a.append(importPasted, template); return a; })(), importErrors,
  );

  const rowErrorNodes: Array<{ recipient: HTMLElement; amount: HTMLElement; recipientInput: HTMLInputElement; amountInput: HTMLInputElement }> = [];

  const updateSummary = () => {
    const batch = live();
    for (const [i, nodes] of rowErrorNodes.entries()) {
      const errs = batch.rowErrors.filter((e) => e.line === i + 1);
      for (const field of ["recipient", "amount"] as const) {
        const message = errs.find((e) => e.field === field)?.message ?? "";
        const node = nodes[field]; const input = field === "recipient" ? nodes.recipientInput : nodes.amountInput;
        // Untouched blank rows stay quiet until the owner tries to review.
        const quiet = !touched && !input.value.trim();
        node.textContent = quiet ? "" : message; node.hidden = quiet || !message;
        if (message && !quiet) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", node.id); }
        else { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); }
      }
    }
    dupBox.hidden = !(batch.duplicates.length || allowDuplicates);
    const complete = batch.entries.length;
    summaryLine.textContent = `${rows.length} recipient${rows.length === 1 ? "" : "s"} · ${formatUsdc(batch.totalAtomic)} USDC to recipients` + (complete < rows.length ? ` (${rows.length - complete} incomplete)` : "");
    tierLine.textContent = batch.isPro
      ? `More than ${MULTISENDER.freeLimit} recipients uses the Pro function: a 0.10% ArcFX fee (${formatUsdc(batch.feeAtomic)} USDC) is added on top and shown separately in review.`
      : `Up to ${MULTISENDER.freeLimit} recipients uses the fee-free function. Larger batches (up to ${MULTISENDER.maxLimit}) add a 0.10% ArcFX fee.`;
    batchError.textContent = batch.batchErrors.join(" "); batchError.hidden = batch.batchErrors.length === 0 || !touched;
    addRow.disabled = rows.length >= MULTISENDER.maxLimit;
  };
  let touched = false;

  const renderRows = () => {
    rowsBox.replaceChildren(); rowErrorNodes.length = 0;
    const head = h("div", "ms-row ms-row--head", undefined, { "aria-hidden": "true" });
    head.append(h("span", "", "#"), h("span", "", "Recipient address"), h("span", "", "Amount (USDC)"), h("span", "", "Reference"), h("span", ""));
    rowsBox.append(head);
    rows.forEach((row, i) => {
      const n = i + 1;
      const el = h("div", "ms-row");
      const recipientInput = h("input", "pay-input pay-mono", undefined, { type: "text", "aria-label": `Recipient address, row ${n}`, autocomplete: "off", spellcheck: "false", placeholder: "0x…" }) as HTMLInputElement;
      const amountInput = h("input", "pay-input", undefined, { type: "text", inputmode: "decimal", "aria-label": `Amount in USDC, row ${n}`, autocomplete: "off", placeholder: "0.00" }) as HTMLInputElement;
      const referenceInput = h("input", "pay-input", undefined, { type: "text", maxlength: "80", "aria-label": `Reference, row ${n} (optional)`, autocomplete: "off", placeholder: "Optional" }) as HTMLInputElement;
      recipientInput.value = row.recipient; amountInput.value = row.amount; referenceInput.value = row.reference;
      recipientInput.addEventListener("input", () => { row.recipient = recipientInput.value; updateSummary(); });
      amountInput.addEventListener("input", () => { row.amount = amountInput.value; updateSummary(); });
      referenceInput.addEventListener("input", () => { row.reference = referenceInput.value; });
      const remove = h("button", "pay-button pay-button--quiet", "Remove", { type: "button", "aria-label": `Remove row ${n}` });
      remove.addEventListener("click", () => { rows.splice(i, 1); if (!rows.length) rows.push({ recipient: "", amount: "", reference: "" }); renderRows(); });
      const rErr = h("p", "pay-error ms-row-error", "", { id: nextId("ms-err"), hidden: true });
      const aErr = h("p", "pay-error ms-row-error", "", { id: nextId("ms-err"), hidden: true });
      const num = h("span", "ms-num", String(n));
      const cellR = h("div", "ms-cell ms-cell--recipient"); cellR.append(h("span", "ms-cell-label", "Recipient"), recipientInput, rErr);
      const cellA = h("div", "ms-cell ms-cell--amount"); cellA.append(h("span", "ms-cell-label", "Amount (USDC)"), amountInput, aErr);
      const cellF = h("div", "ms-cell ms-cell--reference"); cellF.append(h("span", "ms-cell-label", "Reference"), referenceInput);
      el.append(num, cellR, cellA, cellF, remove);
      rowsBox.append(el);
      rowErrorNodes.push({ recipient: rErr, amount: aErr, recipientInput, amountInput });
    });
    updateSummary();
  };

  addRow.addEventListener("click", () => { if (rows.length < MULTISENDER.maxLimit) { rows.push({ recipient: "", amount: "", reference: "" }); renderRows(); (rowsBox.querySelectorAll<HTMLInputElement>(".ms-row:last-child input")[0])?.focus(); } });
  dupInput.addEventListener("change", () => { allowDuplicates = dupInput.checked; updateSummary(); });

  const importText = (text: string) => {
    importErrors.replaceChildren(); importErrors.hidden = true;
    const parsed = parseCsv(text);
    const problems = [...parsed.errors];
    if (!problems.length && parsed.rows.length === 0) problems.push({ line: 0, message: "No data rows found. Add at least one recipient row." });
    if (!problems.length && parsed.rows.length > MULTISENDER.maxLimit) problems.push({ line: 0, message: `Too many recipients: ${parsed.rows.length}. One batch holds at most ${MULTISENDER.maxLimit}.` });
    if (problems.length) {
      importErrors.append(h("strong", "", "Nothing was imported. Fix these and try again:"));
      const ul = h("ul");
      for (const p of problems) ul.append(h("li", "", p.line ? `Line ${p.line}: ${p.message}` : p.message));
      importErrors.append(ul); importErrors.hidden = false;
      return;
    }
    rows = parsed.rows.map((r) => ({ recipient: r.recipient, amount: r.amount, reference: r.reference }));
    touched = true; renderRows();
    status.set(`Imported ${rows.length} row${rows.length === 1 ? "" : "s"}. Any row with a problem is marked below; review is blocked until every row is valid.`, "ok");
  };
  file.addEventListener("change", async () => {
    const f = file.files?.[0]; if (!f) return;
    if (f.size > CSV_MAX_BYTES) { importErrors.replaceChildren(h("strong", "", `The file is larger than ${CSV_MAX_BYTES / 1024} KB. Nothing was imported.`)); importErrors.hidden = false; return; }
    importText(await f.text()); file.value = "";
  });
  importPasted.addEventListener("click", () => importText(paste.value));
  template.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: "text/csv" }));
    const a = h("a", "", "", { href: url, download: "arcfx-payouts-template.csv" }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  editor.append(h("h2", "", "Recipients"), importBox, rowsBox, addRow, summaryLine, tierLine, dupBox, batchError, reviewButton);

  // ── review ──
  const reviewPanel = h("section", "pay-card pay-review", undefined, { "aria-labelledby": "ms-review-title" });
  reviewPanel.hidden = true;
  const approveButton = h("button", "pay-button pay-button--primary", "Approve", { type: "button" });
  const executeButton = h("button", "pay-button pay-button--primary", "Execute batch", { type: "button" });
  const editButton = h("button", "pay-button", "Edit recipients", { type: "button" });
  const result = h("section", "pay-card pay-result", undefined, { "aria-live": "polite" });
  result.hidden = true;
  const history = sessionList("multisend");
  let current: BatchWallet | null = null;

  const paintButtons = (busy = false) => {
    if (!review) return;
    const needsApproval = current?.allowanceAtomic !== null && current?.allowanceAtomic !== undefined && allowanceAction(current.allowanceAtomic, review.pullAtomic) === "approve";
    approveButton.hidden = !needsApproval;
    approveButton.textContent = `Approve exactly ${formatUsdc(review.pullAtomic)} USDC`;
    executeButton.disabled = busy || needsApproval || current?.allowanceAtomic === null;
    approveButton.disabled = busy;
    editButton.disabled = busy;
    executeButton.setAttribute("aria-describedby", "ms-exec-help");
  };

  const goEdit = () => { review = null; executor = null; reviewPanel.hidden = true; editor.hidden = gateState() !== "ready"; status.set(""); reviewButton.focus(); };
  editButton.addEventListener("click", goEdit);

  let approvalFeeCell: HTMLElement | null = null;
  let batchFeeCell: HTMLElement | null = null;

  /** Fee of the batch call itself; the network can only simulate it once the allowance is in place. */
  const batchFeeWei = (r: BatchReview) => estimateFeeWei((provider) => {
    const c = new Contract(MAINNET.multisender, MULTISENDER_ABI, provider);
    return r.fn === "multisend" ? c.multisend.estimateGas(r.token, r.recipients, r.amounts, { from: r.account }) : c.multisendFree.estimateGas(r.token, r.recipients, r.amounts, { from: r.account });
  });
  const approvalFeeWei = (r: BatchReview) => estimateFeeWei((provider) => new Contract(MAINNET.usdc, ERC20_ABI, provider).approve.estimateGas(MAINNET.multisender, r.pullAtomic, { from: r.account }));

  /** After our own approval confirms, the batch can finally be simulated: refresh its fee and re-check the balance. */
  const refreshBatchFee = async () => {
    if (!review) return;
    const r = review;
    const wei = await batchFeeWei(r);
    if (review !== r) return;
    r.feeEstimateWei = wei;
    if (batchFeeCell) batchFeeCell.textContent = feeText(wei);
    try {
      const wallet = await readWallet(true);
      const blocker = batchWalletBlocker(wallet, r.pullAtomic, wei);
      if (blocker && review === r) status.set(blocker, "error");
    } catch { /* the executor re-checks before any prompt */ }
  };

  const showReview = (r: BatchReview, wallet: BatchWallet, approvalFee: bigint | null) => {
    current = wallet;
    reviewPanel.replaceChildren(h("h2", "", "Review batch", { id: "ms-review-title" }));
    const needsApprovalNow = wallet.allowanceAtomic !== null && wallet.allowanceAtomic < r.pullAtomic;
    approvalFeeCell = h("span", "", feeText(approvalFee));
    batchFeeCell = h("span", "", needsApprovalNow ? "Shown after approval (the network can only simulate the batch once the allowance is in place)." : feeText(r.feeEstimateWei));
    reviewPanel.append(definition([
      ["Recipients", String(r.count)],
      ["Total to recipients", `${formatUsdc(r.totalAtomic)} USDC`],
      ["ArcFX fee", r.fn === "multisend" ? `${formatUsdc(r.feeAtomic)} USDC (0.10% of the total, floored)` : "None (up to 5 recipients)"],
      ["Total wallet debit", `${formatUsdc(r.pullAtomic)} USDC`],
      ["Token", `USDC · ${shortAddress(r.token)} (canonical Arc Mainnet USDC)`],
      ["Network", `Arc Mainnet · ${MAINNET.caip2}`],
      ["Contract", h("code", "pay-mono", `ArcFXMultisender ${r.contract} · ${r.fn}()`)],
      ["From", h("code", "pay-mono", r.account)],
      ["Your USDC balance", `${formatUsdc(r.balanceAtomic)} USDC`],
      ["USDC allowance for this contract", wallet.allowanceAtomic === null ? "Unavailable" : `${formatUsdc(wallet.allowanceAtomic)} USDC`],
      ...(needsApprovalNow ? [["Approval network fee", approvalFeeCell] as [string, Node]] : []),
      ["Batch network fee", batchFeeCell],
      ["Network fees are paid in", FEE_SAME_BALANCE],
    ]));
    const caption = h("p", "pay-help", `All ${r.count} recipient${r.count === 1 ? "" : "s"} in this batch are listed below${r.count > 6 ? "; scroll the list to check every row" : ""}.`);
    const table = h("div", "ms-review-table", undefined, { role: "table", "aria-label": "Recipients in this batch" });
    const headRow = h("div", "ms-review-row ms-review-row--head", undefined, { role: "row" });
    headRow.append(h("span", "", "#", { role: "columnheader" }), h("span", "", "Recipient address", { role: "columnheader" }), h("span", "", "Amount (USDC)", { role: "columnheader" }));
    table.append(headRow);
    r.recipients.forEach((address, i) => {
      const row = h("div", "ms-review-row", undefined, { role: "row" });
      row.append(h("span", "", String(i + 1), { role: "cell" }), h("code", "pay-mono", address, { role: "cell" }), h("span", "ms-amt", formatUsdc(r.amounts[i]), { role: "cell" }));
      table.append(row);
    });
    const actions = h("div", "pay-actions"); actions.append(approveButton, executeButton, editButton);
    reviewPanel.append(caption, table, actions, h("p", "pay-help", "Approval and execution are separate wallet confirmations. Approval covers exactly the total wallet debit, never unlimited USDC. ArcFX re-checks everything before each one.", { id: "ms-exec-help" }));
    reviewPanel.hidden = false; editor.hidden = true;
    paintButtons();
    (approveButton.hidden ? executeButton : approveButton).focus();
  };

  reviewButton.addEventListener("click", async () => {
    touched = true; updateSummary(); status.set("");
    const batch = live();
    if (!batch.valid) {
      const first = batch.rowErrors[0];
      status.set(batch.batchErrors[0] ?? (first ? `Fix row ${first.line}: ${first.message}` : "Fix the highlighted rows to continue."), "error");
      return;
    }
    reviewButton.disabled = true;
    try {
      const wallet = await readWallet(true);
      const built = buildBatchReview(batch, wallet);
      if (built.blocker) { status.set(built.blocker, "error"); return; }
      if (!built.review) return;
      // Fee of the next wallet step (the approval, or the batch when already approved). It is paid
      // from the same USDC balance as the batch, so it must fit alongside the debit.
      const prepared = built.review;
      const needsApproval = wallet.allowanceAtomic !== null && wallet.allowanceAtomic < prepared.pullAtomic;
      const approvalFee = needsApproval ? await approvalFeeWei(prepared) : null;
      const nextFee = needsApproval ? approvalFee : await batchFeeWei(prepared);
      const feeBlock = batchWalletBlocker(wallet, prepared.pullAtomic, nextFee);
      if (feeBlock) { status.set(feeBlock, "error"); return; }
      review = { ...prepared, feeEstimateWei: nextFee };
      executor = createBatchExecutor({
        readWallet: async () => { const w = await readWallet(true); current = w; return w; },
        live,
        approve: async (amount) => {
          const signer = await signerFor(review!.account);
          const tx = await new Contract(MAINNET.usdc, ERC20_ABI, signer).approve(MAINNET.multisender, amount);
          return { hash: tx.hash, wait: () => tx.wait() };
        },
        execute: async (r) => {
          const signer = await signerFor(r.account);
          const c = new Contract(MAINNET.multisender, MULTISENDER_ABI, signer);
          const tx = r.fn === "multisend" ? await c.multisend(r.token, r.recipients, r.amounts) : await c.multisendFree(r.token, r.recipients, r.amounts);
          return { hash: tx.hash, wait: () => tx.wait() };
        },
        onState: (state) => paintBatch(state),
      });
      showReview(review, wallet, approvalFee);
    } catch (e) { status.set(e instanceof Error ? e.message : "Could not prepare the batch.", "error"); }
    finally { reviewButton.disabled = false; }
  });

  const paintBatch = (state: BatchState) => {
    switch (state.phase) {
      case "checking": paintButtons(true); status.set("Checking your wallet and the batch…"); break;
      case "blocked": paintButtons(false); status.set(state.reason, "error"); break;
      case "not-needed": paintButtons(false); status.set(state.message, "ok"); break;
      case "approval-awaiting-wallet": paintButtons(true); status.set(`Confirm the approval of exactly ${formatUsdc(review!.pullAtomic)} USDC in your wallet. This is not the batch.`); break;
      case "approval-submitted": paintButtons(true); status.set("Waiting for the approval to be included…", "", { href: explorerTx(state.hash), label: "View on explorer ↗" }); break;
      case "approved": paintButtons(false); status.set("Approval confirmed. Review the batch and click Execute batch.", "ok", { href: explorerTx(state.hash), label: "View approval ↗" }); executeButton.focus(); void refreshBatchFee(); break;
      case "approval-unsynced": paintButtons(false); status.set("The approval is confirmed on chain, but your wallet has not reported the new allowance yet. Wait a moment and click Review batch again; do not approve twice.", "warn", { href: explorerTx(state.hash), label: "View approval ↗" }); break;
      case "execute-awaiting-wallet": paintButtons(true); status.set("Confirm the batch in your wallet. This is the only transaction that moves funds."); break;
      case "submitted": paintButtons(true); status.set("Submitted. Waiting for Arc Mainnet to confirm the batch…", "", { href: explorerTx(state.hash), label: "View on explorer ↗" }); break;
      case "rejected": paintButtons(false); status.set(state.message, "warn"); break;
      case "error": paintButtons(false); status.set(state.message, "error"); break;
      case "reverted": paintButtons(true); executeButton.disabled = true; approveButton.disabled = true; editButton.disabled = false; status.set("The batch was included but reverted, so no funds moved. Edit and review the batch again.", "error", { href: explorerTx(state.hash), label: "View on explorer ↗" }); break;
      case "confirmed": {
        const r = review!;
        result.replaceChildren(h("h2", "", "Batch confirmed"), definition([
          ["Recipients paid", String(r.count)],
          ["Total to recipients", `${formatUsdc(r.totalAtomic)} USDC`],
          ["ArcFX fee", `${formatUsdc(r.feeAtomic)} USDC`],
          ["Total debited", `${formatUsdc(r.pullAtomic)} USDC`],
          ["Transaction", h("a", "pay-link", `${shortAddress(state.hash)} ↗`, { href: explorerTx(state.hash), target: "_blank", rel: "noopener noreferrer" })],
          ["Block", state.blockNumber === null ? "—" : String(state.blockNumber)],
          ["Confirmed", new Date(state.at).toLocaleString()],
        ]));
        const again = h("button", "pay-button", "Start a new batch", { type: "button" });
        again.addEventListener("click", () => { review = null; executor = null; rows = [{ recipient: "", amount: "", reference: "" }]; touched = false; allowDuplicates = false; dupInput.checked = false; result.hidden = true; reviewPanel.hidden = true; editor.hidden = false; status.set(""); renderRows(); });
        result.append(again);
        result.hidden = false; reviewPanel.hidden = true;
        rememberPayment({ kind: "multisend", hash: state.hash, at: state.at, summary: `${r.count} recipients · ${formatUsdc(r.totalAtomic)} USDC (+${formatUsdc(r.feeAtomic)} fee)` });
        history.paint();
        status.set("Confirmed on Arc Mainnet.", "ok");
        break;
      }
    }
  };

  approveButton.addEventListener("click", () => { if (review && executor) void executor.approve(review); });
  executeButton.addEventListener("click", () => { if (review && executor) void executor.execute(review); });

  renderRows();
  page.append(gate.box, editor, reviewPanel, status.box, result, history.box);
  arcfxWallet.watch(() => gate.paint());
}
