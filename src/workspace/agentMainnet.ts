export const AGENT_MAINNET = {
  network: "arc-mainnet",
  chainId: "5042",
  caip2: "eip155:5042",
  usdc: "0x3600000000000000000000000000000000000000",
} as const;

export interface AgentInvoiceAuthority {
  id: string;
  network: string | null;
  tokenAddress: string | null;
  amountAtomic: string | null;
  authorizationDigest: string | null;
}

const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** Validate every displayed server claim before asking the pinned wallet to sign. */
export function assertMainnetMandatePreparation(invoice: AgentInvoiceAuthority, owner: string, prepared: any): void {
  const mandate = prepared?.mandate;
  if (invoice.network !== AGENT_MAINNET.network || !same(invoice.tokenAddress, AGENT_MAINNET.usdc)
      || !invoice.amountAtomic || !/^[1-9][0-9]*$/.test(invoice.amountAtomic)
      || !invoice.authorizationDigest || !/^0x[0-9a-fA-F]{40}$/.test(owner)
      || !mandate || !same(mandate.principalWallet, owner)
      || mandate.chainId !== AGENT_MAINNET.chainId
      || !Array.isArray(mandate.allowedAssets) || mandate.allowedAssets.length !== 1
      || !same(mandate.allowedAssets[0], AGENT_MAINNET.usdc)
      || !Array.isArray(mandate.allowedRecipients) || mandate.allowedRecipients.length !== 1
      || !same(mandate.allowedRecipients[0], owner)
      || mandate.maxPaymentAtomic !== invoice.amountAtomic
      || mandate.invoiceDigest !== invoice.authorizationDigest
      || mandate.dailyLimitAtomic !== null
      || typeof prepared.preparationToken !== "string" || !prepared.preparationToken
      || typeof prepared.mandateDigest !== "string" || typeof prepared.signingMessage !== "string"
      || prepared.signingMessage !== [
        "ArcFX Agent Mandate",
        "version: arcfx.agent-mandate-signature.v1",
        `principal: ${mandate.principalWallet}`,
        `mandate_id: ${mandate.mandateId}`,
        `digest: ${prepared.mandateDigest}`,
      ].join("\n")) {
    throw new Error("Agent Mandate does not match this Mainnet invoice and selected owner wallet.");
  }
}

export function assertMainnetAnalysisResult(invoice: AgentInvoiceAuthority, owner: string, result: any): void {
  const run = result?.run;
  const proposal = run?.proposal;
  if (result?.mandate?.status !== "ACTIVE" || run?.execution !== "NOT_SUBMITTED"
      || !run?.runId || !run?.bundle?.bundleId || run.bundle.verificationState !== "VALID"
      || proposal?.network !== AGENT_MAINNET.network || proposal.caip2 !== AGENT_MAINNET.caip2
      || proposal.chainId !== AGENT_MAINNET.chainId || !same(proposal.ownerWallet, owner)
      || !same(proposal.recipient, owner) || !same(proposal.token, AGENT_MAINNET.usdc)
      || proposal.amountAtomic !== invoice.amountAtomic || proposal.invoiceId !== invoice.id
      || proposal.invoiceDigest !== invoice.authorizationDigest
      || proposal.mandateId !== result.mandate.mandateId || proposal.agentRunId !== run.runId
      || proposal.evidenceBundleId !== run.bundle.bundleId
      || proposal.paymentExecutionEnabled !== false || proposal.x402ExecutionEnabled !== false
      || proposal.status !== "NOT_SUBMITTED") {
    throw new Error("Agent analysis result failed its Mainnet non-submission binding checks.");
  }
}
