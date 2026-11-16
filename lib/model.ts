// Token radar value model, board builder, farm plans and dashboard data.
//
// Written fresh for token-radar-01. Node 22 standard library only, no network,
// fully deterministic: the same snapshot bytes always produce the same board.
//
// The model, in one line:
//   implied_value_usd = tvl_usd x M x growth x age
// where M is the market's own multiple — the median market-cap-per-TVL of the
// snapshot's token-trading protocols — growth comes from the protocol's 7-day
// TVL change, and age from how long it has run with no token recorded.
// Nothing in it names a protocol: every figure is read off the snapshot.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/**
 * Tunable constants of the model. All are plain numbers, none is a name.
 * The growth and age coefficients (0.25, 0.8, 0.4, 365) are explicit design
 * assumptions, not estimated economic relationships: they shape how much a
 * week's relative momentum and a longer listing history move the value.
 */
export const MODEL = {
  /** Growth coefficient in G = exp(0.25 × clamp((g − g50) / spread, −1, 1)). */
  growthCoeff: 0.25,
  /** Age curve: A = 0.8 + 0.4 × age / (age + 365). */
  ageBase: 0.8,
  ageSpan: 0.4,
  ageHalf: 365,
} as const;

export const MODEL_VERSION = 'radar-2';

/** Distribution statistics the model reads off the snapshot at run time. */
export interface ModelStats {
  /** Median market-cap-per-TVL of live protocols with positive TVL and market cap. */
  multiple: number;
  /** Quartiles of that ratio, for dispersion context. */
  multipleQ25: number;
  multipleQ75: number;
  /** Number of live protocols the multiple is computed from. */
  liveCount: number;
  /** 10th, 50th, 90th percentiles of the snapshot's 7-day TVL changes (percentage points). */
  g10: number;
  g50: number;
  g90: number;
  /** g90 − g10, the spread the growth factor scales by (at least 1). */
  gSpread: number;
  /** Median known listed age among protocols with no token recorded (days). */
  medianAgeNoToken: number;
}

/** Linear-interpolation percentile of a non-empty list (0–100). */
export function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  if (sorted.length === 1) return sorted[0]!;
  const i = (sorted.length - 1) * (q / 100);
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const f = i - lo;
  return sorted[lo]! * (1 - f) + sorted[hi]! * f;
}

/** Derive every distribution statistic the model needs from the snapshot. */
export function computeStats(snapshot: Snapshot): ModelStats {
  const livePos = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const ratios = livePos.map((p) => p.mcap_usd! / p.tvl_usd);
  const changes = snapshot.protocols
    .map((p) => p.change_7d)
    .filter((x): x is number => x !== null);
  const noTokenAges = snapshot.protocols
    .filter((p) => isPreToken(p))
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((x): x is number => x !== null);
  const g10 = percentile(changes, 10);
  const g90 = percentile(changes, 90);
  return {
    multiple: median(ratios),
    multipleQ25: percentile(ratios, 25),
    multipleQ75: percentile(ratios, 75),
    liveCount: livePos.length,
    g10,
    g50: percentile(changes, 50),
    g90,
    gSpread: Math.max(g90 - g10, 1),
    medianAgeNoToken: median(noTokenAges),
  };
}

/** A row of the ranked board, as board.json carries it. */
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/** A row with everything the dashboard needs, including the model's working. */
export interface RadarRow extends BoardRow {
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  /** True when the age was imputed from the no-token median (listed_at missing). */
  age_imputed: boolean;
  status: 'pre-token' | 'token live';
  /** True when the protocol is on the snapshot's watchlist. */
  watchlist: boolean;
  /** Why the protocol is outside the watchlist (null when it is on it). */
  exclusion: string | null;
  growth_factor: number;
  age_factor: number;
  multiple: number;
  /** For live rows only: actual market cap divided by modelled value. */
  actual_over_modeled: number | null;
}

