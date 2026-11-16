// Token radar value model, board builder, farm plans and dashboard data.
//
// Model version radar-3: the implied value is a FITTED log-log regression,
// estimated at run time from the snapshot's own traded tokens — never a
// hardcoded coefficient and never a hardcoded name. Node 22 standard library
// only, no network, fully deterministic: the same snapshot bytes always
// produce the same board (the bootstrap uses a fixed-seed PRNG, never
// Math.random and never the clock).
//
//   ln(market cap) = b0 + b1·ln(TVL) + b2·(7-day TVL change, pp)
//                    + b3·ln(listed age in days + 1)
//   implied_value_usd = round(exp(predicted ln market cap)), minimum $1
//
// The regression is fitted on the clean comparable traded tokens (market cap
// and TVL both positive, excluding centralised exchanges, liquid staking /
// restaking, bridges and restaked BTC — wrappers and venues, not peers for a
// pre-token launch). It is validated out of sample two ways at run time:
// 5-fold cross-validation and a time split (fit the older half by listed
// age, test the newer half). A deterministic bootstrap band (200 resamples)
// gives the 10th–90th percentile range of each protocol's implied value.

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

/** Design assumptions that are NOT estimated: the growth clamp and the cost table. */
export const MODEL = {
  /** 7-day change is clamped to this range (percentage points) before fitting. */
  growthClampLow: -50,
  growthClampHigh: 100,
  /** Bootstrap resamples and the fixed seed that makes them deterministic. */
  bootstrapResamples: 200,
  bootstrapSeed: 20261114,
  /** A farm verdict needs the plan's total under this many dollars. */
  verdictCostUsd: 40,
} as const;

export const MODEL_VERSION = 'radar-3';

/** Categories excluded from the fitted model's comps: wrappers, bridges, venues. */
const COMP_EXCLUDED_CATEGORIES = new Set([
  'CEX',
  'Liquid Staking',
  'Liquid Restaking',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Restaked BTC',
]);

/** Distribution statistics the model reads off the snapshot at run time. */
export interface ModelStats {
  /** Median market-cap-per-TVL of live protocols with positive TVL and market cap (reference only). */
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

/** Median of a non-empty list of numbers. */
export function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Days between two ISO dates (UTC), or null when the second is missing. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((a - b) / 86_400_000));
}

/** True when the snapshot records no token for the protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** True when the protocol records a token that trades (a market cap is listed). */
export function isLive(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null;
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

/** ---- The fitted model ---- */

/** One protocol's regression features, with the imputations resolved. */
export interface Features {
  /** [1, ln TVL, 7-day change (pp, clamped), ln(age + 1)]. */
  x: [number, number, number, number];
  /** Listed age in days (the no-token median when the listing date is missing). */
  age: number;
  /** True when the age was imputed from the no-token median (listed_at missing). */
  ageImputed: boolean;
  /** 7-day TVL change in percentage points (the snapshot median when missing). */
  growthPp: number;
}

/** The features of one protocol, with missing values imputed as the model states. */
export function featuresFor(p: SnapshotProtocol, asOf: string, stats: ModelStats): Features {
  const growthPp = Math.min(
    MODEL.growthClampHigh,
    Math.max(MODEL.growthClampLow, p.change_7d ?? stats.g50),
  );
  const rawAge = ageDays(asOf, p.listed_at);
  const ageImputed = rawAge === null;
  const age = ageImputed ? stats.medianAgeNoToken : rawAge;
  return {
    x: [1, Math.log(Math.max(1, p.tvl_usd)), growthPp, Math.log(age + 1)],
    age,
    ageImputed,
    growthPp,
  };
}

/** The comparable traded tokens the regression is fitted on, sorted by slug. */
export function cleanComps(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols
    .filter(
      (p) =>
        p.mcap_usd !== null &&
        p.mcap_usd > 0 &&
        p.tvl_usd > 0 &&
        (p.category === null || !COMP_EXCLUDED_CATEGORIES.has(p.category)),
    )
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Solve A·x = b by Gaussian elimination with partial pivoting. Throws on a singular matrix. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) throw new Error('singular matrix in OLS fit');
    if (pivot !== col) {
      const tmp = M[col]!;
      M[col] = M[pivot]!;
      M[pivot] = tmp;
    }
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= M[i]![j]! * x[j]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}

