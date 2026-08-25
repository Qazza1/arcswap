/**
 * ArcFX Shared Header
 * ───────────────────────────────────────────────────────────────────────────
 * Single source of truth for the universal stats bar, nav, and contacts modal
 * shipped on every ArcFX page. Edit this file once → every page updates.
 *
 * Usage in any HTML page:
 *   <div id="arcfx-stats-bar"></div>
 *   <div id="arcfx-nav"></div>
 *   <script type="module" src="/src/shared/header.ts"></script>
 *   <script>
 *     arcfxMountHeader({ pageKey: 'pricing', activeLink: 'pricing' });
 *   </script>
 *
 * Page configurations:
 *   pageKey     — unique identifier for this page's nav IDs (e.g. 'pricing')
 *   activeLink  — which top-level link to highlight: 'trade' | 'tools' |
 *                 'analytics' | 'pricing' | 'ecosystem' | 'security' | null
 *   activeTool  — if activeLink is 'tools', which tool to highlight in
 *                 the dropdown: 'multisend' | 'pay' | 'invoice' | 'history'
 *                 | 'docs' | null
 *
 * Adding a nav link: edit `TOP_LEVEL_LINKS` below.
 * Adding a tool: edit `TOOLS` below.
 * Changing stats bar items: edit `STATS_BAR_ITEMS` below.
 * ───────────────────────────────────────────────────────────────────────────
 */

// Importing the shared session here is deliberate: every page mounts this
// header, so this single import is what gives all of them silent wallet
// restore, a working Connect button and chain guarding — without each page
// re-implementing it and drifting out of sync.
import { arcfxWallet } from './wallet';

// Design tokens for both registers (app + client-facing document). Imported
// here because every page mounts this header, so the token layer arrives
// everywhere from one place. Vite bundles it into the page's CSS.
import './tokens.css';
import { arcfxMark } from './brand';

export type PageKey =
  | 'index' | 'app' | 'trade' | 'multisend' | 'pay' | 'invoice' | 'invoices' | 'history'
  | 'analytics' | 'docs' | 'docs-api' | 'developers' | 'pricing' | 'ecosystem' | 'security'
  | 'agent';

export type ActiveLink =
  | 'trade' | 'tools' | 'analytics' | 'history' | 'pricing' | 'ecosystem' | 'security'
  | 'use-cases' | 'docs' | 'developers' | null;

export type ActiveTool =
  | 'multisend' | 'pay' | 'invoice' | 'invoices' | 'history' | 'docs' | 'agent' | null;

export type Mode = 'product' | 'marketing';

interface MountConfig {
  pageKey: PageKey;
  activeLink?: ActiveLink;
  activeTool?: ActiveTool;
  mode?: Mode;
}

// ── Stats bar items ────────────────────────────────────────────────────────
// PRODUCT mode: leads with environment status, has pulsing dot
const PRODUCT_STATS_BAR_ITEMS: Array<{ label: string; value: string; dot?: boolean; valueColor?: string }> = [
  { label: 'Arc Testnet', value: 'Live',         dot: true },
  { label: 'Settlement',  value: '&lt; 1 second', valueColor: '#00d4aa' },
  { label: 'Gas token',   value: 'USDC' },
  { label: 'Avg fee',     value: '$0.0002',       valueColor: '#00d4aa' },
  { label: 'Arc raised',  value: '$222M at $3B' },
  { label: 'Tools',       value: '7 live' },
];

// MARKETING mode: leads with business trust facts, testnet status moved to end (no dot)
const MARKETING_STATS_BAR_ITEMS: Array<{ label: string; value: string; dot?: boolean; valueColor?: string }> = [
  { label: 'Built on Arc', value: 'a16z &amp; BlackRock backed' },
  { label: 'Settlement',       value: '&lt; 1 second', valueColor: '#00d4aa' },
  { label: 'Avg fee',          value: '$0.0002',       valueColor: '#00d4aa' },
  { label: 'Gas token',        value: 'USDC' },
  { label: 'Tools',            value: '7 live' },
  { label: 'Arc Testnet',      value: 'Live' },
];

// ── PRODUCT nav links (default — used on app pages) ─────────────────────────
const TOP_LEVEL_LINKS: Array<{ href: string; label: string; key: ActiveLink }> = [
  { href: '/app',         label: 'Trade',     key: 'trade' },
  // 'tools' is special — rendered as a dropdown button, not a plain link
  { href: '/analytics',   label: 'Analytics', key: 'analytics' },
  { href: '/history',     label: 'History',   key: 'history' },
  { href: '/docs',        label: 'Docs',      key: 'docs' },
  { href: '/developers',  label: 'Developers', key: 'developers' },
  { href: '/pricing',     label: 'Pricing',   key: 'pricing' },
  { href: '/ecosystem',   label: 'Ecosystem', key: 'ecosystem' },
  { href: '/security',    label: 'Security',  key: 'security' },
];