export interface RadarData {
  meta: {
    as_of: string;
    floor_usd: number;
    model: string;
    model_version: string;
    base_multiple: number;
    multiple_q25: number;
    multiple_q75: number;
    live_count: number;
    g50: number;
    g_spread: number;
    median_age_no_token: number;
    rows: number;
    watchlist_rows: number;
    other_rows: number;
    live_rows: number;
    /** Protocols that record a token but no usable market cap: not ranked. */
    unranked: number;
  };
  model_note: string;
  rows: RadarRow[];
}

export class SnapshotError extends Error {}

/** Days between two ISO dates (UTC), or null when the second is missing. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((a - b) / 86_400_000));
}

/** Median of a non-empty list of numbers. */
export function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface Implied {
  implied: number;
  growthPct: number;
  growthFactor: number;
  ageFactor: number;
  age: number | null;
  /** True when the age was imputed (listed_at missing) rather than read. */
  ageImputed: boolean;
}

/**
 * The implied value of one protocol, and the factors that produced it.
 *
 *   implied = round(TVL × M × G × A)
 *   G = exp(0.25 × clamp((g − g50) / spread, −1, 1))   (g = 7-day TVL change, pp)
 *   A = 0.8 + 0.4 × age / (age + 365)                    (age = listed age, days)
 *
 * Growth is measured relative to the snapshot's own median week (g50), so a
 * protocol that merely fell less than the field earns a premium and one noisy
 * week cannot dominate. A missing 7-day change takes the median (G = 1).
 * Age is a diminishing maturity premium that never plateaus after one year.
 * A missing listing date takes the median known age of no-token protocols,
 * and is flagged as imputed. Only the final value is rounded.
 */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  stats: ModelStats,
): Implied {
  const growthPct = p.change_7d ?? stats.g50;
  const rel = (growthPct - stats.g50) / stats.gSpread;
  const growthFactor = Math.exp(MODEL.growthCoeff * Math.min(1, Math.max(-1, rel)));
  const rawAge = ageDays(asOf, p.listed_at);
  const ageImputed = rawAge === null;
  const age = ageImputed ? stats.medianAgeNoToken : rawAge;
  const ageFactor = MODEL.ageBase + MODEL.ageSpan * (age / (age + MODEL.ageHalf));
  const implied = Math.max(1, Math.round(p.tvl_usd * stats.multiple * growthFactor * ageFactor));
  return { implied, growthPct, growthFactor, ageFactor, age, ageImputed };
}

/** True when the snapshot records no token for the protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** True when the protocol records a token that trades (a market cap is listed). */
export function isLive(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null;
}

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Why a protocol is outside the watchlist, in the watchlist rule's own terms
 * (RULES.txt, "The snapshot"). Null when nothing excludes it. A protocol can
 * fail on several counts; the product-type reason is reported first because
 * it says more than the floor does.
 */
export function watchlistExclusion(p: SnapshotProtocol, floorUsd: number): string | null {
  if (!isPreToken(p)) {
    return 'Records a token — the watchlist is pre-token only';
  }
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) {
    return `Category ${p.category} is excluded from the watchlist`;
  }
  const name = p.name;
  if (/\s(V2|v2|2\.0|3\.0|V3|v3)\s*$/.test(name) || /\sV\d+$/.test(name)) {
    return 'Name ends in a version marker';
  }
  if (/\b(wrapped|staked|staking)\b/i.test(name)) {
    return 'Name carries wrapped, staked or staking';
  }
  for (const ex of EXCHANGE_PREFIXES) {
    if (name.startsWith(ex)) return `Name begins with the exchange name ${ex}`;
  }
  if (p.tvl_usd < floorUsd) return `TVL below the $${Math.round(floorUsd / 1_000_000)}M watchlist floor`;
  // Nothing in the snapshot's ten fields excludes it: the watchlist rule also
  // checks DefiLlama's parent-protocol record, which the snapshot does not
  // carry, so the exclusion must come from there.
  return 'Excluded for a reason the snapshot does not carry (the watchlist rule also checks DefiLlama’s parent-protocol record)';
}

/** ---- Farm plans ---- */