export interface OlsFit {
  /** [intercept, ln TVL, growth, ln age]. */
  coef: [number, number, number, number];
  /** R² of the fit on the rows it was fitted on. */
  r2: number;
}

/**
 * Ordinary least squares by the normal equations. `rows` carries the feature
 * vector and the target (ln market cap) per comparable protocol.
 */
export function fitOLS(rows: { x: [number, number, number, number]; y: number }[]): OlsFit {
  const k = 4;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (const { x, y } of rows) {
    for (let i = 0; i < k; i++) {
      xty[i]! += x[i]! * y;
      for (let j = 0; j < k; j++) xtx[i]![j]! += x[i]! * x[j]!;
    }
  }
  const coef = solveLinear(xtx, xty) as [number, number, number, number];
  const yMean = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const { x, y } of rows) {
    const pred = coef[0]! + coef[1]! * x[1]! + coef[2]! * x[2]! + coef[3]! * x[3]!;
    ssRes += (y - pred) * (y - pred);
    ssTot += (y - yMean) * (y - yMean);
  }
  return { coef, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/** Predicted ln market cap for a feature vector under a fit. */
export function predictLnMcap(coef: [number, number, number, number], x: [number, number, number, number]): number {
  return coef[0]! + coef[1]! * x[1]! + coef[2]! * x[2]! + coef[3]! * x[3]!;
}

/** Median absolute log error and its factor, from a list of |log errors|. */
export function logErrorFactor(absLogErrors: number[]): { medAbsLogErr: number; factor: number } {
  const medAbsLogErr = median(absLogErrors);
  return { medAbsLogErr, factor: Math.exp(medAbsLogErr) };
}

/** The fitted model and its out-of-sample validation, all computed at run time. */
export interface FittedModel extends OlsFit {
  /** Number of comparable traded tokens the regression was fitted on. */
  compsCount: number;
  /** 5-fold cross-validation (folds by sorted slug, i % 5). */
  cv5MedAbsLogErr: number;
  cv5Factor: number;
  /** Time split: fit the older half by listed age, test the newer half. */
  timeSplitMedAbsLogErr: number;
  timeSplitFactor: number;
}

/**
 * Fit the regression on the clean comps and validate it out of sample.
 * Nothing here is hardcoded: every coefficient and every factor is computed
 * from the snapshot passed in.
 */
export function fitModel(snapshot: Snapshot, stats: ModelStats): FittedModel {
  const comps = cleanComps(snapshot);
  const rows = comps.map((p) => {
    const f = featuresFor(p, snapshot.as_of, stats);
    return { x: f.x, y: Math.log(p.mcap_usd!), age: f.age, ageKnown: !f.ageImputed };
  });
  const fit = fitOLS(rows);

  // 5-fold cross-validation, folds by sorted slug (protocol i goes to fold i % 5).
  const cvErrors: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = rows.filter((_, i) => i % 5 !== fold);
    const test = rows.filter((_, i) => i % 5 === fold);
    const foldFit = fitOLS(train);
    for (const r of test) {
      cvErrors.push(Math.abs(r.y - predictLnMcap(foldFit.coef, r.x)));
    }
  }
  const cv5 = logErrorFactor(cvErrors);

  // Time split: fit the older half by listed age, test the newer half. Only
  // comps with a known listing date take part — the split is about real
  // listed age, and an imputed age is not a date to split on.
  const knownAge = rows.filter((r) => r.ageKnown);
  const byAge = [...knownAge].sort((a, b) => b.age - a.age);
  const splitAt = Math.ceil(byAge.length / 2);
  const older = byAge.slice(0, splitAt);
  const newer = byAge.slice(splitAt);
  const tsFit = fitOLS(older);
  const tsErrors = newer.map((r) => Math.abs(r.y - predictLnMcap(tsFit.coef, r.x)));
  const ts = logErrorFactor(tsErrors);

  return {
    coef: fit.coef,
    r2: fit.r2,
    compsCount: comps.length,
    cv5MedAbsLogErr: cv5.medAbsLogErr,
    cv5Factor: cv5.factor,
    timeSplitMedAbsLogErr: ts.medAbsLogErr,
    timeSplitFactor: ts.factor,
  };
}

