import "./receivables.css";
import { arcfxApi } from "../shared/arcfxApi";
import { arcfxWallet, type WalletState } from "../shared/wallet";

type Invoice = {
  id: string;
  number: string;
  paymentId: string;
  network: string | null;
  status: string;
  customer: { id: string; name: string | null } | null;
  token: string | null;
  tokenAddress: string | null;
  amount: string | null;
  paid: string;
  outstanding: string | null;
  dueDate: string | null;
  note: string | null;
  createdAt: string | null;
  sentAt: string | null;
};
type Customer = {
  id: string;
  name: string;
  email: string | null;
  notes: string | null;
  archived: boolean;
  invoiceCount: number;
  addresses: Array<{
    address: string;
    label: string | null;
    isDefault: boolean;
  }>;
};
type Page = "overview" | "invoices" | "invoice" | "customers";

const MAINNET_CHAIN_HEX = "0x13b2";
const MAINNET = {
  caip2: "eip155:5042",
  rpc: "https://rpc.mainnet.arc.io",
  explorer: "https://explorer.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  payments: "0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398",
  multisender: "0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3",
} as const;
const root = document.getElementById("receivables-root") as HTMLElement | null;
const short = (v: string | null | undefined) =>
  v ? `${v.slice(0, 6)}…${v.slice(-4)}` : "—";
const displayDate = (v: string | null) =>
  v
    ? new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(new Date(v))
    : "—";
const displayAmount = (v: string | null, token: string | null) =>
  v == null ? "—" : `${v} ${token || "token"}`;
const mainnetSelected = (state = arcfxWallet.state) =>
  state.connected && state.chainId?.toLowerCase() === MAINNET_CHAIN_HEX;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
function action(
  label: string,
  className = "",
  run?: () => void | Promise<void>
): HTMLButtonElement {
  const b = make("button", `fx-button ${className}`.trim(), label);
  b.type = "button";
  if (run) b.addEventListener("click", () => void run());
  return b;
}
function nav(label: string, href: string, className = "") {
  const a = make("a", `fx-button ${className}`.trim(), label);
  a.href = href;
  return a;
}
function message(text: string, tone = "") {
  const e = make("div", `fx-notice ${tone}`.trim(), text);
  e.setAttribute("role", "status");
  return e;
}
function status(value: string) {
  return make("span", `fx-pill fx-pill--${value}`, value);
}
function busy(b: HTMLButtonElement, state: boolean, label: string) {
  b.disabled = state;
  b.textContent = state ? `${label}…` : label;
}
function invoiceHref(id: string) {
  return `/invoice?id=${encodeURIComponent(id)}`;
}
function cardHeading(title: string, right?: HTMLElement) {
  const h = make("div", "fx-card-head");
  h.append(make("h2", "", title));
  if (right) h.append(right);
  return h;
}
function workspaceHeader(
  eyebrow: string,
  title: string,
  subtitle: string,
  actions: HTMLElement[] = []
) {
  const h = make("header", "receivables-header");
  const copy = make("div");
  copy.append(
    make("p", "receivables-eyebrow", eyebrow),
    make("h1", "receivables-title", title),
    make("p", "receivables-subtitle", subtitle)
  );
  const side = make("div", "receivables-actions");
  side.append(
    make("span", "fx-network", `Arc Mainnet · ${MAINNET.caip2}`),
    ...actions
  );
  h.append(copy, side);
  return h;
}
function empty(title: string, copy: string, cta?: HTMLElement) {
  const e = make("section", "fx-empty");
  e.append(make("h2", "", title), make("p", "", copy));
  if (cta) {
    cta.style.marginTop = "16px";
    e.append(cta);
  }
  return e;
}
function summary(rows: Array<[string, string]>) {
  const box = make("section", "fx-summary");
  rows.forEach(([label, value]) => {
    const item = make("div", "fx-summary-item");
    item.append(
      make("div", "fx-summary-label", label),
      make("div", "fx-summary-value", value)
    );
    box.append(item);
  });
  return box;
}
function paintReceivablesNetwork(state: WalletState) {
  if (!mainnetSelected(state)) return;
  const label = document.getElementById("arcfx-account-network");
  if (label) label.textContent = "Arc Mainnet · receivables";
}
function workspaceReady(
  container: HTMLElement,
  state: WalletState = arcfxWallet.state
) {
  if (mainnetSelected(state)) {
    paintReceivablesNetwork(state);
    return true;
  }
  container.replaceChildren(
    empty(
      "Open your receivables workspace",
      "Connect your selected wallet on Arc Mainnet (chain 5042) to view and manage your records.",
      action("Connect wallet", "fx-button--primary", async () => {
        try {
          await arcfxApi.connectReceivablesOwner();
          if (!mainnetSelected())
            throw new Error(
              "Switch the selected wallet to Arc Mainnet (chain 5042), then try again."
            );
        } catch (e) {
          container.prepend(
            message(
              e instanceof Error ? e.message : "Could not connect wallet.",
              "fx-notice--error"
            )
          );
        }
      })
    )
  );
  return false;
}