// ── Info pages, shown in the product nav's "More" dropdown ─────────────────
const MORE_LINKS: Array<{ href: string; label: string; key: ActiveLink }> = [
  { href: '/pricing',   label: 'Pricing',   key: 'pricing' },
  { href: '/ecosystem', label: 'Ecosystem', key: 'ecosystem' },
  { href: '/security',  label: 'Security',  key: 'security' },
];

// ── MARKETING nav links (used on /, /pricing, /ecosystem, /docs, /security) ──
const MARKETING_NAV_LINKS: Array<{ href: string; label: string; key: ActiveLink }> = [
  { href: '/#use-cases',  label: 'Use cases', key: 'use-cases' },
  { href: '/pricing',     label: 'Pricing',   key: 'pricing' },
  { href: '/docs',        label: 'Docs',      key: 'docs' },
  { href: '/developers',  label: 'Developers', key: 'developers' },
  { href: '/ecosystem',   label: 'Ecosystem', key: 'ecosystem' },
  { href: '/security',    label: 'Security',  key: 'security' },
];

// ── Single source of truth: tools dropdown items ───────────────────────────
const TOOLS: Array<{ href: string; key: ActiveTool; name: string; sub: string; svg: string }> = [
  {
    href: '/multisend', key: 'multisend',
    name: 'Multisender', sub: 'Batch transfers',
    svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  },
  {
    href: '/pay', key: 'pay',
    name: 'Pay Links', sub: 'Accept payments',
    svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
  },
  {
    href: '/invoice', key: 'invoice',
    name: 'Invoices', sub: 'PDF invoices + Pay Now',
    svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>',
  },
  {
    href: '/invoices', key: 'invoices',
    name: 'Invoice list', sub: 'Track what you are owed',
    svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  },
  {
    href: '/agent', key: 'agent',
    name: 'Agent Payments', sub: 'Pay an invoice over x402',
    svg: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
  },
];