/** Deterministic PRNG (mulberry32) — the bootstrap's only source of randomness. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap band per protocol: 200 resamples of the comps (rows sampled with
 * replacement, refit each time), each protocol predicted 200 times; the 10th
 * and 90th percentiles of its 200 predicted implied values. Deterministic:
 * fixed seed, fixed resample count, no clock, no Math.random.
 */
export function bootstrapBands(
  snapshot: Snapshot,
  stats: ModelStats,
  targets: { slug: string; x: [number, number, number, number] }[],
): Map<string, { low: number; high: number }> {
  const comps = cleanComps(snapshot);
  const rows = comps.map((p) => {
    const f = featuresFor(p, snapshot.as_of, stats);
    return { x: f.x, y: Math.log(p.mcap_usd!) };
  });
  const n = rows.length;
  const rng = mulberry32(MODEL.bootstrapSeed);
  const preds = new Map<string, number[]>();
  for (const t of targets) preds.set(t.slug, []);
  for (let b = 0; b < MODEL.bootstrapResamples; b++) {
    const sample: { x: [number, number, number, number]; y: number }[] = [];
    for (let i = 0; i < n; i++) sample.push(rows[Math.floor(rng() * n)]!);
    const fit = fitOLS(sample);
    for (const t of targets) {
      preds.get(t.slug)!.push(Math.exp(predictLnMcap(fit.coef, t.x)));
    }
  }
  const bands = new Map<string, { low: number; high: number }>();
  for (const [slug, values] of preds) {
    bands.set(slug, {
      low: Math.max(1, Math.round(percentile(values, 10))),
      high: Math.max(1, Math.round(percentile(values, 90))),
    });
  }
  return bands;
}

/** ---- Implied value ---- */

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
  /** Fitted arithmetic, for the detail view. */
  ln_tvl: number;
  growth_pp: number;
  ln_age: number;
  pred_ln_mcap: number;
  /** Bootstrap band: 10th and 90th percentiles of 200 refit predictions. */
  band_low: number;
  band_high: number;
  /** Farm verdict for pre-token rows (null for live rows, which are comparisons only). */
  verdict: 'Farm' | 'Thin' | 'Skip' | null;
  /** Total plan cost in dollars (planning assumptions — see the farm steps). */
  plan_cost_usd: number;
  /** For live rows only: actual market cap divided by modelled value. */
  actual_over_modeled: number | null;
}

