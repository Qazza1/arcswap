/**
 * Invoice draft/issue rules for the Mainnet receivables editor.
 *
 * Backend facts (POST /v1/invoice-records and /update in arcfx-backend):
 * - A draft needs only `number` (1–64 chars). `amount` is optional there, but
 *   if present must be a positive decimal. Token, due date, customer and note
 *   are optional.
 * - Number and amount can never be edited after creation (edit only touches
 *   due date, customer and note), so a draft without an amount could never be
 *   issued. The editor therefore requires an amount at creation and says why.
 * - The backend does not itself check amount/token before `send`; issuing is
 *   gated here so an incomplete record is never presented to a payer.
 *
 * Nothing in this module touches the DOM, the wallet, or the network.
 */

export const MAX_NUMBER = 64;
export const USDC_DECIMALS = 6;
// numeric(78,0) guard used by the backend.
const MAX_AMOUNT_DIGITS = 60;

export type DraftInput = { number: string; amount: string };
export type DraftErrors = Partial<Record<keyof DraftInput, string>>;

export function validateDraft(input: DraftInput): DraftErrors {
  const errors: DraftErrors = {};
  const number = input.number.trim();
  if (!number) errors.number = "Enter an invoice number.";
  else if (number.length > MAX_NUMBER) errors.number = `Use ${MAX_NUMBER} characters or fewer.`;

  const amount = input.amount.trim();
  if (!amount) {
    errors.amount = "Enter an amount greater than 0. It can't be changed after the draft is saved.";
  } else if (/^\d+,\d+$/.test(amount)) {
    errors.amount = `Use a dot for decimals, for example ${amount.replace(",", ".")}.`;
  } else if (!/^\d+(\.\d+)?$/.test(amount)) {
    errors.amount = "Enter a plain number, for example 0.01.";
  } else {
    const [whole, fraction = ""] = amount.split(".");
    if (fraction.length > USDC_DECIMALS) errors.amount = `USDC supports up to ${USDC_DECIMALS} decimal places.`;
    else {
      const atomic = BigInt(whole + fraction.padEnd(USDC_DECIMALS, "0"));
      if (atomic <= 0n) errors.amount = "Enter an amount greater than 0.";
      else if (atomic.toString().length > MAX_AMOUNT_DIGITS) errors.amount = "That amount is too large.";
    }
  }
  return errors;
}

/** Plain-language list of what is still missing, for the hint beside the button. */
export function missingSummary(errors: DraftErrors): string {
  const missing = [errors.number && "invoice number", errors.amount && "amount"].filter(Boolean);
  return missing.length ? `To save a draft, add a valid ${missing.join(" and ")}.` : "";
}

export type IssueCandidate = { status: string; amount: string | null; token: string | null; tokenAddress?: string | null };

/** Why a stored invoice cannot be issued yet; null when it can. */
export function issueBlocker(invoice: IssueCandidate): string | null {
  if (invoice.status !== "draft") return "Only a draft can be issued.";
  if (invoice.amount == null || !(Number(invoice.amount) > 0)) return "This draft has no amount, so it can't be issued. Create a new invoice with an amount.";
  if (!invoice.token && !invoice.tokenAddress) return "This draft has no token, so it can't be issued.";
  return null;
}

/** Turn a wallet or API failure into an actionable message. */
export function describeWriteError(error: unknown, what = "the draft"): string {
  const e = error as any;
  const code = e?.code ?? e?.error?.code ?? e?.info?.error?.code;
  const text = String(e?.message || e || "");
  if (code === 4001 || code === "ACTION_REJECTED" || /user (rejected|denied|cancel)|rejected the request|denied/i.test(text)) {
    return `Signature cancelled in your wallet. Nothing was saved — your entries are still here.`;
  }
  const status = typeof e?.status === "number" ? e.status : null;
  const server = typeof e?.body?.error === "string" ? e.body.error : null;
  if (status === 409) {
    return /already exists/.test(server || "")
      ? `${server!.replace(/^invoice /, "Invoice ")}. Choose a different invoice number.`
      : server || "This conflicts with an existing record.";
  }
  if (status === 400) return server ? `ArcFX rejected ${what}: ${server}.` : `ArcFX rejected ${what}. Check the fields and try again.`;
  if (status === 401 || status === 403) {
    return "ArcFX could not verify the wallet signature. Check the selected wallet is on Arc Mainnet and try again; if it persists, open secure entry.";
  }
  if (status && status >= 500) return `ArcFX could not save ${what} right now (server error ${status}). Try again shortly.`;
  if (e?.timedOut) return `ArcFX did not respond in time. ${what[0].toUpperCase() + what.slice(1)} may still have been saved — check Invoices before trying again.`;
  if (e instanceof TypeError || /network|failed to fetch|load failed/i.test(text)) {
    return `Could not reach ArcFX. Check your connection and try again — ${what} was not confirmed as saved.`;
  }
  return text || `Could not save ${what}.`;
}

export type SubmitState =
  | { phase: "invalid"; errors: DraftErrors }
  | { phase: "saving" }
  | { phase: "saved"; id: string }
  | { phase: "error"; message: string };

/**
 * One in-flight save at a time: a double-click, Enter plus click, or a second
 * submit while the wallet prompt is open never produces a second mutation.
 */
export function createDraftSubmitter<T extends DraftInput>(
  save: (values: T) => Promise<{ invoice: { id: string } }>,
  onState: (state: SubmitState) => void,
) {
  let inFlight = false;
  let done = false;
  return async function submit(values: T): Promise<void> {
    if (inFlight || done) return;
    const errors = validateDraft(values);
    if (Object.keys(errors).length) { onState({ phase: "invalid", errors }); return; }
    inFlight = true;
    onState({ phase: "saving" });
    try {
      const result = await save(values);
      const id = result?.invoice?.id;
      if (typeof id !== "string" || !id) throw new Error("ArcFX saved nothing it could identify. Check Invoices before trying again.");
      done = true;
      onState({ phase: "saved", id });
    } catch (error) {
      onState({ phase: "error", message: describeWriteError(error) });
    } finally {
      inFlight = false;
    }
  };
}
