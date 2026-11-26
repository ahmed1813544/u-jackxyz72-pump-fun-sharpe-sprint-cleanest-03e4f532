// Cleanest Paper Bot — entrypoint. The strategy lives in strategy.ts; this file
// only wires it to the harness shim. Run by the grader as `node /bot/main.ts`.
//
// Strategy in one line: enter a new coin exactly once, on the batch where its
// fifteenth trade lands and its first trades prove it hot (a big first buy,
// mostly buys), then exit fast on a one-batch jump, a trailing stop, a tight
// stop-loss, or a short time stop. Many small trades, at most five open at once,
// so every hour holds a stream of small outcomes and the hourly Sharpe stays
// smooth. Fully deterministic: every decision is a pure function of the harness
// state (slots, reserves, events) — no clock, no randomness, no environment reads.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createBot(DEFAULT_PARAMS));