/** Native token and typical cost of moving value onto a chain. */
const CHAIN_GUIDE: Record<string, { token: string; bridge: string; tx: string }> = {
  Ethereum: { token: 'ETH', bridge: 'no bridge needed, it is L1', tx: '~$2–$15 per transaction' },
  Base: { token: 'ETH', bridge: 'bridge from Ethereum mainnet for ~$2–$8, about 10 minutes', tx: '~$0.05–$0.50 per transaction' },
  Arbitrum: { token: 'ETH', bridge: 'bridge from Ethereum mainnet for ~$2–$8, about 10 minutes', tx: '~$0.05–$0.50 per transaction' },
  Solana: { token: 'SOL', bridge: 'bridge from Ethereum via Wormhole for ~$5–$15, about 10 minutes', tx: '~$0.01–$0.10 per transaction' },
  Binance: { token: 'BNB', bridge: 'bridge from Ethereum for ~$3–$10, about 10 minutes', tx: '~$0.10–$0.50 per transaction' },
  Avalanche: { token: 'AVAX', bridge: 'bridge from Ethereum for ~$3–$10, about 10 minutes', tx: '~$0.10–$1 per transaction' },
  Monad: { token: 'MON', bridge: 'bridge from Ethereum for ~$2–$8, about 10 minutes', tx: '~$0.01–$0.10 per transaction' },
  'Hyperliquid L1': { token: 'HYPE', bridge: 'bridge USDC from Arbitrum for ~$1–$5, about 5 minutes', tx: '~$0.01–$0.10 per transaction' },
  Optimism: { token: 'ETH', bridge: 'bridge from Ethereum mainnet for ~$2–$8, about 10 minutes', tx: '~$0.05–$0.50 per transaction' },
  Polygon: { token: 'POL', bridge: 'bridge from Ethereum for ~$3–$10, about 10 minutes', tx: '~$0.01–$0.10 per transaction' },
};

function chainGuide(chain: string): { token: string; bridge: string; tx: string } {
  return CHAIN_GUIDE[chain] ?? { token: 'the chain’s native token', bridge: 'bridge from Ethereum for ~$3–$10, about 10 minutes', tx: '~$0.10–$1 per transaction' };
}

function mainChain(p: SnapshotProtocol): string {
  return p.chains[0] ?? 'Ethereum';
}

/** The core action for a protocol, by its category. Each names what to do, an amount, a cost and a time. */
function coreAction(p: SnapshotProtocol, chain: string): string {
  const name = p.name;
  const cat = (p.category ?? '').toLowerCase();
  if (cat.includes('lending')) {
    return `Supply $1,000 of USDC to ${name}’s lending market on ${chain} and, if you want the borrow side counted too, borrow $300 of ETH against it; supplying costs ${chainGuide(chain).tx} and takes about 5 minutes, borrowing adds one more transaction.`;
  }
  if (cat.includes('dex') || cat.includes('exchange') || cat.includes('swap')) {
    return `Swap $500 of USDC for the pool’s assets on ${name} on ${chain}, then add $500 as liquidity to its largest pool; the swap and the deposit cost ${chainGuide(chain).tx} each and take about 10 minutes together.`;
  }
  if (cat.includes('yield') || cat.includes('vault') || cat.includes('curator') || cat.includes('allocator')) {
    return `Deposit $1,000 of USDC into ${name}’s main vault on ${chain}; the deposit costs ${chainGuide(chain).tx} and takes about 5 minutes, and the position starts earning the vault’s yield at once.`;
  }
  if (cat.includes('restak') || cat.includes('stak')) {
    return `Restake $1,000 of ETH (or its liquid-staking equivalent) through ${name} on ${chain}; the deposit costs ${chainGuide(chain).tx} and takes about 5 minutes, and the position accrues restaking rewards from the next epoch.`;
  }
  if (cat.includes('rwa') || cat.includes('real world')) {
    return `Mint or buy $1,000 of ${name}’s tokenised asset on ${chain} through its official app; the mint costs ${chainGuide(chain).tx} plus the asset’s own fee and takes about 10 minutes.`;
  }
  if (cat.includes('basis')) {
    return `Deposit $1,000 of USDC into ${name}’s basis-trading strategy on ${chain}; the deposit costs ${chainGuide(chain).tx} and takes about 5 minutes, and the strategy’s funding-rate yield starts accruing immediately.`;
  }
  if (cat.includes('chain')) {
    return `Bridge $1,000 of USDC onto ${name}’s chain and use its core apps (swap once, hold the balance in the wallet); bridging costs ~$2–$8 and takes about 10 minutes, the swap about 5 minutes.`;
  }
  if (cat.includes('bridge')) {
    return `Bridge $1,000 of USDC through ${name} to ${chain}; the bridge fee is roughly $3–$10 and the transfer takes about 10–15 minutes.`;
  }
  if (cat.includes('farm') || cat.includes('leverag')) {
    return `Open a $1,000 leveraged-farming position on ${name} on ${chain} at modest leverage (2x at most); opening costs ${chainGuide(chain).tx} plus the protocol’s fee and takes about 10 minutes.`;
  }
  return `Use ${name}’s core product on ${chain} with $1,000: connect the wallet, run one full cycle of its main action (deposit, swap or stake) and leave the position open; the cycle costs ${chainGuide(chain).tx} and takes about 10 minutes.`;
}

