/**
 * Payment receipts, as PDF.
 *
 * One generator for both places a receipt can be asked for — a row in Books and
 * a paid invoice in the list — because two implementations would drift and the
 * customer would get a different document depending on which button was pressed.
 *
 * Set in the Document register, matching the invoice PDF. A receipt is a
 * client-facing document: it gets emailed to the person who paid, so it should
 * look like the invoice it settles, not like the app.
 *
 * jsPDF is imported lazily, so ~350kB of PDF machinery is fetched the first time
 * someone actually downloads a receipt rather than on every page load.
 */

export interface ReceiptInput {
  /** Positive decimal string of what moved, e.g. "1000.00". */
  amount: string;
  /** Token symbol, e.g. "USDC". */
  token: string;
  /** The wallet this receipt belongs to. */
  account: string;
  /** Who the money came from (received) or went to (sent). */
  counterparty?: string | null;
  /** 'in' = received, 'out' = sent. Decides the wording throughout. */
  direction: "in" | "out";
  txHash?: string | null;
  block?: number | string | null;
  /** When it settled. A Date, an ISO string, or nothing. */
  date?: Date | string | null;

  // Invoice context, when this payment settled a tracked invoice.
  invoiceNumber?: string | null;
  customerName?: string | null;
  /** The invoice total, when the payment was partial. */
  invoiceTotal?: string | null;
  /** Everything received against the invoice so far. */
  invoicePaid?: string | null;
  note?: string | null;
}

// Document register — the same palette as the invoice PDF.
const INK    = [28, 26, 23] as const;
const MUTED  = [110, 104, 98] as const;
const RULE   = [228, 224, 216] as const;
const ACCENT = [31, 93, 76] as const;

/**
 * Make text safe for jsPDF's built-in fonts.
 *
 * The standard PDF fonts are WinAnsi-encoded. That covers Latin-1 — Müller and
 * Ceské both render — but NOT typographic punctuation, so an em dash came out
 * as a replacement glyph on the first receipt generated. Anything beyond
 * Latin-1 (Cyrillic, Greek, CJK) has no glyph at all.
 *
 * Common typography is transliterated to its ASCII equivalent, and anything
 * still unrepresentable is dropped rather than emitted as mojibake: a customer
 * would rather see a name with a character missing than one full of black
 * diamonds. Embedding a Unicode font would fix it properly, at roughly 100kB
 * per receipt download.
 */
const TYPOGRAPHY: Record<string, string> = {
  "—": "-", "–": "-", "−": "-",       // em, en, minus
  "‘": "'", "’": "'", "‚": ",",       // single quotes
  "“": '"', "”": '"', "„": '"',       // double quotes
  "…": "...", " ": " ", " ": " ",     // ellipsis, nbsp
  "•": "*", "·": "-", "✓": "y",       // bullet, middot, check
};