// ── CSS injected once into <head> if not already present ───────────────────
const CANONICAL_CSS = `
  .stats-bar { background:#08090f; border-bottom:1px solid #1e293b; height:36px; display:flex; align-items:center; }
  .stats-bar-inner { display:flex; align-items:center; justify-content:center; gap:0; width:100%; padding:0 24px; }
  .stats-bar-item { display:flex; align-items:center; gap:7px; white-space:nowrap; flex-shrink:0; }
  .stats-bar-dot { width:5px; height:5px; border-radius:50%; background:#00d4aa; box-shadow:0 0 5px #00d4aa; animation:arcfx-pulse 2s ease-in-out infinite; }
  .stats-bar-label { font-family:"JetBrains Mono",monospace; font-size:11px; color:#475569; }
  .stats-bar-val { font-family:"JetBrains Mono",monospace; font-size:11px; font-weight:500; color:#e2e8f0; }
  .stats-bar-sep { width:1px; height:14px; background:#1e293b; margin:0 20px; flex-shrink:0; }
  @keyframes arcfx-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  /* ── Mobile (≤768px) ── */
  @media (max-width: 768px) {
    /* Stats bar: scroll horizontally instead of overflowing the viewport */
    .stats-bar-inner { justify-content: flex-start; overflow-x: auto; padding: 0 16px; scrollbar-width: none; -ms-overflow-style: none; -webkit-overflow-scrolling: touch; }
    .stats-bar-inner::-webkit-scrollbar { display: none; }
    .stats-bar-sep { margin: 0 14px; }

    /* Nav: hide center links on mobile, show the hamburger instead.
       Marketing → Logo + Launch/Back-to-app.  Product → Logo + hamburger + Connect. */
    .arcfx-nav { padding: 0 16px !important; }
    .arcfx-nav-center { display: none !important; }
    .arcfx-hamburger { display: flex !important; }

    /* Logo + hamburger + Connect together overflowed a 375px viewport by ~55px,
       which made every page scroll sideways on a phone. The buttons have fixed
       padding and will not shrink on their own, so tighten them and let the
       address truncate rather than push the nav past the screen edge. */
    #connect-btn {
      padding: 6px 10px !important;
      font-size: 12px !important;
      max-width: 132px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The network pill is decorative next to the address; the stats bar already
       says "Arc Testnet · Live". Dropping it reclaims the width the nav needs. */
    .arcfx-testnet-pill { display: none !important; }
  }

  /* Very narrow phones. */
  @media (max-width: 400px) {
    #connect-btn { max-width: 112px; }
  }

  /* ── Nav hover, in CSS rather than inline JS ──────────────────────────────
     These states used to be set by onmouseover handlers writing a literal
     '#1e293b'. A stylesheet cannot reliably override a value JS writes into the
     style attribute, which is why every tab still went dark blue on a light
     page. As real rules they follow the tokens, and six inline handlers go
     away with them. */
  .arcfx-navlink { color: #94a3b8; }
  .arcfx-navlink:hover { color: var(--fx-ink); background: var(--fx-sunken); }
  .arcfx-dditem:hover { background: var(--fx-sunken); }
  .arcfx-mobilelink:hover { background: var(--fx-sunken); color: var(--fx-ink); }
  #arcfx-contacts-btn:hover, [id^="arcfx-contacts-btn"]:hover { border-color: var(--fx-accent) !important; color: var(--fx-ink) !important; }
  #connect-btn:hover { border-color: var(--fx-accent); }

  /* The nav's primary call to action. This was an inline style plus an
     onmouseover/onmouseout pair writing a dark blue straight onto the element —
     which is both why it ignored the register and why script-src still needed
     'unsafe-inline'. As a class it does neither. */
  .arcfx-cta {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 18px; border-radius: 7px;
    background: var(--fx-accent); color: var(--fx-on-accent);
    font-size: 13.5px; font-weight: 600; text-decoration: none;
    transition: opacity .15s;
  }
  .arcfx-cta:hover { opacity: .86; }

  [data-register] .arcfx-navlink { color: var(--fx-muted); }
  [data-register] .arcfx-navlink:hover { color: var(--fx-ink); background: var(--fx-sunken); }
  [data-register] .arcfx-dditem:hover { background: var(--fx-sunken); }
  [data-register] .arcfx-mobilelink:hover { background: var(--fx-sunken); color: var(--fx-ink); }
  [data-register] [id^="arcfx-contacts-btn"]:hover { border-color: var(--fx-ink) !important; color: var(--fx-ink) !important; }
  [data-register] #connect-btn:hover { border-color: var(--fx-ink) !important; }

  /* ═══ App register ═══════════════════════════════════════════════════════
     A page opts in with data-register on <html> — either register. The nav and
     stats bar are app chrome and stay light in both. The nav and stats bar are
     built from inline styles, so they are overridden here rather than
     rewritten — which means pages that have not been converted yet keep the
     dark chrome and nothing changes for them until they opt in.
     Remove this block once every page has been converted. */
  [data-register] .arcfx-nav {
    background: var(--fx-bg) !important;
    border-bottom: 1px solid var(--fx-line) !important;
    backdrop-filter: none !important;
  }
  /* Anything that paints its own background is excluded: the marketing CTA is
     a filled button with white text, and repainting it muted left grey on blue
     at 1:1. A blanket rule over every anchor is too blunt for a nav that mixes
     plain links with a solid button. */
  [data-register] .arcfx-nav a:not([style*="background:#"]),
  [data-register] .arcfx-nav button:not([style*="background:#"]) { color: var(--fx-muted) !important; }
  [data-register] .arcfx-nav a:not([style*="background:#"]) span { color: var(--fx-ink) !important; }
  [data-register] .arcfx-nav a:not([style*="background:#"]):hover,
  [data-register] .arcfx-nav button:not([style*="background:#"]):hover { color: var(--fx-ink) !important; }
  /* The mark is stroke-based and inherits colour, so it needs ink rather than
     a border to sit correctly on a light ground. */
  [data-register] .arcfx-nav > a { color: var(--fx-ink) !important; }
  [data-register] .arcfx-wordmark { color: var(--fx-ink) !important; }

  [data-register] .arcfx-testnet-pill {
    background: var(--fx-surface) !important;
    border-color: var(--fx-line) !important;
  }
  /* Every chip in the nav, not just Connect: the Contacts and hamburger buttons
     keep their own dark background otherwise, leaving grey text on a dark chip
     at 3.8:1. */
  [data-register] #connect-btn,
  [data-register] .arcfx-nav button[id^="arcfx-contacts-btn"],
  [data-register] .arcfx-hamburger {
    background: var(--fx-surface) !important;
    border-color: var(--fx-line) !important;
    color: var(--fx-ink) !important;
  }
  [data-register] .arcfx-hamburger svg { stroke: var(--fx-ink) !important; }

  [data-register] .stats-bar {
    background: var(--fx-surface) !important;
    border-bottom: 1px solid var(--fx-line) !important;
  }
  /* --fx-muted, not --fx-faint: these labels are 11px, and faint on the raised
     surface measures 2.4:1, well under the 4.5:1 that small text needs. */
  [data-register] .stats-bar-label { color: var(--fx-muted) !important; }
  [data-register] .stats-bar-val   { color: var(--fx-muted) !important; }
  [data-register] .stats-bar-sep   { background: var(--fx-line) !important; }

  /* Dropdowns and the contacts modal are dark panels in the legacy chrome. */
  [data-register] .arcfx-nav div[id^="arcfx-tools-dd"],
  [data-register] .arcfx-nav div[id^="arcfx-more-dd"],
  [data-register] div[id^="arcfx-mobile-menu"],
  [data-register] #arcfx-contacts-inner {
    background: var(--fx-surface) !important;
    border-color: var(--fx-line) !important;
    box-shadow: 0 16px 40px rgba(0,0,0,.10) !important;
  }
  [data-register] div[id^="arcfx-tools-dd"] a,
  [data-register] div[id^="arcfx-more-dd"] a,
  [data-register] div[id^="arcfx-mobile-menu"] a { color: var(--fx-ink) !important; }
  /* Active state paints a dark chip inline — on links AND on the Tools/More
     dropdown buttons. Targeting the exact inline value is what distinguishes
     an active chip from the transparent inactive ones, so the active state
     survives instead of being flattened away. */
  [data-register] .arcfx-nav [style*="background:#1e293b"],
  [data-register] .arcfx-nav [style*="background: #1e293b"],
  [data-register] div[id^="arcfx-mobile-menu"] [style*="background:#1e293b"] {
    background: var(--fx-sunken) !important;
    color: var(--fx-ink) !important;
  }
  [data-register] div[id^="arcfx-tools-dd"] a div,
  [data-register] div[id^="arcfx-more-dd"] a div { color: var(--fx-muted) !important; }
  [data-register] #arcfx-contacts-inner,
  [data-register] #arcfx-contacts-inner * { color: var(--fx-ink); }
  [data-register] #arcfx-contact-name,
  [data-register] #arcfx-contact-addr {
    background: var(--fx-bg) !important;
    border-color: var(--fx-line) !important;
    color: var(--fx-ink) !important;
  }
  /* Hamburger is desktop-hidden; the media query above reveals it ≤768px. */
  .arcfx-hamburger { display: none; }
`;