function invoiceRow(invoice: Invoice) {
  const tr = make("tr");
  const identity = make("td");
  const link = make("a", "fx-row-link", invoice.number);
  link.href = invoiceHref(invoice.id);
  identity.append(
    link,
    make("div", "fx-muted fx-small fx-mono", short(invoice.id))
  );
  const customer = make("td", "", invoice.customer?.name || "No customer");
  const network = make("td", "fx-muted", invoice.network || "Unclassified");
  const due = make("td", "fx-muted", displayDate(invoice.dueDate));
  const paid = make("td", "fx-amount");
  paid.append(
    make("div", "fx-mono", displayAmount(invoice.paid, invoice.token)),
    make(
      "div",
      "fx-muted fx-small",
      `Outstanding ${displayAmount(invoice.outstanding, invoice.token)}`
    )
  );
  const created = make("td", "fx-muted", displayDate(invoice.createdAt));
  const state = make("td");
  state.append(status(invoice.status));
  tr.append(identity, customer, network, due, paid, created, state);
  return tr;
}
function invoiceTile(invoice: Invoice) {
  const item = make("article", "fx-invoice-card");
  const top = make("div", "fx-invoice-card-top");
  const link = make("a", "fx-row-link", invoice.number);
  link.href = invoiceHref(invoice.id);
  top.append(link, status(invoice.status));
  const bottom = make("div", "fx-invoice-card-bottom");
  bottom.append(
    make("div", "fx-muted fx-small", invoice.customer?.name || "No customer"),
    make("div", "fx-mono", displayAmount(invoice.amount, invoice.token))
  );
  item.append(
    top,
    bottom,
    make(
      "div",
      "fx-muted fx-small",
      `${invoice.network || "Unclassified"} · created ${displayDate(
        invoice.createdAt
      )}`
    ),
    make("div", "fx-muted fx-small", `Due ${displayDate(invoice.dueDate)}`)
  );
  return item;
}

