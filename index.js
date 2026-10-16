// DCA Bot: buys a small fixed tranche of each token on your list, but only when it trades below its 24h VWAP.
// At most one tranche per token per cooldown, up to a cap per token; trims half the holding at +15%.
// Works on every EVM chain Chord serves. On Robinhood the default list is tokenized stocks and ETFs.
import { CONFIG } from './lib/config.js';
import { resolveChain, findTokens, candles, mapLimit } from './lib/chord.js';
import { Portfolio } from './lib/portfolio.js';
import { safe, usd, pct, table, writeReport, runAgent } from './lib/util.js';

const DEFAULTS = {
  robinhood: ['NVDA', 'SPY', 'QQQ', 'GOOGL', 'META', 'AAPL', 'MSFT'],
  base: ['WETH', 'cbBTC'],
  arbitrum: ['WETH', 'WBTC', 'ARB'],
  ethereum: ['WETH', 'WBTC'],
  bnb: ['WBNB', 'BTCB', 'ETH'],
  avalanche: ['WAVAX', 'BTC.b'],
  monad: ['WMON', 'WBTC', 'WETH'],
  arc: ['cirBTC'],
};

const P = {
  trancheUsd: Math.min(Number(process.env.TRANCHE_USD || 20), CONFIG.maxTradeUsd),
  cooldownHours: Number(process.env.COOLDOWN_HOURS || 12),
  maxTranchesPerToken: Number(process.env.MAX_TRANCHES || 6),
  belowVwapPct: Number(process.env.BELOW_VWAP_PCT || 0.15), // price must be this % under the 24h VWAP
  maxDrop24hPct: -8,        // do not catch a falling knife
  trimAtReturn: 0.15,
  trimFraction: 0.5,
};

class DcaBook extends Portfolio {
  // Every tranche goes through buy() (same risk gate) and is merged into one position per token.
  async add(opts) {
    const key = opts.token.toLowerCase();
    const existing = this.state.positions[key];
    if (existing) delete this.state.positions[key];
    let fresh = null;
    try { fresh = await this.buy(opts); } finally { if (existing && !fresh) this.state.positions[key] = existing; }
    if (existing && fresh) {
      const qty = BigInt(existing.qtyRaw) + BigInt(fresh.qtyRaw);
      const cost = existing.costUsd + fresh.costUsd;
      this.state.positions[key] = { ...existing, qtyRaw: qty.toString(), costUsd: cost, entryPrice: cost / (Number(qty) / 10 ** existing.decimals), tranches: (existing.tranches || 1) + 1, lastAddAt: Date.now() };
    } else if (fresh) Object.assign(fresh, { tranches: 1, lastAddAt: Date.now() });
    this.save();
    return fresh;
  }

