# Deployed & verified contract sources

Byte-exact copies of the sources that produced the bytecode currently deployed on
Arc Testnet. Both are verified on ArcScan with a **full** match, meaning the
metadata hash matches too — these are provably the exact sources behind the
deployed contracts, not merely functionally equivalent ones.

**These files are a historical record. Do not edit them.** They exist so the
canonical-source merge before the mainnet audit has a reliable reference point.

## Contracts

| | ArcFXPayments | ArcFXMultisender |
|---|---|---|
| Address | `0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3` | `0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398` |
| `FEE_BPS` | **15** (0.15%) | **10** (0.10%) |
| Runtime bytecode | 3,270 bytes | 3,771 bytes |
| Provenance | identical to `contracts/ArcFXPayments.sol` at `HEAD` | commit `e609339` version — **not** current `HEAD` |
| SHA-256 of file | `f1c1e3cf…ccca02` | `25123955…5f6d77` |

Verified: <https://testnet.arcscan.app/address/0xc37D88f17573f13F7A27D33a502f5f1fB7D545D3>
and <https://testnet.arcscan.app/address/0xF7aeb369bB50b7d9E2DDe7d3aC386B5ed6e71398>

## Build settings (identical for both — they were one compilation)

```
compiler   : v0.8.20+commit.a1b79de6
optimizer  : enabled, runs 200
evmVersion : paris
license    : MIT
constructor: 0x0000000000000000000000004f81e3939232815e3c98b124a17bac75304c82d8
```

## Why the two contracts charge different fees

`contracts/ArcFXMultisender.sol` diverged from what was deployed. After the
Multisender went live at commit `e609339`, the source was edited but **never
redeployed**:

| Deployed (`e609339`) | Current `contracts/` source |
|---|---|
| `feeRecipient` | `treasury` |
| `setFeeRecipient()` | `setTreasury()` |
| `FeeRecipientUpdated` | `TreasuryUpdated` |
| `FEE_BPS = 10` | `FEE_BPS = 15` |
| `require(..., "Invalid address")` | `require(..., "Invalid treasury address")` |

That edit is the origin of the fee mismatch: the site advertised one rate while
the two live contracts charged 0.15% (payments) and 0.10% (batches).

## This is now checked automatically

Everything below used to be a thing you had to remember. It is enforced instead:

```bash
npm run check:deployments
```

`script/deployments.mjs` reads Arc Testnet directly and compares the live
addresses, runtime-bytecode hashes and public constants against
`deployments/arc-testnet.json`, plus the SHA-256 of every file in this
directory. It fails on any drift, needs no secrets, and runs in CI on every
push. Had it existed earlier, the fee mismatch would have been caught the day
the Multisender source was edited.

After a **real** deploy — and only then — regenerate the manifest:

```bash
npm run write:deployments
```

## Sources to reconcile before the audit

1. **Deployed ArcFXPayments** — this directory
2. **Deployed ArcFXMultisender** — this directory; equals `contracts/ArcFXMultisender.sol` at `e609339`
3. **Current `contracts/`** — pinned `pragma 0.8.35`, correct `FEE_BPS` per contract
   (15 payments / 10 multisend), `treasury` naming, CEI ordering, checked returns,
   `forge fmt` formatting

`contracts/` no longer matches either deployed source byte-for-byte, and is not
supposed to — it carries the hardening that ships in the single audited mainnet
deploy. The manifest is what keeps the *behaviour* honest in the meantime: the
constants it pins are read from the chain, not from the source.

## Open items for the auditor

- `owner` and the fee destination are the same EOA (`0x4F81…82D8`) on both contracts.
  A multisig for at least the fee-recipient role is the standard mainnet expectation.
- `pay()` is fee-deducted (recipient receives `gross - fee`); the intended model is
  fee-on-top. The frontend compensates by grossing up.
- `paymentId` is not deduplicated on-chain; the backend indexer handles it.
- Token addresses are not restricted on-chain to USDC/EURC — intentional, flagged.

## Reproducing verification

These files are pinned `-text` in `.gitattributes` so git never rewrites their line
endings — they are LF-only, and any conversion changes the metadata hash. Compile
with the settings above and the resulting `deployedBytecode` matches the chain exactly.
