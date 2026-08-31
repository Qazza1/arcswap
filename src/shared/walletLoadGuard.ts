/**
 * Page-local freshness guard for asynchronous wallet-specific displays.
 *
 * Wallet RPC and public API reads cannot always be aborted, so callers retain
 * the address and generation that began a load and verify both before paint.
 */

export interface WalletLoadTicket {
  address: string | null;
  generation: number;
}

function normalize(address: string | null | undefined): string | null {
  return address ? address.toLowerCase() : null;
}

export function createWalletLoadGuard() {
  let address: string | null = null;
  let generation = 0;

  return {
    transition(nextAddress: string | null | undefined): void {
      address = normalize(nextAddress);
      generation++;
    },

    begin(nextAddress: string | null | undefined): WalletLoadTicket {
      return { address: normalize(nextAddress), generation };
    },

    isCurrent(ticket: WalletLoadTicket): boolean {
      return ticket.generation === generation && ticket.address === address;
    },
  };
}