async function overview() {
  if (!root) return;
  root.replaceChildren(
    workspaceHeader(
      "Receivables workspace",
      "Know what is owed.",
      "Invoices and reconciliation are recorded against Arc Mainnet.",
      [nav("New invoice", "/invoice", "fx-button--primary")]
    )
  );
  const content = make("div");
  root.append(content);
  const render = async (state: WalletState) => {
    content.replaceChildren();
    if (!workspaceReady(content, state)) return;
    try {
      const data = await arcfxApi.listReceivablesInvoices();
      const invoiceRecords: Invoice[] = data.invoices || [];
      const totals = Object.entries(data.outstandingByToken || {}).map(
        ([token, value]) =>
          [`${token} outstanding`, `${value} ${token}`] as [string, string]
      );
      const fallback: Array<[string, string]> = [
        ["Outstanding", "No issued receivables"],
      ];
      const summaryRows: Array<[string, string]> = [
        ["Tracked invoices", String(invoiceRecords.length)],
        ...(totals.length ? totals : fallback),
      ];
      content.append(
        message(
          "These are records owned by the connected wallet. The workspace does not submit browser transactions."
        ),
        summary(summaryRows)
      );
      const card = make("section", "fx-card");
      card.append(
        cardHeading("Recent invoices", nav("View invoices", "/invoices"))
      );
      const body = make("div", "fx-card-body");
      if (invoiceRecords.length)
        body.append(...invoiceRecords.slice(0, 5).map(invoiceTile));
      else
        body.append(
          empty(
            "No invoices yet",
            "Create a draft when you are ready to record a receivable.",
            nav("New invoice", "/invoice", "fx-button--primary")
          )
        );
      card.append(body);
      content.append(card);
    } catch (e) {
      content.append(
        message(
          e instanceof Error ? e.message : "Could not load workspace data.",
          "fx-notice--error"
        )
      );
    }
  };
  arcfxWallet.onChange((state) => void render(state));
  await render(arcfxWallet.state);
}

async function invoices() {
  if (!root) return;
  root.replaceChildren(
    workspaceHeader(
      "Receivables",
      "Invoices",
      "Search and filter records by their authoritative invoice, token, network, and settlement state.",
      [nav("New invoice", "/invoice", "fx-button--primary")]
    )
  );
  const content = make("div");
  root.append(content);
  let records: Invoice[] = [];
  let searchText = "";
  let statusFilter = "all";
  let totals: Record<string, string> = {};
  const render = () => {
    content.replaceChildren();
    if (!workspaceReady(content)) return;
    const totalRows = Object.entries(totals).map(
      ([token, value]) =>
        [`${token} outstanding`, `${value} ${token}`] as [string, string]
    );
    content.append(
      summary([["Invoices", String(records.length)], ...totalRows])
    );
    const reconcile = action("Reconcile", "", async () => {
      busy(reconcile, true, "Reconciling");
      try {
        const r = await arcfxApi.reconcileReceivables();
        content.prepend(
          message(
            `${r.reconciled || 0} invoice record${
              r.reconciled === 1 ? "" : "s"
            } reconciled.`,
            "fx-notice--success"
          )
        );
        await load();
      } catch (e) {
        content.prepend(
          message(
            e instanceof Error ? e.message : "Reconciliation failed.",
            "fx-notice--error"
          )
        );
      } finally {
        busy(reconcile, false, "Reconcile");
      }
    });
    const card = make("section", "fx-card");
    card.append(cardHeading("All invoices", reconcile));
    const body = make("div", "fx-card-body");
    const toolbar = make("div", "fx-toolbar");
    const search = make("input", "fx-input fx-search") as HTMLInputElement;
    search.placeholder = "Search number, customer, or invoice ID";
    search.value = searchText;
    search.addEventListener("input", () => {
      searchText = search.value.toLowerCase();
      render();
    });
    const filter = make("select", "fx-select fx-filter") as HTMLSelectElement;
    ["all", "draft", "sent", "partial", "paid", "overdue", "cancelled"].forEach(
      (v) => {
        const o = make("option", "", v === "all" ? "All statuses" : v);
        o.value = v;
        o.selected = v === statusFilter;
        filter.append(o);
      }
    );
    filter.addEventListener("change", () => {
      statusFilter = filter.value;
      render();
    });
    toolbar.append(search, filter);
    body.append(toolbar);
    const visible = records.filter(
      (i) =>
        (statusFilter === "all" || i.status === statusFilter) &&
        `${i.number} ${i.customer?.name || ""} ${i.id}`
          .toLowerCase()
          .includes(searchText)
    );
    if (!visible.length)
      body.append(
        empty(
          records.length ? "No matching invoices" : "No invoices yet",
          records.length
            ? "Try another search term."
            : "Create a draft to begin tracking receivables.",
          records.length
            ? undefined
            : nav("New invoice", "/invoice", "fx-button--primary")
        )
      );
    else {
      const wrap = make("div", "fx-table-wrap");
      const table = make("table", "fx-table");
      const head = make("thead");
      const header = make("tr");
      [
        "Invoice",
        "Customer",
        "Network",
        "Due",
        "Settlement",
        "Created",
        "Status",
      ].forEach((t) => header.append(make("th", "", t)));
      head.append(header);
      const tbody = make("tbody");
      visible.forEach((i) => tbody.append(invoiceRow(i)));
      table.append(head, tbody);
      wrap.append(table);
      const cards = make("div", "fx-cards");
      visible.forEach((i) => cards.append(invoiceTile(i)));
      body.append(wrap, cards);
    }
    card.append(body);
    content.append(card);
  };
  const load = async () => {
    content.replaceChildren(message("Loading invoices…"));
    if (!mainnetSelected()) {
      workspaceReady(content);
      return;
    }
    try {
      const data = await arcfxApi.listReceivablesInvoices();
      records = data.invoices || [];
      totals = data.outstandingByToken || {};
      render();
    } catch (e) {
      content.replaceChildren(
        message(
          e instanceof Error ? e.message : "Could not load invoices.",
          "fx-notice--error"
        )
      );
    }
  };
  arcfxWallet.onChange(() => void load());
  await load();
}