export function pdfSafe(s: unknown): string {
  let out = String(s ?? "");
  out = out.replace(/[—–−‘’‚“”„…  •·✓]/g,
    (c) => TYPOGRAPHY[c] ?? c);
  // Keep printable Latin-1; drop the rest so nothing renders as a bad glyph.
  out = out.replace(/[^\x20-\x7E¡-ÿ]/g, "");
  return out;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? "—" : dt.toLocaleString("en-GB", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

/** A filename someone can find later: the invoice number if there is one. */
function filenameFor(r: ReceiptInput): string {
  const stamp = (r.invoiceNumber || (r.txHash ? r.txHash.slice(0, 10) : "payment"))
    .replace(/[^A-Za-z0-9._-]/g, "-");
  return `arcfx-receipt-${stamp}.pdf`;
}

export async function downloadReceiptPdf(r: ReceiptInput): Promise<void> {
  const { jsPDF } = await import("jspdf");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = 210;
  const L = 14;              // left margin
  const R = W - 14;          // right margin

  const setInk    = () => doc.setTextColor(INK[0], INK[1], INK[2]);
  const setMuted  = () => doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
  const rule = (y: number) => {
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.3);
    doc.line(L, y, R, y);
  };

  // ── Letterhead ──────────────────────────────────────────────────────────
  // Paper and a rule, not a printed dark band. A receipt is usually printed or
  // filed, and a full-bleed dark header wastes ink and looks like a coupon.
  doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.roundedRect(L, 12, 14, 14, 2, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.text("A", L + 7, 21.5, { align: "center" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  setInk();
  doc.text("ArcFX", L + 18, 21.5);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  setInk();
  doc.text(r.direction === "in" ? "PAYMENT RECEIPT" : "PAYMENT SENT", R, 21.5, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setMuted();
  doc.text(pdfSafe(fmtDate(r.date)), R, 27, { align: "right" });

  rule(33);

  // ── The amount ──────────────────────────────────────────────────────────
  let y = 47;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  setMuted();
  doc.text(r.direction === "in" ? "Amount received" : "Amount sent", L, y);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(24);
  setInk();
  doc.text(pdfSafe(`${r.amount} ${r.token}`), L, y + 11);

  // A partial payment must say so on the receipt itself, or the customer files
  // it believing the invoice is settled.
  if (r.invoiceTotal && r.invoicePaid) {
    const total = Number(r.invoiceTotal);
    const paid = Number(r.invoicePaid);
    if (isFinite(total) && isFinite(paid) && paid < total) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(150, 90, 20);
      doc.text(
        pdfSafe(
          `Part payment - ${paid.toFixed(2)} of ${total.toFixed(2)} ${r.token} received, ` +
          `${(total - paid).toFixed(2)} outstanding`
        ),
        L, y + 18
      );
      y += 7;
    }
  }

  y += 26;
  rule(y);
  y += 10;

  // ── Detail ──────────────────────────────────────────────────────────────
  const rows: Array<[string, string]> = [];
  if (r.invoiceNumber) rows.push(["Invoice", r.invoiceNumber]);
  if (r.customerName) rows.push([r.direction === "in" ? "Customer" : "Payee", r.customerName]);
  if (r.note) rows.push(["Reference", r.note]);
  rows.push([r.direction === "in" ? "Received by" : "Sent from", r.account]);
  if (r.counterparty) rows.push([r.direction === "in" ? "Received from" : "Sent to", r.counterparty]);
  rows.push(["Network", "Arc Testnet"]);
  if (r.block != null && r.block !== "") rows.push(["Block", String(r.block)]);
  rows.push(["Status", "Confirmed on-chain"]);
  if (r.txHash) rows.push(["Transaction", r.txHash]);

  doc.setFontSize(9.5);
  for (const [label, value] of rows) {
    doc.setFont("helvetica", "normal");
    setMuted();
    doc.text(pdfSafe(label), L, y);

    doc.setFont("helvetica", "bold");
    setInk();
    // Long values — addresses, hashes — wrap rather than run off the page.
    const lines = doc.splitTextToSize(pdfSafe(value), 118) as string[];
    doc.text(lines, R, y, { align: "right" });

    y += lines.length * 4.6 + 4;
    doc.setDrawColor(RULE[0], RULE[1], RULE[2]);
    doc.setLineWidth(0.2);
    doc.line(L, y - 3, R, y - 3);
  }

  // ── Verify link ─────────────────────────────────────────────────────────
  if (r.txHash) {
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.textWithLink("Verify this payment on ArcScan", L, y, {
      url: `https://testnet.arcscan.app/tx/${r.txHash}`,
    });
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  setMuted();
  doc.text(
    pdfSafe(
      `Settled on Arc. This receipt records a transfer that is independently verifiable on-chain. ` +
      `Generated ${new Date().toLocaleDateString("en-GB")} by ArcFX - arcfx.app`
    ),
    L, 287, { maxWidth: R - L }
  );

  doc.save(filenameFor(r));
}

if (typeof window !== "undefined") {
  (window as any).arcfxDownloadReceipt = downloadReceiptPdf;
}