// The typefaces the token layer names. Loaded once, from here, so a page never
// has to remember which families its register needs.
const TOKEN_FONTS =
  'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700' +
  '&family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600' +
  '&family=Karla:wght@400;500;600' +
  '&family=JetBrains+Mono:wght@400;500' +
  '&display=swap';

function ensureCss(): void {
  if (!document.getElementById('arcfx-token-fonts')) {
    const link = document.createElement('link');
    link.id = 'arcfx-token-fonts';
    link.rel = 'stylesheet';
    link.href = TOKEN_FONTS;
    document.head.appendChild(link);
  }
  if (document.getElementById('arcfx-shared-css')) return;
  const style = document.createElement('style');
  style.id = 'arcfx-shared-css';
  style.textContent = CANONICAL_CSS;
  document.head.appendChild(style);
}

// ── Stats bar HTML builder ─────────────────────────────────────────────────
function buildStatsBar(mode: Mode): string {
  const items = mode === 'marketing' ? MARKETING_STATS_BAR_ITEMS : PRODUCT_STATS_BAR_ITEMS;
  const cells = items.map((item, i) => {
    const dot = item.dot ? '<span class="stats-bar-dot"></span>' : '';
    const valStyle = item.valueColor ? ` style="color:${item.valueColor}"` : '';
    const sep = i < items.length - 1 ? '<div class="stats-bar-sep"></div>' : '';
    return `<div class="stats-bar-item">${dot}<span class="stats-bar-label">${item.label}</span><span class="stats-bar-val"${valStyle}>${item.value}</span></div>${sep}`;
  }).join('');
  return `<div class="stats-bar"><div class="stats-bar-inner">${cells}</div></div>`;
}

// ── Nav link builder ───────────────────────────────────────────────────────
function buildLink(href: string, label: string, isActive: boolean): string {
  if (isActive) {
    return `<a href="${href}" style="padding:6px 14px;border-radius:6px;font-size:13.5px;font-weight:500;text-decoration:none;transition:all .15s;color:var(--fx-ink);background:#1e293b;">${label}</a>`;
  }
  return `<a href="${href}" class="arcfx-navlink" style="padding:6px 14px;border-radius:6px;font-size:13.5px;font-weight:500;text-decoration:none;transition:all .15s;">${label}</a>`;
}

function buildDropdownItem(href: string, name: string, sub: string, svg: string, isActive: boolean): string {
  const bg = isActive ? '#1e293b' : 'transparent';
  const hoverOut = isActive ? '#1e293b' : 'transparent';
  return `<a href="${href}" class="arcfx-dditem" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:6px;text-decoration:none;background:${bg};transition:background .15s;">${svg}<div><div style="font-size:13px;font-weight:600;color:var(--fx-ink);">${name}</div><div style="font-size:11px;color:#64748b;margin-top:1px;">${sub}</div></div></a>`;
}