/**
 * Farm steps for a protocol with no token recorded. The snapshot cannot prove
 * a points program, a permissionless deposit, or an open vault exists, so the
 * plan verifies first and makes every later step conditional on what is
 * actually available. Fee ranges are planning assumptions, not quotes.
 */
export function farmStepsPreToken(p: SnapshotProtocol, age: number | null): string[] {
  const chain = mainChain(p);
  const guide = chainGuide(chain);
  const name = p.name;
  const ageNote = age === null ? 'no listing date on record' : `tracked for about ${Math.round(age / 30)} months`;
  return [
    `Start on ${name}’s official site or app (find it from its docs, not a search ad) and confirm the product is live, permissionless, and currently accepting deposits on ${chain}; check for an allowlist, KYC, a minimum deposit, or a paused vault first — if deposits are closed or gated, stop here and move no funds.`,
    `Decide a small illustrative budget before you touch anything — for example $1,000 of working capital, kept separate from fees — and only proceed if you can leave it untouched for 3–6 months; never size a farm by the implied value on this board, which is a protocol valuation, not an expected payout.`,
    `If the product is open: ${coreAction(p, chain)} Fee figures here are planning assumptions — check the app’s own quote before confirming.`,
    `If you proceed, repeat the core action once a week for at least four weeks (about 15 minutes each time, roughly ${guide.tx} per round) so the activity reads as sustained use rather than a single transaction; ${name} is ${ageNote}, so a longer history helps.`,
    `Record every deposit, transaction hash and date in a sheet (5 minutes a week) and check ${name}’s announcements weekly for token or incentive news; if a token or points program is ever announced, be ready to act within the first days, when claims are usually cheapest — this snapshot records no such program.`,
    `Plan the exit before you enter: withdrawing or unstaking can take 1–7 days and cost roughly ${guide.tx} plus any exit fee, so keep a gas reserve of ${guide.token} on ${chain} untouched and never deposit money you need back soon.`,
  ];
}

/**
 * Farm steps for a protocol whose token already trades. There is no first
 * airdrop to chase, so the plan is ordinary participation and research.
 */
export function farmStepsLive(p: SnapshotProtocol, age: number | null): string[] {
  const chain = mainChain(p);
  const guide = chainGuide(chain);
  const name = p.name;
  const mcap = p.mcap_usd !== null ? ` (market cap about $${Math.round(p.mcap_usd / 1_000_000)}M)` : '';
  return [
    `${name}’s token already trades${mcap}, so there is no first airdrop to farm here; this row is a comparison for the model, and you should only use the protocol if its product itself is worth it.`,
    `Start on ${name}’s official site or app and confirm the product you want is live and open on ${chain}, including any allowlist, KYC, or minimum; if it is gated, stop here and move no funds.`,
    `If it is open: ${coreAction(p, chain)} Fee figures here are planning assumptions — check the app’s own quote before confirming.`,
    `If you hold the token, consider staking or supplying it through ${name}’s own app on ${chain} rather than leaving it idle; staking costs roughly ${guide.tx} and takes about 5 minutes, and the yield is the protocol’s own rate, not a points promise.`,
    `Check ${name}’s incentive program weekly (about 10 minutes): live protocols often still pay liquidity mining or fee rebates, and the rates change; move only when the net yield after roughly ${guide.tx} beats simply holding, and plan the exit first — withdrawing can take 1–7 days.`,
  ];
}

