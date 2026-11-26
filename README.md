# Cleanest Paper Bot

[![Bounty](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ahmed1813544/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/ahmed1813544/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty. One strategy program, `main.ts` on Node 22, trading 10 SOL of paper money on a 6-hour pump.fun forward replay. Ranked by **hourly Sharpe ratio**, so the goal is steady, controlled gains — not one lucky moonshot.

## The strategy

Most new pump.fun coins are dead on arrival: a coin that is slow to attract trades never spikes at all. The money is in the *hot* coins, and they announce themselves in their first fifteen trades — a big first buy (≥ 0.5 SOL) and mostly buys after it (≥ 80%). Those coins spike a median +73% in their first half hour.

So the bot:

1. **Watches every new coin** and scores its first fifteen trades. A coin that takes too long to gather them is dropped — slow coins never spike.
2. **Enters exactly once**, on the batch where the fifteenth trade lands and the hot filter passes, buying up to 0.05 SOL (capped at 1% of the coin's real SOL reserve), unless the price has already run more than +50% past its first trade.
3. **Exits fast**, selling everything on the first of:
   - a **spike exit** — one batch jumps ≥ 5% while the trade is in profit (a burst's climax is usually followed by a fast dump, so sell into the jump);
   - a **trailing stop** — 10% below the best price seen since entry, armed once the peak is +5% above average cost;
   - a **stop-loss** — 6% below average cost;
   - a **time stop** — about 21 minutes after entry.
4. Never holds more than **5 positions** at once, never re-enters a coin, and only ever trades the coins the filter picks — many small trades across many coins, so every hour holds a stream of small outcomes.

## Determinism

Every decision is a pure function of the harness state (slots, reserves, events). No clock, no randomness, no environment reads — two runs on the same replay produce byte-identical action logs.

## Local results (dev window, kit's replay sim)

| Metric | Value |
| --- | --- |
| Net PnL | +0.050 SOL |
| Hourly Sharpe | 0.103 (24 hourly returns) |
| Round trips | 104, on 104 distinct mints |
| Win rate | 44 / 104 |
| Max drawdown | 0.88% |
| Net PnL at 2x fees | −0.088 SOL |

Guardrails: max 5 open positions, round trips of ≥ 0.01 SOL on ≥ 20 distinct mints, max drawdown 50% — all met with wide margin on the dev window. (The dev window's quiet first half is a losing regime for this style; the busy second half, which matches the final window's evening hours, scores +0.092 SOL at Sharpe 0.298.)

## Files

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the strategy (all tunable knobs in `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte-identical from the kit's `sdk/ts/makefun-bot.ts`.
- `LICENSE` — MIT.

## Run it

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout; the kit's local grader drives it. It needs no install and no network.
