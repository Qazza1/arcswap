import { mountAppShell } from "../shared/appShell";
import { mountReceivables } from "./receivables";

const page = document.body.dataset.receivables as "overview" | "customers" | "invoices" | "invoice" | undefined;
if (!page) throw new Error("Missing receivables page identifier.");

mountAppShell(page === "overview" ? "dashboard" : page);
void mountReceivables(page);