function field(label: string, id: string, type = "text", required = false) {
  const wrap = make("div", "fx-field");
  const labelEl = make("label", "", label);
  labelEl.htmlFor = id;
  const input = make("input", "fx-input") as HTMLInputElement;
  input.id = id;
  input.type = type;
  input.required = required;
  wrap.append(labelEl, input);
  return { wrap, input };
}
async function customerList(): Promise<Customer[]> {
  const data = await arcfxApi.listReceivablesCustomers();
  return data.customers || [];
}

async function invoiceEditor(content: HTMLElement) {
  content.replaceChildren(message("Loading customers…"));
  let customers: Customer[] = [];
  try {
    customers = await customerList();
  } catch (e) {
    content.replaceChildren(
      message(
        e instanceof Error ? e.message : "Could not load customers.",
        "fx-notice--error"
      )
    );
    return;
  }
  content.replaceChildren(
    message(
      "This editor persists one invoice amount, token, due date, customer link, and note. Line items, logos, and visual layout are not saved by the current API."
    )
  );
  const card = make("section", "fx-card");
  card.append(cardHeading("Invoice information"));
  const form = make("form", "fx-card-body fx-form");
  const number = field("Invoice number", "invoice-number", "text", true);
  number.input.maxLength = 64;
  const amount = field("Amount", "invoice-amount", "text", true);
  amount.input.inputMode = "decimal";
  amount.input.placeholder = "0.00";
  const due = field("Due date", "invoice-due", "date");
  const token = make("select", "fx-select") as HTMLSelectElement;
  token.id = "invoice-token";
  const usdc = make("option", "", "USDC");
  usdc.value = MAINNET.usdc;
  token.append(usdc);
  const tokenField = make("div", "fx-field");
  tokenField.append(
    make("label", "", "Token"),
    token,
    make("p", "fx-field-help", "Canonical Arc Mainnet USDC.")
  );
  const customer = make("select", "fx-select") as HTMLSelectElement;
  const noCustomer = make("option", "", "No linked customer");
  noCustomer.value = "";
  customer.append(noCustomer);
  customers.forEach((c) => {
    const option = make("option", "", c.name);
    option.value = c.id;
    customer.append(option);
  });
  const customerField = make("div", "fx-field");
  customerField.append(
    make("label", "", "Customer"),
    customer,
    make(
      "p",
      "fx-field-help",
      customers.length
        ? "Optional server-backed customer link."
        : "Create a customer first to link it."
    )
  );
  const note = make("textarea", "fx-textarea") as HTMLTextAreaElement;
  note.maxLength = 500;
  const noteField = make("div", "fx-field");
  noteField.append(make("label", "", "Note"), note);
  const grid = make("div", "fx-field-grid");
  grid.append(number.wrap, amount.wrap, tokenField, due.wrap, customerField);
  const feedback = make("div");
  const save = action("Save draft", "fx-button--primary");
  form.append(grid, noteField, save, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!mainnetSelected()) {
      feedback.replaceChildren(
        message(
          "Switch the selected wallet to Arc Mainnet before saving.",
          "fx-notice--warning"
        )
      );
      return;
    }
    busy(save, true, "Saving");
    try {
      const result = await arcfxApi.createReceivablesInvoice({
        number: number.input.value.trim(),
        amount: amount.input.value.trim(),
        token: token.value,
        dueDate: due.input.value || undefined,
        customerId: customer.value || undefined,
        note: note.value.trim() || undefined,
        send: false,
      });
      location.assign(invoiceHref(result.invoice.id));
    } catch (e) {
      feedback.replaceChildren(
        message(
          e instanceof Error ? e.message : "Could not save invoice.",
          "fx-notice--error"
        )
      );
    } finally {
      busy(save, false, "Save draft");
    }
  });
  card.append(form);
  content.append(card);
}

