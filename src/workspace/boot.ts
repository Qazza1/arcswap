import { arcfxMountHeader } from "../shared/header";
import { mountReceivables } from "./receivables";

const page = document.body.dataset.receivables as "overview" | "customers" | "invoices" | "invoice" | undefined;
if (!page) throw new Error("Missing receivables page identifier.");

arcfxMountHeader({
  pageKey: page === "overview" ? "app" : page,
  activeLink: page === "overview" ? null : "tools",
  activeTool: page === "invoice" || page === "invoices" ? "invoices" : null,
  mode: "product",
});
void mountReceivables(page);
