/**
 * What the invoice detail page should offer for settlement, derived only from
 * the authoritative invoice record (amount, paid and outstanding are computed
 * by the backend from allocations; `paid` moves only when reconciliation has
 * written an allocation).
 *
 * The API cannot tell in advance whether an unallocated payment exists, so an
 * open invoice always keeps the Reconcile action; a run that finds nothing is
 * reported as such afterwards. Once nothing is outstanding there is nothing to
 * reconcile and the action is replaced by a settled state.
 */
import { describeWriteError } from "./invoiceDraft";

export type SettlementInvoice = {
  id: string;
  status: string;
  amount: string | null;
  paid: string;
  outstanding: string | null;
  token: string | null;
};

export type SettlementView =
  | { kind: "not-applicable"; reason: "draft" | "cancelled" }
  | { kind: "reconcilable" }
  | { kind: "settled"; excess: string | null };

/** Decimal string → integer at a common scale; null if it isn't a plain decimal. */
function scaled(value: string | null | undefined, scale: number): bigint | null {
  if (value == null) return null;
  const m = String(value).trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const frac = m[2] || "";
  if (frac.length > scale) return null;
  return BigInt(m[1] + frac.padEnd(scale, "0"));
}

function fractionDigits(value: string | null | undefined): number {
  return String(value ?? "").split(".")[1]?.length ?? 0;
}

function format(atomic: bigint, scale: number): string {
  const s = atomic.toString().padStart(scale + 1, "0");
  return scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
}

export function settlementView(invoice: SettlementInvoice): SettlementView {
  if (invoice.status === "draft") return { kind: "not-applicable", reason: "draft" };
  if (invoice.status === "cancelled") return { kind: "not-applicable", reason: "cancelled" };
  const scale = Math.max(fractionDigits(invoice.amount), fractionDigits(invoice.paid), fractionDigits(invoice.outstanding), 6);
  const amount = scaled(invoice.amount, scale);
  const paid = scaled(invoice.paid, scale);
  const outstanding = scaled(invoice.outstanding, scale);
  // Fail open to the action only when the record is unreadable or genuinely open.
  if (amount === null || paid === null || outstanding === null) return { kind: "reconcilable" };
  if (outstanding === 0n && paid > 0n) {
    const excess = paid > amount ? paid - amount : 0n;
    return { kind: "settled", excess: excess > 0n ? format(excess, scale) : null };
  }
  return { kind: "reconcilable" };
}

/** Copy for the settled state, consistent with the backend's status names. */
export function settledCopy(invoice: SettlementInvoice, view: Extract<SettlementView, { kind: "settled" }>): { title: string; detail: string } {
  const token = invoice.token || "";
  if (view.excess) {
    return {
      title: "✓ Reconciled",
      detail: `Overpaid by ${view.excess} ${token}`.trim() + `. The full ${invoice.paid} ${token} received is recorded against this invoice; nothing is refunded or discarded automatically.`,
    };
  }
  return { title: "✓ Reconciled", detail: "Paid in full." };
}

export type ReconcileState =
  | { phase: "running" }
  | { phase: "done"; invoice: SettlementInvoice; allocated: number; view: SettlementView }
  | { phase: "error"; message: string };

/**
 * One reconciliation at a time, and none at all once the invoice is settled:
 * a double-click, or a click on a stale button, never sends a second signed
 * request.
 */
export function createReconcileRunner<T extends SettlementInvoice>(deps: {
  current: () => T;
  reconcile: () => Promise<{ results?: Array<{ allocated?: number }> }>;
  refresh: () => Promise<T>;
  onState: (state: ReconcileState & { invoice?: T }) => void;
}) {
  let inFlight = false;
  return async function run(): Promise<void> {
    if (inFlight || settlementView(deps.current()).kind !== "reconcilable") return;
    inFlight = true;
    deps.onState({ phase: "running" });
    try {
      const result = await deps.reconcile();
      const invoice = await deps.refresh();
      deps.onState({ phase: "done", invoice, allocated: result?.results?.[0]?.allocated ?? 0, view: settlementView(invoice) });
    } catch (error) {
      deps.onState({ phase: "error", message: describeWriteError(error, "the reconciliation") });
    } finally {
      inFlight = false;
    }
  };
}