function invoiceDetails(invoice: Invoice) {
  const grid = make("div", "fx-details");
  const values: Array<[string, string]> = [
    ["Invoice", invoice.number],
    ["Status", invoice.status],
    ["Amount", displayAmount(invoice.amount, invoice.token)],
    ["Paid", displayAmount(invoice.paid, invoice.token)],
    ["Outstanding", displayAmount(invoice.outstanding, invoice.token)],
    ["Network", invoice.network || "Unclassified"],
    ["Payment ID", invoice.paymentId],
    ["Invoice ID", invoice.id],
    ["Due date", displayDate(invoice.dueDate)],
    ["Created", displayDate(invoice.createdAt)],
    ["Customer", invoice.customer?.name || "No linked customer"],
    ["Token address", invoice.tokenAddress || "—"],
  ];
  values.forEach(([label, value]) => {
    const cell = make("div", "fx-detail");
    cell.append(
      make("div", "fx-detail-label", label),
      make(
        "div",
        label.includes("ID") || label.includes("address")
          ? "fx-detail-value fx-mono"
          : "fx-detail-value",
        value
      )
    );
    grid.append(cell);
  });
  return grid;
}
async function invoiceDetail(content: HTMLElement, id: string) {
  content.replaceChildren(message("Loading invoice…"));
  let invoice: Invoice | undefined;
  let customers: Customer[] = [];
  try {
    const [data, loadedCustomers] = await Promise.all([
      arcfxApi.listReceivablesInvoices(),
      customerList(),
    ]);
    invoice = (data.invoices || []).find((i: Invoice) => i.id === id);
    customers = loadedCustomers;
    if (!invoice) {
      content.replaceChildren(
        empty(
          "Invoice not found",
          "It may belong to another wallet or network.",
          nav("All invoices", "/invoices")
        )
      );
      return;
    }
  } catch (e) {
    content.replaceChildren(
      message(
        e instanceof Error ? e.message : "Could not load invoice.",
        "fx-notice--error"
      )
    );
    return;
  }
  const render = () => {
    if (!invoice) return;
    content.replaceChildren(
      message(
        "Settlement state is calculated on the backend from Mainnet payment records that match this invoice's network and token."
      )
    );
    const layout = make("div", "fx-detail-grid");
    const info = make("section", "fx-card");
    info.append(cardHeading("Invoice information"));
    const infoBody = make("div", "fx-card-body");
    infoBody.append(invoiceDetails(invoice));
    info.append(infoBody);
    layout.append(info);
    const settle = make("section", "fx-card");
    settle.append(cardHeading("Settlement & reconciliation"));
    const settleBody = make("div", "fx-card-body fx-list");
    settleBody.append(
      make(
        "p",
        "fx-field-help",
        "Reconciliation reads and allocates eligible records. It does not send a payment transaction."
      ),
      make(
        "p",
        "fx-field-help",
        "The payer link uses only the authoritative public invoice record. The payer cannot select a different token, recipient, payment ID, amount, or network."
      )
    );
    if (["sent", "partial", "overdue"].includes(invoice.status)) {
      const payerLink = nav("Open public payer", `/payer?invoice=${encodeURIComponent(invoice.id)}`);
      payerLink.target = "_blank";
      payerLink.rel = "noopener noreferrer";
      settleBody.append(payerLink);
    }
    const reconcile = action(
      "Reconcile invoice",
      "fx-button--primary",
      async () => {
        busy(reconcile, true, "Reconciling");
        try {
          const r = await arcfxApi.reconcileReceivables(invoice!.id);
          content.prepend(
            message(
              r.results?.[0]?.allocated
                ? `Reconciled ${r.results[0].allocated} payment allocation${
                    r.results[0].allocated === 1 ? "" : "s"
                  }.`
                : "No new eligible payments found.",
              "fx-notice--success"
            )
          );
          const all = await arcfxApi.listReceivablesInvoices();
          invoice = all.invoices.find((x: Invoice) => x.id === id);
          render();
        } catch (e) {
          content.prepend(
            message(
              e instanceof Error ? e.message : "Reconciliation failed.",
              "fx-notice--error"
            )
          );
        } finally {
          busy(reconcile, false, "Reconcile invoice");
        }
      }
    );
    settleBody.append(reconcile);
    if (invoice.status === "draft") {
      const issue = action("Mark issued", "", async () => {
        busy(issue, true, "Marking issued");
        try {
          const result = await arcfxApi.updateReceivablesInvoice({
            id: invoice!.id,
            action: "send",
          });
          invoice = result.invoice;
          render();
        } catch (e) {
          content.prepend(
            message(
              e instanceof Error ? e.message : "Could not issue invoice.",
              "fx-notice--error"
            )
          );
        } finally {
          busy(issue, false, "Mark issued");
        }
      });
      settleBody.append(issue);
    }
    if (["draft", "sent"].includes(invoice.status)) {
      const cancel = action("Cancel invoice", "fx-button--danger", async () => {
        if (!confirm(`Cancel ${invoice!.number}?`)) return;
        busy(cancel, true, "Cancelling");
        try {
          const result = await arcfxApi.updateReceivablesInvoice({
            id: invoice!.id,
            action: "cancel",
          });
          invoice = result.invoice;
          render();
        } catch (e) {
          content.prepend(
            message(
              e instanceof Error ? e.message : "Could not cancel invoice.",
              "fx-notice--error"
            )
          );
        } finally {
          busy(cancel, false, "Cancel invoice");
        }
      });
      settleBody.append(cancel);
    }
    settle.append(settleBody);
    layout.append(settle);
    content.append(layout);
    const edit = make("section", "fx-card");
    edit.append(cardHeading("Edit stored fields"));
    const form = make("form", "fx-card-body fx-form");
    const due = field("Due date", "detail-due", "date");
    due.input.value = invoice.dueDate || "";
    const customer = make("select", "fx-select") as HTMLSelectElement;
    customer.append(
      Object.assign(make("option", "", "No linked customer"), { value: "" })
    );
    customers
      .filter((c) => !c.archived || c.id === invoice!.customer?.id)
      .forEach((c) => {
        const o = make("option", "", c.name);
        o.value = c.id;
        o.selected = c.id === invoice!.customer?.id;
        customer.append(o);
      });
    const customerField = make("div", "fx-field");
    customerField.append(make("label", "", "Customer"), customer);
    const note = make("textarea", "fx-textarea") as HTMLTextAreaElement;
    note.value = invoice.note || "";
    const noteField = make("div", "fx-field");
    noteField.append(make("label", "", "Note"), note);
    const grid = make("div", "fx-field-grid");
    grid.append(due.wrap, customerField);
    const save = action("Save changes", "fx-button--primary");
    form.append(grid, noteField, save);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      busy(save, true, "Saving");
      try {
        const result = await arcfxApi.updateReceivablesInvoice({
          id: invoice!.id,
          action: "edit",
          dueDate: due.input.value || null,
          customerId: customer.value || null,
          note: note.value || null,
        });
        invoice = result.invoice;
        render();
      } catch (e) {
        content.prepend(
          message(
            e instanceof Error ? e.message : "Could not save changes.",
            "fx-notice--error"
          )
        );
      } finally {
        busy(save, false, "Save changes");
      }
    });
    edit.append(form);
    content.append(
      edit,
      make(
        "section",
        "fx-agent-boundary",
        "Agent Evidence is unavailable for Arc Mainnet in this release. The existing Testnet-only backend guard remains in effect."
      )
    );
  };
  render();
}
async function invoicePage() {
  if (!root) return;
  const id = new URLSearchParams(location.search).get("id");
  root.replaceChildren(
    workspaceHeader(
      id ? "Receivables" : "New receivable",
      id ? "Invoice detail" : "Create an invoice",
      id
        ? "Review the persisted invoice and settlement state."
        : "Only fields persisted by the current invoice API appear in this editor.",
      [nav("All invoices", "/invoices")]
    )
  );
  const content = make("div");
  root.append(content);
  if (!workspaceReady(content)) return;
  if (id) return invoiceDetail(content, id);
  return invoiceEditor(content);
}

