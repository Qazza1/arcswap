import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("Mainnet mandate and result claims fail closed on owner, chain, token, digest and execution", async (t) => {
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
  t.after(() => server.close());
  const { assertMainnetMandatePreparation, assertMainnetAnalysisResult, AGENT_MAINNET } = await server.ssrLoadModule("/src/workspace/agentMainnet.ts");
  const owner = "0x" + "63".repeat(20);
  const invoice = { id: "inv_mainnet", network: AGENT_MAINNET.network, tokenAddress: AGENT_MAINNET.usdc, amountAtomic: "1000000", authorizationDigest: "sha256:test" };
  const mandate = { principalWallet: owner, chainId: "5042", allowedAssets: [AGENT_MAINNET.usdc], allowedRecipients: [owner], maxPaymentAtomic: invoice.amountAtomic, invoiceDigest: invoice.authorizationDigest, dailyLimitAtomic: null, mandateId: "mandate_test" };
  const prepared = { mandate, preparationToken: "sealed", mandateDigest: "sha256:mandate", signingMessage: `ArcFX Agent Mandate\nversion: arcfx.agent-mandate-signature.v1\nprincipal: ${owner}\nmandate_id: mandate_test\ndigest: sha256:mandate` };
  assert.doesNotThrow(() => assertMainnetMandatePreparation(invoice, owner, prepared));
  for (const changed of [
    { ...mandate, principalWallet: "0x" + "11".repeat(20) },
    { ...mandate, chainId: "5042002" },
    { ...mandate, allowedAssets: ["0x" + "11".repeat(20)] },
    { ...mandate, invoiceDigest: "sha256:other" },
  ]) assert.throws(() => assertMainnetMandatePreparation(invoice, owner, { ...prepared, mandate: changed }));
  const result = { mandate: { status: "ACTIVE", mandateId: "mandate_test" }, run: { runId: "run_test", execution: "NOT_SUBMITTED", bundle: { bundleId: "bundle_test", verificationState: "VALID" }, proposal: { network: AGENT_MAINNET.network, caip2: AGENT_MAINNET.caip2, chainId: AGENT_MAINNET.chainId, ownerWallet: owner, recipient: owner, token: AGENT_MAINNET.usdc, amountAtomic: invoice.amountAtomic, invoiceId: invoice.id, invoiceDigest: invoice.authorizationDigest, mandateId: "mandate_test", agentRunId: "run_test", evidenceBundleId: "bundle_test", paymentExecutionEnabled: false, x402ExecutionEnabled: false, status: "NOT_SUBMITTED" } } };
  assert.doesNotThrow(() => assertMainnetAnalysisResult(invoice, owner, result));
  assert.throws(() => assertMainnetAnalysisResult(invoice, owner, { ...result, run: { ...result.run, execution: "SUBMITTED" } }));
  assert.throws(() => assertMainnetAnalysisResult(invoice, owner, { ...result, run: { ...result.run, proposal: { ...result.run.proposal, paymentExecutionEnabled: true } } }));
});