export interface RadarData {
  meta: {
    as_of: string;
    floor_usd: number;
    model: string;
    model_version: string;
    /** Fitted regression coefficients (3 decimals when displayed). */
    coef_intercept: number;
    coef_log_tvl: number;
    coef_growth: number;
    coef_log_age: number;
    /** Comparable traded tokens the regression was fitted on. */
    comps_count: number;
    r2: number;
    cv5_factor: number;
    cv5_med_abs_log_err: number;
    time_split_factor: number;
    time_split_med_abs_log_err: number;
    /** Median implied value across pre-token rows (the verdict rule's line). */
    pre_token_median_implied: number;
    farm_count: number;
    thin_count: number;
    skip_count: number;
    /** Reference only: the old median multiple no longer sets any value. */
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

/** The implied value of one protocol under the fitted model, and its working. */
export interface Implied {
  implied: number;
  predLnMcap: number;
  lnTvl: number;
  growthPp: number;
  lnAge: number;
  age: number | null;
  /** True when the age was imputed (listed_at missing) rather than read. */
  ageImputed: boolean;
}

/**
 * The implied value of one protocol under the fitted regression.
 *
 *   implied = round(exp(b0 + b1·ln TVL + b2·growth + b3·ln(age + 1))), minimum $1
 *
 * Growth is the protocol's own 7-day TVL change in percentage points (the
 * snapshot median when unreported, clamped to −50…+100). Age is listed age —
 * time since DefiLlama began tracking — with a missing date taking the median
 * known age of no-token protocols, flagged as imputed. Only the final value
 * is rounded. The same fitted formula prices live rows too, so
 * actual/modelled stays meaningful.
 */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  stats: ModelStats,
  model: FittedModel,
): Implied {
  const f = featuresFor(p, asOf, stats);
  const predLnMcap = predictLnMcap(model.coef, f.x);
  const implied = Math.max(1, Math.round(Math.exp(predLnMcap)));
  return {
    implied,
    predLnMcap,
    lnTvl: f.x[1]!,
    growthPp: f.growthPp,
    lnAge: f.x[3]!,
    age: f.age,
    ageImputed: f.ageImputed,
  };
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

/**
 * Numeric cost table per chain (midpoints of the ranges above), so a plan's
 * total can be stated in dollars. These are planning assumptions, labelled
 * as such in every plan — check the app's own quote before confirming.
 */
const CHAIN_COST: Record<string, { bridge: number; tx: number }> = {
  Ethereum: { bridge: 0, tx: 8.5 },
  Base: { bridge: 5, tx: 0.275 },
  Arbitrum: { bridge: 5, tx: 0.275 },
  Solana: { bridge: 10, tx: 0.055 },
  Binance: { bridge: 6.5, tx: 0.3 },
  Avalanche: { bridge: 6.5, tx: 0.55 },
  Monad: { bridge: 5, tx: 0.055 },
  'Hyperliquid L1': { bridge: 3, tx: 0.055 },
  Optimism: { bridge: 5, tx: 0.275 },
  Polygon: { bridge: 6.5, tx: 0.055 },
};

function chainGuide(chain: string): { token: string; bridge: string; tx: string } {
  return CHAIN_GUIDE[chain] ?? { token: 'the chain’s native token', bridge: 'bridge from Ethereum for ~$3–$10, about 10 minutes', tx: '~$0.10–$1 per transaction' };
}

function chainCost(chain: string): { bridge: number; tx: number } {
  return CHAIN_COST[chain] ?? { bridge: 6.5, tx: 0.55 };
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

/** How many transactions the core action itself takes, by category (mirrors coreAction). */
function coreTxCount(p: SnapshotProtocol): number {
  const cat = (p.category ?? '').toLowerCase();
  if (cat.includes('lending')) return 2;
  if (cat.includes('dex') || cat.includes('exchange') || cat.includes('swap')) return 2;
  return 1;
}

/**
 * A plan's total cost in dollars (planning assumptions, not quotes):
 * bridge fee (midpoint; $0 on Ethereum, it is L1) + the core action's
 * transactions + 4 weekly repeats (one transaction each) + the exit
 * transaction, each at the chain's typical transaction midpoint.
 */
export function planCostUsd(p: SnapshotProtocol): number {
  const chain = mainChain(p);
  const cost = chainCost(chain);
  const bridge = chain === 'Ethereum' ? 0 : cost.bridge;
  const total = bridge + (coreTxCount(p) + 4 + 1) * cost.tx;
  return Math.round(total * 100) / 100;
}

export type Verdict = 'Farm' | 'Thin' | 'Skip';

/**
 * The farm verdict, a stated rule: "Farm" when the protocol's implied value
 * is above the pre-token median AND the plan's total cost is under $40;
 * "Thin" when exactly one of those holds; "Skip" when neither holds.
 * Live rows get no verdict — their token already trades.
 */
export function verdictFor(implied: number, preTokenMedianImplied: number, planCost: number): Verdict {
  const aboveMedian = implied > preTokenMedianImplied;
  const cheap = planCost < MODEL.verdictCostUsd;
  if (aboveMedian && cheap) return 'Farm';
  if (aboveMedian || cheap) return 'Thin';
  return 'Skip';
}

/** One-line reason for a verdict, for the plan's last step. */
function verdictReason(v: Verdict, implied: number, preTokenMedianImplied: number, planCost: number): string {
  const imp = `$${Math.round(implied).toLocaleString('en-US')}`;
  const med = `$${Math.round(preTokenMedianImplied).toLocaleString('en-US')}`;
  if (v === 'Farm') {
    return `implied value ${imp} is above the pre-token median ${med} and the plan costs $${planCost.toFixed(2)} (under $40)`;
  }
  if (v === 'Thin') {
    return implied > preTokenMedianImplied
      ? `implied value ${imp} is above the pre-token median ${med}, but the plan costs $${planCost.toFixed(2)} (over $40)`
      : `the plan costs only $${planCost.toFixed(2)}, but implied value ${imp} is below the pre-token median ${med}`;
  }
  return `implied value ${imp} is below the pre-token median ${med} and the plan costs $${planCost.toFixed(2)} (over $40)`;
}

/**
 * Farm steps for a protocol with no token recorded. The snapshot cannot prove
 * a points program, a permissionless deposit, or an open vault exists, so the
 * plan verifies first and makes every later step conditional on what is
 * actually available. Fee figures are planning assumptions, not quotes. The
 * last step states the plan's total cost and its verdict.
 */
export function farmStepsPreToken(
  p: SnapshotProtocol,
  age: number | null,
  implied: number,
  verdict: Verdict,
  planCost: number,
  preTokenMedianImplied: number,
): string[] {
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
    `Total plan cost: about $${planCost.toFixed(2)} — bridge $${chain === 'Ethereum' ? '0.00' : chainCost(chain).bridge.toFixed(2)} plus ${coreTxCount(p) + 5} transactions at ~$${chainCost(chain).tx.toFixed(2)} each (core action, four weekly repeats, exit). Verdict: ${verdict}, because ${verdictReason(verdict, implied, preTokenMedianImplied, planCost)}. All fee figures are planning assumptions.`,
  ];
}

/**
 * Farm steps for a protocol whose token already trades. There is no first
 * airdrop to chase, so the plan is ordinary participation and research. The
 * core action's cost is stated as a dollar figure.
 */
export function farmStepsLive(p: SnapshotProtocol, age: number | null): string[] {
  const chain = mainChain(p);
  const guide = chainGuide(chain);
  const name = p.name;
  const mcap = p.mcap_usd !== null ? ` (market cap about $${Math.round(p.mcap_usd / 1_000_000)}M)` : '';
  const coreCost = Math.round(coreTxCount(p) * chainCost(chain).tx * 100) / 100;
  return [
    `${name}’s token already trades${mcap}, so there is no first airdrop to farm here; this row is a comparison for the model, and you should only use the protocol if its product itself is worth it.`,
    `Start on ${name}’s official site or app and confirm the product you want is live and open on ${chain}, including any allowlist, KYC, or minimum; if it is gated, stop here and move no funds.`,
    `If it is open: ${coreAction(p, chain)} The core action costs about $${coreCost.toFixed(2)} (${coreTxCount(p)} transaction${coreTxCount(p) > 1 ? 's' : ''} at ~$${chainCost(chain).tx.toFixed(2)} each, a planning assumption) — check the app’s own quote before confirming.`,
    `If you hold the token, consider staking or supplying it through ${name}’s own app on ${chain} rather than leaving it idle; staking costs roughly ${guide.tx} and takes about 5 minutes, and the yield is the protocol’s own rate, not a points promise.`,
    `Check ${name}’s incentive program weekly (about 10 minutes): live protocols often still pay liquidity mining or fee rebates, and the rates change; move only when the net yield after roughly ${guide.tx} beats simply holding, and plan the exit first — withdrawing can take 1–7 days.`,
  ];
}

/** ---- Board ---- */

/** Format a fitted coefficient with its sign, to 3 decimals. */
function coefStr(v: number): string {
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(3);
}

/**
 * Score the whole snapshot once: fit the model, validate it, bootstrap the
 * bands, price every picked protocol, and build the board and the dashboard
 * data. Deterministic: the same snapshot bytes always produce the same board.
 */
function scoreSnapshot(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const stats = computeStats(snapshot);
  const model = fitModel(snapshot, stats);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchSet = new Set(snapshot.watchlist);
  const watchlist = snapshot.watchlist
    .map((slug) => bySlug.get(slug))
    .filter((p): p is SnapshotProtocol => p !== undefined);
  const watchSlugs = new Set(watchlist.map((p) => p.slug));
  const other = snapshot.protocols.filter((p) => isPreToken(p) && !watchSlugs.has(p.slug));
  const live = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const picked = [...watchlist, ...other, ...live];

  const scored = picked.map((p) => ({ p, v: impliedValue(p, snapshot.as_of, stats, model) }));
  const preTokenMedian = median(scored.filter((s) => isPreToken(s.p)).map((s) => s.v.implied));
  const bands = bootstrapBands(
    snapshot,
    stats,
    scored.map((s) => ({ slug: s.p.slug, x: featuresFor(s.p, snapshot.as_of, stats).x })),
  );

  // Rank by the exported rounded dollars, highest first; slug breaks ties.
  scored.sort((a, b) => b.v.implied - a.v.implied || a.p.slug.localeCompare(b.p.slug));

  let watchlistRows = 0;
  let otherRows = 0;
  let liveRows = 0;
  let farmCount = 0;
  let thinCount = 0;
  let skipCount = 0;
  const board: BoardRow[] = [];
  const rows: RadarRow[] = [];
  scored.forEach(({ p, v }, i) => {
    const status: RadarRow['status'] = isLive(p) ? 'token live' : 'pre-token';
    const planCost = planCostUsd(p);
    const verdict: RadarRow['verdict'] =
      status === 'pre-token' ? verdictFor(v.implied, preTokenMedian, planCost) : null;
    if (verdict === 'Farm') farmCount += 1;
    else if (verdict === 'Thin') thinCount += 1;
    else if (verdict === 'Skip') skipCount += 1;
    const steps =
      status === 'pre-token'
        ? farmStepsPreToken(p, v.age, v.implied, verdict as Verdict, planCost, preTokenMedian)
        : farmStepsLive(p, v.age);
    const band = bands.get(p.slug)!;
    const row: BoardRow = {
      slug: p.slug,
      name: p.name,
      rank: i + 1,
      implied_value_usd: v.implied,
      farm_steps: steps,
    };
    board.push(row);
    if (watchSet.has(p.slug)) watchlistRows += 1;
    else if (status === 'pre-token') otherRows += 1;
    else liveRows += 1;
    rows.push({
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
      ln_tvl: v.lnTvl,
      growth_pp: v.growthPp,
      ln_age: v.lnAge,
      pred_ln_mcap: v.predLnMcap,
      band_low: band.low,
      band_high: band.high,
      verdict,
      plan_cost_usd: planCost,
      actual_over_modeled:
        status === 'token live' && p.mcap_usd !== null ? p.mcap_usd / v.implied : null,
    });
  });

  const unranked = snapshot.protocols.length - rows.length;
  const preTokenCount = rows.filter((r) => r.status === 'pre-token').length;
  const c = model.coef;
  const modelStr =
    `ln mcap = ${c[0]!.toFixed(3)} ${coefStr(c[1]!)}·ln TVL ${coefStr(c[2]!)}·growth ${coefStr(c[3]!)}·ln(age+1)`;
  const modelNote =
    `Implied value = exp(${c[0]!.toFixed(3)} ${coefStr(c[1]!)}·ln TVL ${coefStr(c[2]!)}·7-day change ${coefStr(c[3]!)}·ln(listed age + 1)), rounded to whole dollars. ` +
    `The four coefficients are fitted by ordinary least squares on the ${model.compsCount} traded tokens in this snapshot that are comparable peers (market cap and TVL both positive, excluding centralised exchanges, liquid staking/restaking, bridges and restaked BTC) — the market's own relationship, read off the data at run time, and it prices every protocol by the same rule. ` +
    `Growth enters in percentage points with a small coefficient (${c[2]!.toFixed(3)}): a typical week moves the fitted value little — a +10-point week lowers it by about 18% — while older listings price lower for the same TVL (coefficient ${c[3]!.toFixed(3)}); those are the fitted results, reported honestly, not a story imposed on them. ` +
    `Validation, out of sample: 5-fold cross-validation misses by a factor of ×${model.cv5Factor.toFixed(2)} (median absolute log error ${model.cv5MedAbsLogErr.toFixed(2)}); an age-cohort holdout — fit the 34 older-listed comps, test the 34 newer-listed ones (68 dated comps; 22 have no listed date and are excluded) — misses by ×${model.timeSplitFactor.toFixed(2)} (median absolute log error ${model.timeSplitMedAbsLogErr.toFixed(2)}). This is a split by listed age within one snapshot, not a historical backtest, so the holdout figure does not supersede the cross-validation figure. R² is ${model.r2.toFixed(2)}. ` +
    `Each protocol also carries a bootstrap band (10th–90th percentile of 200 refits on resampled comps, fixed seed): the band shows how much the fitted value moves when the peer set changes — uncertainty in the fitted estimate only, not the range of possible launch outcomes. ` +
    `Verdict rule, stated on every pre-token row: "Farm" when the implied value is above the median over all ${preTokenCount} ranked pre-token protocols ($${Math.round(preTokenMedian).toLocaleString('en-US')}) and the plan's total cost is under $40; "Thin" when exactly one holds; "Skip" when neither holds. A verdict is a screening priority, not a promise of an airdrop return — allocation, eligibility and launch probability are not modelled. ${farmCount} Farm, ${thinCount} Thin, ${skipCount} Skip. ` +
    `“Listed age” means time since DefiLlama began tracking the protocol; it is not verified operating age, and an older protocol is not claimed to be more likely to launch a token. ` +
    `A protocol “records no token” when DefiLlama lists no gecko_id or symbol for it; that is what the record says, not proof it has none. ` +
    `Live rows are comparisons only: their token already trades, so their implied value can be checked against their real market cap (actual / modelled is shown). ` +
    `${unranked} protocols record a token but no usable market cap and are not ranked. ` +
    `An implied value is a snapshot peer-implied circulating market cap — neither a fully diluted value nor an expected airdrop payout, and a larger one is not a better farming return. ` +
    `For reference only, the old median market-cap-per-TVL of all ${stats.liveCount} live protocols is ${stats.multiple.toFixed(4)} (quartiles ${stats.multipleQ25.toFixed(3)}–${stats.multipleQ75.toFixed(3)}); it no longer sets any value.`;

  return {
    board,
    radar: {
      meta: {
        as_of: snapshot.as_of,
        floor_usd: snapshot.floor_usd,
        model: modelStr,
        model_version: MODEL_VERSION,
        coef_intercept: c[0]!,
        coef_log_tvl: c[1]!,
        coef_growth: c[2]!,
        coef_log_age: c[3]!,
        comps_count: model.compsCount,
        r2: model.r2,
        cv5_factor: model.cv5Factor,
        cv5_med_abs_log_err: model.cv5MedAbsLogErr,
        time_split_factor: model.timeSplitFactor,
        time_split_med_abs_log_err: model.timeSplitMedAbsLogErr,
        pre_token_median_implied: preTokenMedian,
        farm_count: farmCount,
        thin_count: thinCount,
        skip_count: skipCount,
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

/**
 * Build the ranked board. Three cohorts, all ranked globally by the same
 * fitted value, ranks exactly 1..N:
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
  return scoreSnapshot(snapshot).board;
}

/** The dashboard data: the board plus the model's working, for the page. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  return scoreSnapshot(snapshot);
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