function customerEditor(
  customer: Customer | undefined,
  completed: () => Promise<void>
) {
  const form = make("form", "fx-form");
  const name = field("Customer name", "customer-name", "text", true);
  name.input.value = customer?.name || "";
  const email = field("Email", "customer-email", "email");
  email.input.value = customer?.email || "";
  const savedAddress =
    customer?.addresses.find((a) => a.isDefault) || customer?.addresses[0];
  const address = field("Wallet address", "customer-address");
  address.input.value = savedAddress?.address || "";
  const label = field("Address label", "customer-address-label");
  label.input.value = savedAddress?.label || "";
  const notes = make("textarea", "fx-textarea") as HTMLTextAreaElement;
  notes.value = customer?.notes || "";
  const notesField = make("div", "fx-field");
  notesField.append(make("label", "", "Notes"), notes);
  const grid = make("div", "fx-field-grid");
  grid.append(name.wrap, email.wrap, address.wrap, label.wrap);
  const feedback = make("div");
  const save = action(
    customer ? "Save customer" : "Create customer",
    "fx-button--primary"
  );
  form.append(grid, notesField, save, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const wallet = address.input.value.trim();
    if (wallet && !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      feedback.replaceChildren(
        message(
          "Wallet address must be a valid 0x address.",
          "fx-notice--error"
        )
      );
      return;
    }
    busy(save, true, customer ? "Saving" : "Creating");
    try {
      await arcfxApi.saveReceivablesCustomer({
        id: customer?.id,
        name: name.input.value.trim(),
        email: email.input.value.trim() || null,
        notes: notes.value.trim() || null,
        addresses: wallet
          ? [
              {
                address: wallet,
                label: label.input.value.trim() || null,
                isDefault: true,
              },
            ]
          : [],
      });
      await completed();
    } catch (e) {
      feedback.replaceChildren(
        message(
          e instanceof Error ? e.message : "Could not save customer.",
          "fx-notice--error"
        )
      );
    } finally {
      busy(save, false, customer ? "Save customer" : "Create customer");
    }
  });
  return form;
}