// ── Nav HTML builder (dispatches by mode) ──────────────────────────────────
function buildNav(pageKey: PageKey, activeLink: ActiveLink, activeTool: ActiveTool, mode: Mode): string {
  if (mode === 'marketing') {
    return buildMarketingNav(activeLink);
  }
  return buildProductNav(pageKey, activeLink, activeTool);
}

function buildMarketingNav(activeLink: ActiveLink): string {
  const links = MARKETING_NAV_LINKS
    .map(l => buildLink(l.href, l.label, l.key === activeLink))
    .join('');

  // Returning users (who've connected a wallet on a product page before) see
  // "Back to app"; first-time visitors see the conversion-focused "Launch ArcFX".
  // Both link to /app — only the label differs. The flag is written in
  // product mode when a connected wallet is detected (see wireBehavior).
  let isReturning = false;
  try {
    isReturning = localStorage.getItem('arcfx_returning') === '1';
  } catch (e) { /* localStorage unavailable (private mode / blocked) */ }
  const ctaLabel = isReturning ? 'Back to app' : 'Launch ArcFX';

  return `
<nav class="arcfx-nav" style="position:sticky;top:0;z-index:50;height:64px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 24px;background:rgba(2,6,23,0.97);border-bottom:1px solid #1e293b;backdrop-filter:blur(12px);">
  <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0;">
    ${arcfxMark(26)}
    <span class="arcfx-wordmark" style="font-family:Archivo,ui-sans-serif,system-ui,sans-serif;font-size:16px;font-weight:700;color:var(--fx-ink);letter-spacing:-0.02em;">ArcFX</span>
  </a>
  <div class="arcfx-nav-center" style="display:flex;align-items:center;gap:2px;">
    ${links}
  </div>
  <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">
    <a href="/app" class="arcfx-cta">${ctaLabel} <span style="font-size:14px;">&rarr;</span></a>
  </div>
</nav>
`;
}