/** Farm steps for one protocol, chosen by whether its token trades. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  return isLive(p) ? farmStepsLive(p, age) : farmStepsPreToken(p, age);
}

/** ---- Board ---- */

/**
 * Build the ranked board. Three cohorts, all ranked globally by the same
 * implied-value formula, ranks exactly 1..N:
 *   - the watchlist: every one of the 40 required protocols;
 *   - the other no-token protocols: every remaining protocol that records no
 *     token (they are outside the watchlist, not all below its floor — some
 *     were excluded for product type despite enormous TVL);
 *   - live comparables: every protocol with a positive TVL and market cap,
 *     labelled as comparisons, not opportunities.
 * Protocols that record a token but no usable market cap are not ranked:
 * their value cannot be modelled, and they are counted, not hidden.
 */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const stats = computeStats(snapshot);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = snapshot.watchlist
    .map((slug) => bySlug.get(slug))
    .filter((p): p is SnapshotProtocol => p !== undefined);
  const watchSet = new Set(watchlist.map((p) => p.slug));

  const other = snapshot.protocols.filter((p) => isPreToken(p) && !watchSet.has(p.slug));
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );

  const picked = [...watchlist, ...other, ...live];
  const scored = picked.map((p) => {
    const v = impliedValue(p, snapshot.as_of, stats);
    return { p, v };
  });
  // Rank by the exported rounded dollars, highest first; slug breaks ties.
  scored.sort((a, b) => b.v.implied - a.v.implied || a.p.slug.localeCompare(b.p.slug));

  return scored.map(({ p, v }, i) => ({
    slug: p.slug,
    name: p.name,
    rank: i + 1,
    implied_value_usd: v.implied,
    farm_steps: farmSteps(p, v.age),
  }));
}

