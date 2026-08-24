# Arc FX Swap Widget

Swap USDC ↔ EURC on Arc Testnet using Circle's App Kit.  
Built with: Arc App Kit · Viem adapter · Ethers.js · Vite

---

## Before you start — 3 things to set up

### 1. MetaMask
Install from https://metamask.io if you haven't already.  
The app will automatically add Arc Testnet to MetaMask when you connect.

### 2. Testnet tokens
Get free USDC and EURC at: **https://faucet.circle.com**  
→ Select "Arc Testnet" and request both USDC and EURC.  
You need USDC to pay for gas AND as the token to swap.

### 3. Kit Key (free)
Go to: **https://console.circle.com**  
→ Create a free account → Create a project → Copy the Kit Key  
It looks like: `KIT_KEY:abc123:xyz789`

---

## Setup

```bash
# 1. Clone or unzip the project, then install dependencies
npm install

# 2. Create your .env file from the template
cp .env.example .env

# 3. Edit .env and paste in your Kit Key
#    VITE_KIT_KEY=KIT_KEY:your-key-id:your-key-secret

# 4. Start the dev server
npm run dev
```

Open http://localhost:5173 in your browser.

---

## How it works

```
User types amount
       ↓
kit.estimateSwap()    ← reads expected output, NO transaction
       ↓
Shows "≈ 0.99 EURC"
       ↓
User clicks "Swap"
       ↓
kit.swap()            ← MetaMask asks to sign
       ↓
Arc settles in <1 second
       ↓
Shows result + ArcScan link
```

### File structure

```
fx-swap-widget/
├── index.html        ← UI (all styles inline, no framework)
├── src/
│   └── main.ts       ← all the logic (wallet, balances, swap)
├── package.json
├── vite.config.ts
├── tsconfig.json
├── .env.example      ← copy to .env and fill in Kit Key
└── .gitignore        ← .env is excluded from git
```

### Key contracts on Arc Testnet

| Token | Address | Decimals |
|-------|---------|----------|
| USDC  | `0x3600000000000000000000000000000000000000` | 6 |
| EURC  | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | 6 |

Chain ID: `5042002` (0x4CEF52)  
RPC: `https://rpc.testnet.arc.network`  
Explorer: https://testnet.arcscan.app

---

## Useful links

- Arc docs: https://docs.arc.network
- App Kit swap: https://docs.arc.network/app-kit/swap
- Circle Console (Kit Keys): https://console.circle.com
- Testnet faucet: https://faucet.circle.com
- ArcScan explorer: https://testnet.arcscan.app
- Arc Discord: https://discord.com/invite/buildonarc

---

## Extending this project

Ideas for adding more features (and making it more grant-worthy):

- **Slippage control** — add a settings panel, pass `slippageBps` to `kit.swap()`
- **Transaction history** — store past swaps in localStorage, show a list
- **Cross-chain bridge** — use `kit.bridge()` to bring USDC in from Ethereum Sepolia
- **Wallet balance auto-refresh** — poll every 10s with setInterval
- **EURC → USDC direction on launch** — expose as a URL query param `?from=EURC`

---

## Building for production

```bash
npm run build
# Output goes to dist/ — deploy to Vercel, Netlify, or any static host
```

Note: Your `VITE_KIT_KEY` is bundled into the frontend. This is fine for a
testnet demo. Before going to mainnet, consider using Circle's server-side
wallets so the key stays on a backend.