function buildProductNav(pageKey: PageKey, activeLink: ActiveLink, activeTool: ActiveTool): string {
  const isToolsActive = activeLink === 'tools';
  const toolsBtnColor = isToolsActive ? '#f1f5f9' : '#94a3b8';
  const toolsBtnBg    = isToolsActive ? '#1e293b' : 'transparent';

  const dropdownItems = TOOLS.map(t =>
    buildDropdownItem(t.href, t.name, t.sub, t.svg, t.key === activeTool)
  ).join('');

  // Top-level app links — one clean group (Trade is built separately above the
  // Tools dropdown). Pricing/Ecosystem/Security are marketing pages and are
  // intentionally NOT in the app nav.
  const tradeLink = buildLink('/trade', 'Trade', activeLink === 'trade');
  const productLinks = TOP_LEVEL_LINKS
    .filter(l => l.key === 'analytics' || l.key === 'history' || l.key === 'docs' || l.key === 'developers')
    .map(l => buildLink(l.href, l.label, l.key === activeLink))
    .join('');

  // "More" dropdown — info pages (Pricing/Ecosystem/Security), reachable from
  // anywhere in the app but tucked away to keep the nav clean.
  const moreActive   = activeLink === 'pricing' || activeLink === 'ecosystem' || activeLink === 'security';
  const moreBtnColor = moreActive ? '#f1f5f9' : '#94a3b8';
  const moreBtnBg    = moreActive ? '#1e293b' : 'transparent';
  const moreItems = MORE_LINKS.map(l => {
    const active = l.key === activeLink;
    const bg  = active ? '#1e293b' : 'transparent';
    const col = active ? '#f1f5f9' : '#94a3b8';
    return `<a href="${l.href}" class="arcfx-mobilelink" style="display:block;padding:9px 12px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;color:${col};background:${bg};transition:all .15s;">${l.label}</a>`;
  }).join('');

  // ── Mobile menu (≤768px): a flat list of every destination, since the
  // center nav (Trade / Tools / Analytics / History / Docs / More) is hidden. ──
  const mobileLinkStyle = (active: boolean) => {
    const bg  = active ? '#1e293b' : 'transparent';
    const col = active ? '#f1f5f9' : '#cbd5e1';
    return `display:block;padding:13px 16px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:500;color:${col};background:${bg};`;
  };
  const mobileSectionLabel = (t: string) =>
    `<div style="padding:14px 16px 6px;font-size:10px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#475569;font-family:'JetBrains Mono',monospace;">${t}</div>`;

  const mobileMenuItems = [
    `<a href="/trade" style="${mobileLinkStyle(activeLink === 'trade')}">Trade</a>`,
    mobileSectionLabel('Tools'),
    ...TOOLS.map(t => `<a href="${t.href}" style="${mobileLinkStyle(activeTool === t.key)}">${t.name}</a>`),
    mobileSectionLabel('More'),
    ...TOP_LEVEL_LINKS
      .filter(l => l.key === 'analytics' || l.key === 'history' || l.key === 'docs' || l.key === 'developers')
      .map(l => `<a href="${l.href}" style="${mobileLinkStyle(l.key === activeLink)}">${l.label}</a>`),
    ...MORE_LINKS.map(l => `<a href="${l.href}" style="${mobileLinkStyle(l.key === activeLink)}">${l.label}</a>`),
  ].join('');

  return `
<nav class="arcfx-nav" style="position:sticky;top:0;z-index:50;height:64px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 24px;background:rgba(2,6,23,0.97);border-bottom:1px solid #1e293b;">
  <a href="/app" style="display:flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0;">
    ${arcfxMark(26)}
    <span class="arcfx-wordmark" style="font-family:Archivo,ui-sans-serif,system-ui,sans-serif;font-size:16px;font-weight:700;color:var(--fx-ink);letter-spacing:-0.02em;">ArcFX</span>
  </a>
  <div class="arcfx-nav-center" style="display:flex;align-items:center;gap:2px;">
    ${tradeLink}
    <div style="position:relative;" id="arcfx-tools-wrap-${pageKey}">
      <button id="arcfx-tools-btn-${pageKey}" style="display:flex;align-items:center;gap:5px;padding:6px 14px;border-radius:6px;font-size:13.5px;font-weight:500;border:0;outline:none;cursor:pointer;font-family:inherit;transition:all .15s;color:${toolsBtnColor};background:${toolsBtnBg};-webkit-appearance:none;">Tools <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
      <div id="arcfx-tools-dd-${pageKey}" style="display:none;position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);width:220px;background:#0f172a;border:1px solid var(--fx-line);border-radius:10px;padding:6px;box-shadow:0 20px 40px rgba(0,0,0,.6);z-index:100;">
        ${dropdownItems}
      </div>
    </div>
    ${productLinks}
    <div style="position:relative;" id="arcfx-more-wrap-${pageKey}">
      <button id="arcfx-more-btn-${pageKey}" style="display:flex;align-items:center;gap:5px;padding:6px 14px;border-radius:6px;font-size:13.5px;font-weight:500;border:0;outline:none;cursor:pointer;font-family:inherit;transition:all .15s;color:${moreBtnColor};background:${moreBtnBg};-webkit-appearance:none;">More <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
      <div id="arcfx-more-dd-${pageKey}" style="display:none;position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);width:160px;background:#0f172a;border:1px solid var(--fx-line);border-radius:10px;padding:6px;box-shadow:0 20px 40px rgba(0,0,0,.6);z-index:100;">
        ${moreItems}
      </div>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">
    <div class="arcfx-testnet-pill" style="display:flex;align-items:center;gap:6px;padding:4px 12px;border-radius:9999px;border:1px solid var(--fx-line);background:#0f172a;">
      <span style="width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 6px rgba(16,185,129,0.7);animation:arcfx-pulse 2s ease-in-out infinite;display:inline-block;"></span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;color:#64748b;">Testnet</span>
    </div>
    <button id="arcfx-contacts-btn-${pageKey}" style="display:flex;align-items:center;gap:5px;padding:7px 12px;border-radius:6px;border:1px solid var(--fx-line);background:#0f172a;color:#475569;font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>Contacts</button>
    <button id="connect-btn" style="padding:7px 16px;border-radius:6px;border:1px solid var(--fx-line);background:#0f172a;color:#94a3b8;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;">Connect wallet</button>
    <button class="arcfx-hamburger" id="arcfx-hamburger-${pageKey}" aria-label="Menu" style="align-items:center;justify-content:center;width:38px;height:38px;border-radius:8px;border:1px solid var(--fx-line);background:#0f172a;color:#cbd5e1;cursor:pointer;flex-shrink:0;padding:0;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
  <div id="arcfx-mobile-menu-${pageKey}" style="display:none;position:absolute;top:64px;left:0;right:0;background:#0a0f1e;border-bottom:1px solid #1e293b;padding:10px 12px 16px;z-index:90;box-shadow:0 20px 40px rgba(0,0,0,.5);">
    ${mobileMenuItems}
  </div>
</nav>
`;
}