  async trim(token, fraction, reason) {
    const key = token.toLowerCase();
    const pos = this.state.positions[key];
    if (!pos) return null;
    const qty = BigInt(pos.qtyRaw);
    const sellQty = (qty * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
    const keep = { ...pos, qtyRaw: (qty - sellQty).toString(), costUsd: pos.costUsd * (1 - fraction) };
    this.state.positions[key] = { ...pos, qtyRaw: sellQty.toString(), costUsd: pos.costUsd * fraction };
    const res = await this.sell(token, reason);
    this.state.positions[key] = res ? keep : pos;
    this.save();
    return res;
  }
}

// 24h VWAP from 1h candles (typical price weighted by volume).
export function vwap24(cs) {
  const last = cs.slice(-24);
  const v = last.reduce((a, c) => a + safe(c.v), 0);
  return v ? last.reduce((a, c) => a + ((c.h + c.l + c.c) / 3) * safe(c.v), 0) / v : NaN;
}

async function cycle() {
  const chain = await resolveChain(CONFIG.chain || 'robinhood');
  const wanted = process.env.TOKENS ? process.env.TOKENS.split(',') : DEFAULTS[chain.key] || [chain.wrapped.symbol];
  const { found: watch, missing } = await findTokens(chain, wanted);
  const book = new DcaBook(chain, { name: 'dca' });

  const charts = await mapLimit(watch, 3, (t) => candles(chain, t.address, { tf: '1h', limit: 48 }));
  const rows = watch.map((t, i) => {
    const cs = Array.isArray(charts[i]) ? charts[i] : [];
    const price = cs.length ? cs[cs.length - 1].c : NaN;
    const dayAgo = cs.length > 24 ? cs[cs.length - 25].c : NaN;
    const vw = vwap24(cs);
    const gap = (price / vw - 1) * 100;
    const ch24 = (price / dayAgo - 1) * 100;
    const pos = book.state.positions[t.address];
    const sinceH = pos?.lastAddAt ? (Date.now() - pos.lastAddAt) / 3600_000 : Infinity;
    let action = 'wait';
    if (!Number.isFinite(gap)) action = 'no candles';
    else if ((pos?.tranches || 0) >= P.maxTranchesPerToken) action = 'cap reached';
    else if (sinceH < P.cooldownHours) action = `cooldown ${(P.cooldownHours - sinceH).toFixed(1)}h`;
    else if (ch24 <= P.maxDrop24hPct) action = 'falling knife';
    else if (gap <= -P.belowVwapPct) action = 'BUY';
    return { t, price, vw, gap, ch24, pos, action };
  });

  // Trim winners first, then buy tranches.
  for (const pos of book.positions) {
    const r = rows.find((x) => x.t.address === pos.token.toLowerCase());
    const value = await book.exitValueUsd(pos, r?.price);
    if (Number.isFinite(value) && value / pos.costUsd - 1 >= P.trimAtReturn) await book.trim(pos.token, P.trimFraction, `take ${P.trimFraction * 100}% profit at ${pct((value / pos.costUsd - 1) * 100)}`);
  }
  for (const r of rows.filter((x) => x.action === 'BUY')) {
    if (!(await book.add({ token: r.t.address, symbol: r.t.symbol, decimals: r.t.decimals, sizeUsd: P.trancheUsd, meta: { vwap: r.vw } }))) r.action = 'blocked by risk gate';
  }

  const marks = [];
  for (const pos of book.positions) marks.push({ ...pos, value: await book.exitValueUsd(pos) });
  const md = [
    `# DCA Bot on ${chain.label}, ${new Date().toISOString()}`,
    `Watchlist: ${watch.map((t) => t.symbol).join(', ') || 'empty'}${missing.length ? ` (not found on ${chain.label}: ${missing.join(', ')})` : ''}`,
    `Rule: ${usd(P.trancheUsd)} tranche when price is ${P.belowVwapPct}% or more under the 24h VWAP, cooldown ${P.cooldownHours}h, at most ${P.maxTranchesPerToken} tranches, trim ${P.trimFraction * 100}% at +${P.trimAtReturn * 100}%.`,
    '',
    table(['Token', 'Price', '24h VWAP', 'vs VWAP', '24h', 'Tranches', 'Action'],
      rows.map((r) => [r.t.symbol, usd(r.price), usd(r.vw), pct(r.gap, 2), pct(r.ch24), r.pos?.tranches || 0, r.action])),
    '',
    '## Holdings',
    marks.length ? table(['Token', 'Tranches', 'Avg entry', 'Cost', 'Value', 'Return'], marks.map((m) => [m.symbol, m.tranches || 1, usd(m.entryPrice), usd(m.costUsd), usd(m.value), pct((m.value / m.costUsd - 1) * 100)])) : 'No holdings yet.',
    '',
    `Book: ${book.line(marks)}`,
  ].join('\n');
  writeReport('report.md', md);
  console.log(md);
}

if (import.meta.url === `file://${process.argv[1]}`) runAgent('dca-bot', cycle, 1800);
