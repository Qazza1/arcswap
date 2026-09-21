import { arcfxApi } from "../shared/arcfxApi";
import type { ExecutionIntent } from "./tradeExecutionCore";

/** Owner-session journal client. These calls persist intent/evidence only. */
export const tradeOperationApi = {
  create: (intent: ExecutionIntent) => arcfxApi.createWalletOperation({
    idempotencyKey: intent.idempotencyKey, kind: intent.kind, sourceNetwork: intent.sourceNetwork, sourceChainId: intent.sourceChainId,
    sourceToken: "0x3600000000000000000000000000000000000000", destinationToken: intent.destinationToken === "USDC" ? "0x3600000000000000000000000000000000000000" : null,
    amountAtomic: intent.amountAtomic, minimumOutputAtomic: intent.minimumOutputAtomic, slippageBps: intent.slippageBps,
    walletProviderId: intent.binding.providerId, quoteSnapshot: intent.quoteSnapshot, quoteExpiresAt: new Date(intent.quoteExpiresAt).toISOString(),
  }),
  list: () => arcfxApi.listWalletOperations(),
  read: (id: string) => arcfxApi.readWalletOperation(id),
  appendStep: (id: string, expectedVersion: number, kind: string, state: string) => arcfxApi.appendWalletOperationStep(id, { expectedVersion, kind, state }),
  reconcileApproval: (id: string, expectedVersion: number, txHash: string) => arcfxApi.reconcileWalletOperationApproval(id, { expectedVersion, txHash }),
};