// ── Contacts modal HTML (shared singleton — only mounted once) ─────────────
const CONTACTS_MODAL_HTML = `
<div id="arcfx-contacts-modal" style="display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);align-items:center;justify-content:center;">
  <div style="background:#0f172a;border:1px solid var(--fx-line);border-radius:12px;width:480px;max-width:calc(100vw - 32px);max-height:80vh;display:flex;flex-direction:column;" id="arcfx-contacts-inner">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #1e293b;">
      <div>
        <div style="font-size:15px;font-weight:600;color:var(--fx-ink);">Address Book</div>
        <div style="font-size:11px;color:#475569;margin-top:2px;">Synced across all pages</div>
      </div>
      <button id="arcfx-contacts-close" style="background:transparent;border:none;color:#475569;cursor:pointer;font-size:20px;padding:4px;">&times;</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:12px 20px;" id="arcfx-contacts-list"></div>
    <div style="padding:14px 20px;border-top:1px solid #1e293b;">
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;">
        <input id="arcfx-contact-name" type="text" placeholder="Contact name" style="background:var(--fx-sunken);border:1px solid var(--fx-line);border-radius:6px;color:var(--fx-ink);font-size:13px;font-family:inherit;padding:8px 11px;outline:none;" />
        <input id="arcfx-contact-addr" type="text" placeholder="0x..." style="background:var(--fx-sunken);border:1px solid var(--fx-line);border-radius:6px;color:var(--fx-ink);font-size:12px;font-family:'JetBrains Mono',monospace;padding:8px 11px;outline:none;" />
        <button id="arcfx-contact-save" style="padding:8px 14px;background:var(--fx-accent);color:var(--fx-on-accent);border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">+ Save</button>
      </div>
    </div>
  </div>
</div>
`;

// ── Behavior wiring ────────────────────────────────────────────────────────
function wireBehavior(pageKey: PageKey, mode: Mode): void {
  // Marketing mode has none of these elements — bail early.
  if (mode === 'marketing') return;

  // Mobile hamburger menu toggle
  const hamburger  = document.getElementById(`arcfx-hamburger-${pageKey}`);
  const mobileMenu = document.getElementById(`arcfx-mobile-menu-${pageKey}`);
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', (e) => {
      e.stopPropagation();
      mobileMenu.style.display = mobileMenu.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', (e) => {
      if (!mobileMenu.contains(e.target as Node) && !hamburger.contains(e.target as Node)) {
        mobileMenu.style.display = 'none';
      }
    });
  }

  // Tools dropdown toggle
  const toolsBtn = document.getElementById(`arcfx-tools-btn-${pageKey}`);
  const toolsDd  = document.getElementById(`arcfx-tools-dd-${pageKey}`);
  const toolsWrap = document.getElementById(`arcfx-tools-wrap-${pageKey}`);
  if (toolsBtn && toolsDd && toolsWrap) {
    toolsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toolsDd.style.display = toolsDd.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', (e) => {
      if (!toolsWrap.contains(e.target as Node)) toolsDd.style.display = 'none';
    });
  }

  // More dropdown toggle (info pages)
  const moreBtn  = document.getElementById(`arcfx-more-btn-${pageKey}`);
  const moreDd   = document.getElementById(`arcfx-more-dd-${pageKey}`);
  const moreWrap = document.getElementById(`arcfx-more-wrap-${pageKey}`);
  if (moreBtn && moreDd && moreWrap) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreDd.style.display = moreDd.style.display === 'block' ? 'none' : 'block';
    });
    document.addEventListener('click', (e) => {
      if (!moreWrap.contains(e.target as Node)) moreDd.style.display = 'none';
    });
  }

  // Contacts modal
  const contactsBtn   = document.getElementById(`arcfx-contacts-btn-${pageKey}`);
  const modal         = document.getElementById('arcfx-contacts-modal');
  const closeBtn      = document.getElementById('arcfx-contacts-close');
  const modalInner    = document.getElementById('arcfx-contacts-inner');

  const openModal = () => { if (modal) { modal.style.display = 'flex'; renderContacts(); } };
  const closeModal = () => { if (modal) modal.style.display = 'none'; };

  if (contactsBtn) contactsBtn.addEventListener('click', openModal);
  if (closeBtn)    closeBtn.addEventListener('click', closeModal);
  if (modal)       modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  if (modalInner)  modalInner.addEventListener('click', (e) => e.stopPropagation());

  const saveBtn = document.getElementById('arcfx-contact-save');
  if (saveBtn) saveBtn.addEventListener('click', saveContact);

  // Connect wallet button. The shared session (src/shared/wallet.ts) owns
  // prompting, the Arc chain switch, silent restore and painting this button —
  // importing it above is what gives every page a session that survives
  // navigation. A page that defines its own window.connectWallet still wins,
  // so pages with bespoke flows (pay, trade) keep control.
  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) {
    connectBtn.addEventListener('click', () => {
      const fn = (window as any).connectWallet;
      if (typeof fn === 'function') { fn(); return; }
      arcfxWallet.connect().catch(() => { /* dismissed */ });
    });
  }

  // The marketing nav reads this to show "Back to app" instead of "Launch
  // ArcFX" for people who have connected before.
  arcfxWallet.onChange((s) => {
    if (s.connected) {
      try { localStorage.setItem('arcfx_returning', '1'); } catch (e) { /* storage blocked */ }
    }
  });
}

