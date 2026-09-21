/**
 * Step 7B (frontend): persistent outbound Activity renders as payment_sent and
 * payout_batch from the owner-scoped dashboard API, links to the Arc Mainnet
 * explorer, never becomes part of any receivables figure, and the Send /
 * Multisend pages no longer claim history is tab-only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createServer } from "vite";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const dashboardSource = read("../src/workspace/dashboard.ts");
const toolsSource = read("../src/workspace/tools.ts");
const paymentsSource = read("../src/workspace/payments.ts");

const SEND_HASH = "0x181d0fdc25e522fd3762d614ee000a34e149ec993790c28ed5628cae9bbc0a56";
const BATCH_HASH = "0x493835a78c7a89f69fb1a4cb7fd9bec6f8215fc78854337296bf351945212570";
const B = "0x4f81e3939232815e3c98b124a17bac75304c82d8";
const C2 = "0x50e619cdc6483ac94e674b2633a9cfea28119c4f";

let server, m;
test.before(async () => {
  server = await createServer({ root: process.cwd(), server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "silent" });
  m = await server.ssrLoadModule("/src/workspace/activityModel.ts");
});
test.after(async () => { await server?.close(); });

const base = { invoiceId: null, invoiceNumber: null, customerName: null, token: "USDC", status: "confirmed" };
const sent = { ...base, id: `sent:${SEND_HASH}#12`, type: "payment_sent", timestamp: "2026-09-20T20:25:02.000Z", counterparty: B, amountAtomic: "10000", transactionHash: SEND_HASH };
const batch = {
  ...base, id: `batch:${BATCH_HASH}#13`, type: "payout_batch", timestamp: "2026-09-20T20:25:57.000Z", counterparty: null, amountAtomic: "11000", transactionHash: BATCH_HASH,
  recipientCount: 2, feeAtomic: "0", recipients: [{ recipient: B, amountAtomic: "10000" }, { recipient: C2, amountAtomic: "1000" }], recipientsTruncated: false,
};

test("atomic amounts format exactly, and malformed values never render as a number", () => {
  assert.equal(m.formatAtomic("10000"), "0.01");
  assert.equal(m.formatAtomic("11000"), "0.011");
  assert.equal(m.formatAtomic("1000"), "0.001");
  assert.equal(m.formatAtomic("1"), "0.000001");
  assert.equal(m.formatAtomic("1000000"), "1.00");
  assert.equal(m.formatAtomic("123456789123456"), "123456789.123456");
  for (const bad of ["1.5", "-1", "abc", "", null, undefined, "0x10"]) assert.equal(m.formatAtomic(bad), "—", String(bad));
});

test("payment_sent: Sent to the recipient, 0.01 USDC, confirmed, explorer link to the real transaction", () => {
  const v = m.describeOutbound(sent);
  assert.equal(v.kind, "sent");
  assert.equal(v.label, "Sent");
  assert.equal(v.title, "To 0x4f81…82d8");
  assert.equal(v.amountText, "−0.01 USDC", "shown as money that left the wallet, with an explicit minus sign");
  assert.equal(v.statusText, "Confirmed");
  assert.equal(v.explorerHref, `https://explorer.arc.io/tx/${SEND_HASH}`);
  assert.equal(v.feeText, null);
  assert.deepEqual(v.recipients, []);
});

test("payout_batch: recipient count, total, fee, confirmed, explorer link, and recipient detail", () => {
  const v = m.describeOutbound(batch);
  assert.equal(v.kind, "batch");
  assert.equal(v.label, "Payout batch");
  assert.equal(v.title, "2 recipients");
  assert.equal(v.amountText, "−0.011 USDC");
  assert.equal(v.feeText, "No ArcFX fee");
  assert.equal(v.statusText, "Confirmed");
  assert.equal(v.explorerHref, `https://explorer.arc.io/tx/${BATCH_HASH}`);
  assert.deepEqual(v.recipients.map((r) => [r.address, r.amountText]), [[B, "0.01 USDC"], [C2, "0.001 USDC"]]);
  assert.equal(v.recipientsNote, null);
  assert.equal(m.describeOutbound({ ...batch, recipientCount: 1, recipients: [batch.recipients[0]] }).title, "1 recipient");
});

test("paid-tier fee is shown as an amount; a truncated recipient list says so", () => {
  const v = m.describeOutbound({ ...batch, recipientCount: 60, feeAtomic: "60", recipientsTruncated: true, recipients: Array.from({ length: 50 }, (_, i) => ({ recipient: "0x" + (0x3000 + i).toString(16).padStart(40, "0"), amountAtomic: "1000" })) });
  assert.equal(v.feeText, "ArcFX fee 0.00006 USDC");
  assert.equal(v.recipients.length, 50);
  assert.match(v.recipientsNote, /first 50 of 60 recipients\. The transaction on the explorer lists all of them/);
});

test("only the two outbound types are outbound; every receivables type is untouched", () => {
  assert.equal(m.isOutbound("payment_sent"), true);
  assert.equal(m.isOutbound("payout_batch"), true);
  for (const type of ["invoice_created", "invoice_issued", "invoice_cancelled", "payment_received", "payment_partial", "invoice_paid", "reconciliation"]) {
    assert.equal(m.isOutbound(type), false, type);
    assert.equal(m.describeOutbound({ ...base, id: "x", type, timestamp: "2026-09-20T00:00:00Z", counterparty: null, amountAtomic: "1", transactionHash: null }), null, type);
  }
});

test("explorer links are produced only for well-formed transaction hashes", () => {
  assert.equal(m.explorerTxHref(SEND_HASH), `https://explorer.arc.io/tx/${SEND_HASH}`);
  for (const bad of [null, undefined, "", "0x123", "javascript:alert(1)", SEND_HASH + "zz", "https://evil.example/" + SEND_HASH]) assert.equal(m.explorerTxHref(bad), null, String(bad));
  assert.equal(m.describeOutbound({ ...sent, transactionHash: "not-a-hash" }).explorerHref, null);
});

test("hostile text in an activity item cannot become markup: the model returns text only", () => {
  const v = m.describeOutbound({ ...sent, counterparty: "<img src=x onerror=alert(1)>", status: "<b>x</b>" });
  assert.equal(v.title, "To Unknown wallet");
  assert.equal(v.statusText, "Unverified status");
  assert.doesNotMatch(JSON.stringify(v), /<img|onerror/);
});

test("the dashboard renders outbound rows through the model with every value escaped, and never sums them", () => {
  assert.match(dashboardSource, /import \{ describeOutbound, type ActivityItem, type OutboundView \} from "\.\/activityModel"/);
  const row = dashboardSource.slice(dashboardSource.indexOf("function outboundRow"), dashboardSource.indexOf("function activityRow"));
  for (const field of ["view.label", "view.title", "view.detail", "view.amountText", "view.statusText", "view.explorerHref", "r.address", "r.amountText", "view.recipientsNote"]) {
    assert.match(row, new RegExp(`escape\\(${field.replace(".", "\\.")}\\)`), `${field} is escaped`);
  }
  assert.match(row, /target="_blank" rel="noopener noreferrer"/);
  assert.match(dashboardSource, /if \(outbound\) return outboundRow\(item, outbound\)/);
  assert.match(dashboardSource, /payment_sent: "Sent"/);
  assert.match(dashboardSource, /payout_batch: "Payout batch"/);
  // Receivables figures come only from their own API fields, never from summing activity.
  assert.doesNotMatch(dashboardSource, /recentActivity\.(reduce|filter|map\([^)]*amountAtomic)/, "activity is listed, not aggregated");
  assert.match(dashboardSource, /setMetric\("outstanding", usdc\(data\.outstandingReceivablesAtomic\)/);
  assert.match(dashboardSource, /setMetric\("received", usdc\(data\.receivedThisMonthAtomic\)/);
});

test("the Activity view renders outbound items as text nodes with an explorer link and expandable recipients", () => {
  assert.match(toolsSource, /import \{ describeOutbound, type ActivityItem \} from "\.\/activityModel"/);
  assert.match(toolsSource, /const outbound = describeOutbound\(item\)/);
  assert.match(toolsSource, /node\("summary", "View recipients"\)/);
  assert.match(toolsSource, /link\("Explorer ↗", outbound\.explorerHref, true\)/);
  assert.doesNotMatch(toolsSource.slice(toolsSource.indexOf("const outbound = describeOutbound")), /innerHTML/, "DOM text nodes only");
});

test("Send and Multisend pages stop claiming history is tab-only, without claiming instant persistence", () => {
  assert.doesNotMatch(paymentsSource, /does not yet record outbound payments/);
  assert.match(paymentsSource, /Confirmed transactions appear in Activity once ArcFX has indexed them\./);
  assert.match(paymentsSource, /Confirmed on Arc Mainnet\. It will appear in Activity after ArcFX indexes it\./);
  assert.match(paymentsSource, /The batch will appear in Activity after ArcFX indexes it\./);
  assert.match(paymentsSource, /"Sent from this browser tab"/, "the immediate local confirmation list remains");
  assert.match(paymentsSource, /View Activity/);
  assert.doesNotMatch(paymentsSource, /instantly|immediately (recorded|appears)|already in Activity/i);
});

test("the dashboard header no longer shows a disabled 'Send — Not enabled' button now that Send is live", () => {
  assert.doesNotMatch(dashboardSource, /Not enabled/);
  assert.doesNotMatch(dashboardSource, /class="dashboard-send"/);
  assert.match(dashboardSource, /<a class="dashboard-secondary" href="\$\{appPath\("\/workspace\?view=send"\)\}">Send<\/a>/);
});
