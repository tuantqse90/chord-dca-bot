# Chord DCA Bot

Dollar-cost averages into a token list, buying only below the 24h VWAP. Tokenized stocks on Robinhood by default.

An example agent built on [Chord](https://getchord.xyz), the trading API and on-chain data index for agents. Paper by default. Not financial advice.

## Run it

Node 20.12 or newer. Nothing to install and no key for paper mode.

```bash
git clone https://github.com/tuantqse90/chord-dca-bot
cd chord-dca-bot
node index.js                    # one cycle on robinhood
node index.js --chain arbitrum   # another chain
node index.js --loop             # every 30 min (--interval <seconds> to change)
```

The report prints to the terminal and is saved to `state/report.md`.

## What it does each cycle

1. Resolves the token list (`TOKENS`, symbols or addresses) on the chain.
2. Pulls 48 hourly candles per token and computes the 24h VWAP.
3. Buys one `TRANCHE_USD` tranche of a token when its price is at least `BELOW_VWAP_PCT`% under the VWAP, it has not bought it in `COOLDOWN_HOURS`, the token is not down 8% or more on the day and the token has fewer than `MAX_TRANCHES` tranches. Tranches merge into one position with an average entry.
4. Sells half of a holding once it is up 15%.

## Sample run (16 October 2026, paper)

```text
# DCA Bot on Base, 2026-10-16T14:27:49.541Z
Watchlist: WETH, cbBTC
Rule: $20.00 tranche when price is 0.15% or more under the 24h VWAP, cooldown 12h, at most 6 tranches, trim 50% at +15%.

| Token | Price | 24h VWAP | vs VWAP | 24h | Tranches | Action |
| --- | --- | --- | --- | --- | --- | --- |
| WETH | $2.5k | $2.4k | +0.60% | +3.3% | 0 | wait |
| cbBTC | $82.3k | $82.2k | +0.23% | +0.7% | 0 | wait |

## Holdings
No holdings yet.

Book: PAPER · open 0 · unrealized $0 · realized $0 · equity $1.0k
```

## Chains

Ethereum, Base, Arbitrum, BNB Chain, Avalanche, Monad, Robinhood and Arc (keys `ethereum`, `base`, `arbitrum`, `bnb`, `avalanche`, `monad`, `robinhood`, `arc`). On Robinhood the default list is tokenized stocks and ETFs (NVDA, SPY, QQQ, GOOGL, META, AAPL, MSFT); on the other chains it is the wrapped native coin and BTC. Pick one with `CHAIN=` in `.env` or `--chain`.

## Settings

Copy `.env.example` to `.env`. Every setting is optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `CHAIN` | `robinhood` | Chain key or id. |
| `TOKENS` | — | Comma list of symbols or 0x addresses. Empty = the chain's default list. |
| `TRANCHE_USD` | `20` | Size of each buy. |
| `COOLDOWN_HOURS` | `12` | Minimum time between two buys of the same token. |
| `MAX_TRANCHES` | `6` | Cap per token. |
| `BELOW_VWAP_PCT` | `0.15` | How far under the 24h VWAP the price must be, in percent. |
| `LIVE` | `0` | 1 = sign and send real transactions with your key. Anything else = paper. |
| `PRIVATE_KEY` | — | Live only. A fresh hot wallet with small funds; the key never leaves this machine. |
| `RPC_URL` | — | Live only. Your RPC endpoint for the chain; transactions are dry-run and sent through it. |
| `MAX_TRADE_USD` | `25` | Largest single entry. |
| `MAX_OPEN_POSITIONS` | `5` | Entries are refused above this. |
| `MAX_SLIPPAGE_BPS` | `100` | Slippage sent with every quote (100 = 1%). |
| `MAX_PRICE_IMPACT_PCT` | `1.5` | Quotes with more price impact are refused. |
| `DAILY_LOSS_LIMIT_USD` | `50` | No new entries for the rest of the UTC day once realized losses reach this. |
| `PAPER_BANKROLL_USD` | `1000` | Starting cash of the paper book. |
| `CHORD_API` | `https://api.getchord.xyz/v1` | Chord API base URL. |
| `CHORD_API_KEY` | — | Optional. Not needed for anything this agent calls. |
| `CHORD_RPM` | `50` | Client-side request cap per minute (anonymous callers get 60 per IP). |

## Paper and live

**Paper (default).** Every quote is a real route from Chord's router; the fill is simulated at the quoted output, after Chord's fee. The book lives in `state/`.

**Live.** Set `LIVE=1`, `PRIVATE_KEY` and `RPC_URL`, then `npm install` (adds `viem`). Each trade goes: Chord quote → unsigned transaction from Chord (`POST /v1/swap`) → approval of Chord's router if needed → dry run on your RPC → your key signs → send → measure the tokens that actually arrived. Chord never takes custody of keys or funds.

Every entry passes the same risk gate: `MAX_TRADE_USD`, `MAX_OPEN_POSITIONS`, `MAX_PRICE_IMPACT_PCT` and `DAILY_LOSS_LIMIT_USD`. Use a fresh wallet with small funds: the cash leg is the chain's main dollar stablecoin, plus a little native coin for gas.

## Built on Chord

Chord calls this agent makes:

- the token board, `GET /v1/rh/stocks` and `GET /v1/tokens/search` (to resolve symbols)
- `GET /v1/candles`
- `GET /v1/quote` and, in live mode, `POST /v1/swap`

No key is needed: anonymous callers get 60 requests a minute per IP, and the client in `lib/chord.js` stays under that, caches reads briefly and backs off on 429.

- Docs and OpenAPI: https://getchord.xyz/docs
- Hosted MCP server for LLM agents (quotes, unsigned swaps, token boards, trades, wallet PnL; no key): `https://api.getchord.xyz/v1/mcp`. In Claude Code: `claude mcp add --transport http chord https://api.getchord.xyz/v1/mcp`
- More templates: https://github.com/tuantqse90/chord-agent-templates

## Files

```text
index.js          the agent
lib/chord.js      Chord client: rate limit, cache, chain paths from GET /v1/chains
lib/portfolio.js  paper / live book, risk gate, exits
lib/wallet.js     your key and RPC (live mode only)
lib/config.js     settings from .env
lib/util.js       formatting, --loop runner
```

## Disclaimer

Example code, not financial advice. Backtests and paper results do not predict real results. In live mode this program signs real transactions with your key and can lose money.

## License

MIT