// ── Contacts rendering (uses existing arcfx_address_book localStorage) ─────
function renderContacts(): void {
  const list = document.getElementById('arcfx-contacts-list');
  if (!list) return;
  const entries: Array<{ name: string; address: string }> =
    JSON.parse(localStorage.getItem('arcfx_address_book') || '[]');
  if (!entries.length) {
    list.innerHTML = "<div style='text-align:center;padding:24px;color:#475569;font-size:13px;'>No contacts yet.</div>";
    return;
  }
  // Contact names are user-supplied. Interpolating them into innerHTML let a
  // crafted name inject markup — self-scoped while contacts live only in this
  // browser's localStorage, but a real hole the moment contacts are imported,
  // shared or synced. Built from DOM nodes with textContent instead, so the
  // name can never be parsed as markup.
  list.replaceChildren(...entries.map((c, i) => {
    const row = document.createElement('div');
    row.setAttribute('style', 'display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:7px;background:#0a0f1e;border:1px solid var(--fx-line);margin-bottom:8px;');

    const avatar = document.createElement('div');
    avatar.setAttribute('style', 'width:32px;height:32px;border-radius:50%;background:var(--fx-sunken);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--fx-ink);flex-shrink:0;');
    avatar.textContent = (c.name || '?').charAt(0).toUpperCase();

    const middle = document.createElement('div');
    middle.setAttribute('style', 'flex:1;min-width:0;');
    const name = document.createElement('div');
    name.setAttribute('style', 'font-size:13px;font-weight:600;color:var(--fx-ink);');
    name.textContent = c.name || '';
    const addr = document.createElement('div');
    addr.setAttribute('style', 'font-size:11px;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
    addr.textContent = c.address || '';
    middle.append(name, addr);

    const copy = document.createElement('button');
    copy.className = 'arcfx-copy-btn';
    copy.dataset.idx = String(i);
    copy.setAttribute('style', 'background:transparent;border:1px solid var(--fx-line);border-radius:5px;color:#475569;font-size:11px;padding:4px 9px;cursor:pointer;');
    copy.textContent = 'Copy';

    row.append(avatar, middle, copy);
    return row;
  }));
  list.querySelectorAll<HTMLButtonElement>('.arcfx-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx || '0', 10);
      const e = entries[idx];
      if (e) navigator.clipboard.writeText(e.address).then(() => {
        const original = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.textContent = original || 'Copy'; }, 1500);
      }).catch(() => {});
    });
  });
}

function saveContact(): void {
  const nameEl = document.getElementById('arcfx-contact-name') as HTMLInputElement | null;
  const addrEl = document.getElementById('arcfx-contact-addr') as HTMLInputElement | null;
  if (!nameEl || !addrEl) return;
  const name = nameEl.value.trim();
  const addr = addrEl.value.trim();
  if (!name || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
  const entries: Array<{ name: string; address: string }> =
    JSON.parse(localStorage.getItem('arcfx_address_book') || '[]');
  if (!entries.some(x => x.address.toLowerCase() === addr.toLowerCase())) {
    entries.push({ name, address: addr });
    localStorage.setItem('arcfx_address_book', JSON.stringify(entries));
  }
  nameEl.value = '';
  addrEl.value = '';
  renderContacts();
}

// ── Public mount function ──────────────────────────────────────────────────
export function arcfxMountHeader(config: MountConfig): void {
  const { pageKey, activeLink = null, activeTool = null, mode = 'product' } = config;

  ensureCss();

  // Stats bar — marketing only.
  //
  // Inside the app it was a permanent ticker of six facts that never change,
  // occupying 36px of the most valuable space on every screen. "Arc raised
  // $222M" is an argument for choosing ArcFX, which belongs where people are
  // deciding, not where they are working. Live status still shows: the network
  // pill and the wallet chip are both in the nav.
  const statsBarMount = document.getElementById('arcfx-stats-bar');
  if (statsBarMount) {
    if (mode === 'marketing') {
      statsBarMount.innerHTML = buildStatsBar(mode);
    } else {
      statsBarMount.innerHTML = '';
      statsBarMount.style.display = 'none';
    }
  }

  // Nav
  const navMount = document.getElementById('arcfx-nav');
  if (navMount) navMount.innerHTML = buildNav(pageKey, activeLink, activeTool, mode);

  // Contacts modal — only mounted in product mode, and only once even if
  // mountHeader is called multiple times.
  if (mode === 'product' && !document.getElementById('arcfx-contacts-modal')) {
    const modalDiv = document.createElement('div');
    modalDiv.innerHTML = CONTACTS_MODAL_HTML.trim();
    const modalEl = modalDiv.firstElementChild;
    const target = document.body || document.documentElement;
    if (modalEl && target) {
      target.appendChild(modalEl);
    }
  }

  // Wire behavior
  wireBehavior(pageKey, mode);
}

// Expose globally so plain (non-module) scripts can call it
(window as any).arcfxMountHeader = arcfxMountHeader;