async function customersPage() {
  if (!root) return;
  root.replaceChildren(
    workspaceHeader(
      "Receivables",
      "Customers",
      "Server-backed customer records are separate from the Browser Contacts address book.",
      [nav("New invoice", "/invoice", "fx-button--primary")]
    )
  );
  const content = make("div");
  root.append(content);
  if (!workspaceReady(content)) return;
  let records: Customer[] = [];
  let searchText = "";
  let includeArchived = false;
  const openDialog = (customer?: Customer) => {
    const overlay = make("div", "fx-dialog");
    const pane = make("section", "fx-dialog-card");
    pane.setAttribute("role", "dialog");
    pane.setAttribute("aria-modal", "true");
    pane.setAttribute(
      "aria-label",
      customer ? "Edit customer" : "New customer"
    );
    const head = make("div", "fx-dialog-head");
    head.append(make("h2", "", customer ? "Edit customer" : "New customer"));
    const close = action("Close", "", () => overlay.remove());
    head.append(close);
    pane.append(
      head,
      customerEditor(customer, async () => {
        overlay.remove();
        await load();
      })
    );
    overlay.append(pane);
    document.body.append(overlay);
    close.focus();
  };
  const render = () => {
    content.replaceChildren();
    const add = action("New customer", "fx-button--primary", () =>
      openDialog()
    );
    const card = make("section", "fx-card");
    card.append(cardHeading("Customer records", add));
    const body = make("div", "fx-card-body");
    const toolbar = make("div", "fx-toolbar");
    const search = make("input", "fx-input fx-search") as HTMLInputElement;
    search.placeholder = "Search customers or wallet addresses";
    search.value = searchText;
    search.addEventListener("input", () => {
      searchText = search.value.toLowerCase();
      render();
    });
    const archiveToggle = action(
      includeArchived ? "Hide archived" : "Show archived",
      "",
      async () => {
        includeArchived = !includeArchived;
        await load();
      }
    );
    toolbar.append(search, archiveToggle);
    body.append(toolbar);
    const visible = records.filter((c) =>
      `${c.name} ${c.email || ""} ${c.addresses
        .map((a) => a.address)
        .join(" ")}`
        .toLowerCase()
        .includes(searchText)
    );
    if (!visible.length) {
      body.append(
        empty(
          records.length ? "No matching customers" : "No customers yet",
          records.length
            ? "Try a different search term."
            : "Create a customer to link future invoices.",
          records.length ? undefined : add
        )
      );
    } else {
      const list = make("div", "fx-list");
      visible.forEach((customer) => {
        const row = make("article", "fx-customer");
        const info = make("div");
        info.append(
          make("div", "fx-customer-name", customer.name),
          make("div", "fx-muted fx-small", customer.email || "No email")
        );
        const addr =
          customer.addresses.find((a) => a.isDefault) || customer.addresses[0];
        if (addr) info.append(make("div", "fx-customer-address", addr.address));
        const controls = make("div", "receivables-actions");
        controls.append(
          action("Edit", "", () => openDialog(customer)),
          action(
            customer.archived ? "Restore" : "Archive",
            customer.archived ? "" : "fx-button--danger",
            async () => {
              try {
                await arcfxApi.archiveReceivablesCustomer(customer.id, !customer.archived);
                await load();
              } catch (e) {
                content.prepend(
                  message(
                    e instanceof Error
                      ? e.message
                      : "Could not update customer.",
                    "fx-notice--error"
                  )
                );
              }
            }
          )
        );
        row.append(info, controls);
        list.append(row);
      });
      body.append(list);
    }
    card.append(body);
    content.append(card);
  };
  const load = async () => {
    content.replaceChildren(message("Loading customers…"));
    try {
      const data = await arcfxApi.listReceivablesCustomers({ archived: includeArchived });
      records = data.customers || [];
      render();
    } catch (e) {
      content.replaceChildren(
        message(
          e instanceof Error ? e.message : "Could not load customers.",
          "fx-notice--error"
        )
      );
    }
  };
  arcfxWallet.onChange(() => void load());
  await load();
}

export async function mountReceivables(page: Page) {
  if (page === "overview") return overview();
  if (page === "invoices") return invoices();
  if (page === "invoice") return invoicePage();
  return customersPage();
}