/** The dashboard data: the board plus the model's working, for the page. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const stats = computeStats(snapshot);
  const board = buildBoard(snapshot);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchSet = new Set(snapshot.watchlist);
  let watchlistRows = 0;
  let otherRows = 0;
  let liveRows = 0;
  const rows: RadarRow[] = board.map((row) => {
    const p = bySlug.get(row.slug)!;
    const v = impliedValue(p, snapshot.as_of, stats);
    const status: RadarRow['status'] = isLive(p) ? 'token live' : 'pre-token';
    if (watchSet.has(p.slug)) watchlistRows += 1;
    else if (status === 'pre-token') otherRows += 1;
    else liveRows += 1;
    return {
      ...row,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      age_days: v.age,
      age_imputed: v.ageImputed,
      status,
      watchlist: watchSet.has(p.slug),
      exclusion: watchSet.has(p.slug) ? null : watchlistExclusion(p, snapshot.floor_usd),
      growth_factor: v.growthFactor,
      age_factor: v.ageFactor,
      multiple: stats.multiple,
      actual_over_modeled:
        status === 'token live' && p.mcap_usd !== null ? p.mcap_usd / row.implied_value_usd : null,
    };
  });
  const unranked = snapshot.protocols.length - rows.length;
  const modelNote =
    `Implied value = TVL × ${stats.multiple.toFixed(4)} × growth × age. ` +
    `The multiple is the median market-cap-per-TVL of the ${stats.liveCount} token-trading protocols in this snapshot with positive TVL and market cap (quartiles ${stats.multipleQ25.toFixed(3)}–${stats.multipleQ75.toFixed(3)}) — the market's own ratio, read off the data at full precision, and it moves every estimate equally, so it has no effect on rank. ` +
    `Growth = exp(0.25 × (7-day TVL change − median ${stats.g50.toFixed(2)}pp) / ${stats.gSpread.toFixed(2)}pp, clamped to ±1): a protocol that fell less than the field earns a premium; a missing change takes the median. ` +
    `Age = 0.8 + 0.4 × listed-age / (listed-age + 365 days): a diminishing maturity premium that never plateaus; a missing listing date takes the median known age of no-token protocols (${stats.medianAgeNoToken} days) and is flagged as imputed. ` +
    `“Listed age” means time since DefiLlama began tracking the protocol; it is not verified operating age, and an older protocol is not claimed to be more likely to launch a token. ` +
    `A protocol “records no token” when DefiLlama lists no gecko_id or symbol for it; that is what the record says, not proof it has none. ` +
    `Live rows are comparisons only: their token already trades, so their implied value can be checked against their real market cap (actual / modelled is shown); using the same sample to derive the median is an in-sample reference, not validation. ` +
    `${unranked} protocols record a token but no usable market cap and are not ranked. ` +
    `An implied value is a snapshot peer-implied circulating market cap — neither a fully diluted value nor an expected airdrop payout, and a larger one is not a better farming return.`;
  return {
    board,
    radar: {
      meta: {
        as_of: snapshot.as_of,
        floor_usd: snapshot.floor_usd,
        model: 'implied = tvl × median(mcap/tvl) × exp(0.25 × relative growth) × age',
        model_version: MODEL_VERSION,
        base_multiple: stats.multiple,
        multiple_q25: stats.multipleQ25,
        multiple_q75: stats.multipleQ75,
        live_count: stats.liveCount,
        g50: stats.g50,
        g_spread: stats.gSpread,
        median_age_no_token: stats.medianAgeNoToken,
        rows: rows.length,
        watchlist_rows: watchlistRows,
        other_rows: otherRows,
        live_rows: liveRows,
        unranked,
      },
      model_note: modelNote,
      rows,
    },
  };
}

/** Parse and validate the snapshot. Throws SnapshotError on bad input. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not valid JSON');
  }
  const d = raw as Partial<Snapshot>;
  if (typeof d !== 'object' || d === null) throw new SnapshotError('snapshot is not an object');
  if (typeof d.as_of !== 'string') throw new SnapshotError('snapshot has no as_of date');
  if (!Array.isArray(d.protocols) || d.protocols.length === 0) {
    throw new SnapshotError('snapshot has no protocols');
  }
  if (!Array.isArray(d.watchlist)) throw new SnapshotError('snapshot has no watchlist');
  for (const p of d.protocols as SnapshotProtocol[]) {
    if (typeof p.slug !== 'string' || p.slug.length === 0) throw new SnapshotError('a protocol has no slug');
    if (typeof p.name !== 'string' || p.name.length === 0) throw new SnapshotError(`protocol ${p.slug} has no name`);
    if (typeof p.tvl_usd !== 'number' || p.tvl_usd < 0) throw new SnapshotError(`protocol ${p.slug} has no TVL`);
  }
  return d as Snapshot;
}

/** The gate, checked locally before anything is written: null when the board passes. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) {
    return `board holds ${board.length} rows, the gate takes 100 to 4000`;
  }
  const slugs = new Set<string>();
  const ranks = new Set<number>();
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  let prev: number | null = null;
  for (const row of board) {
    if (!known.has(row.slug)) return `board names ${row.slug}, not in the snapshot`;
    if (slugs.has(row.slug)) return `board names ${row.slug} twice`;
    slugs.add(row.slug);
    if (!Number.isInteger(row.rank) || row.rank < 1) return `row ${row.slug} has rank ${row.rank}`;
    ranks.add(row.rank);
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${row.slug} has implied value ${row.implied_value_usd}`;
    }
    if (prev !== null && row.implied_value_usd > prev) return `implied value rises at rank ${row.rank}`;
    prev = row.implied_value_usd;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${row.slug} has ${Array.isArray(row.farm_steps) ? row.farm_steps.length : 0} farm steps`;
    }
    for (const s of row.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug} has a farm step of ${len} characters`;
    }
  }
  for (let i = 1; i <= board.length; i++) {
    if (!ranks.has(i)) return `rank ${i} is missing`;
  }
  if (board.length > 1 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) {
    return 'every implied value is the same: not a ranking';
  }
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data as a script the page reads: window.RADAR = {...}; */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
