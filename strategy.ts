// Cleanest Paper Bot — a small, disciplined pump.fun scalper (v3).
//
// What the dev data says, and what this bot does about it:
//  - Most new coins are dead on arrival: if a coin is slow to attract trades it
//    never spikes at all (coins that take over a minute to reach 0.5 SOL of real
//    reserve never once beat +50% in the dev window). The money is in the hot
//    coins, and they announce themselves in their first ten trades: a big first
//    buy and mostly buys after it. Those coins spike a median +73% in their first
//    half hour, two in three beat +50%.
//  - A bot that waits for a coin to prove itself with a big reserve and then buys
//    is already too late: the burst slot pushes the price ~20% past the start
//    before the batch is even delivered, and buying there loses on the mean
//    reversion that follows. So this bot enters exactly once, on the batch where
//    a coin's tenth trade lands and the hot filter passes, at whatever price the
//    coin has reached (capped at +30% over its first trade), and then gets out
//    fast: sell into a one-batch jump (a burst's climax is usually followed by a
//    fast dump), a trailing stop once the trade is in profit, a tight stop-loss,
//    and a short time stop.
//  - Many small trades across many coins, at most five open at once, so every
//    hour holds a stream of small outcomes and the hourly Sharpe stays smooth.
//
// All decisions are pure functions of the harness state (slots, reserves, events):
// no clock, no randomness, no environment reads, so two runs produce identical
// action logs. All price comparisons are exact bigint cross-multiplications.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

/** Tunable knobs for the strategy. The defaults are the v3 values. */
export interface StrategyParams {
  /** Size of the one buy per coin, in lamports (capped at 1% of real reserve). */
  stakeLamports: bigint;
  /** Trades observed before deciding a coin is hot. */
  filterTrades: number;
  /** The observed trades must all land within this many slots of the first trade. */
  filterWindowSlots: number;
  /** The first trade must be a buy of at least this many lamports. */
  minFirstBuyLamports: bigint;
  /** At least this share (bps) of the observed trades must be buys. */
  minBuyFracBps: number;
  /** Enter only while the price is at most this many bps above the first trade. */
  maxEntryRunupBps: number;
  /** Trailing stop: sell once the price falls this many bps below its peak since entry. */
  trailBps: number;
  /** The trailing stop arms only once the peak sits this many bps above average cost. */
  trailArmBps: number;
  /** Spike exit: sell when one batch jumps this many bps AND the trade is up at
      least spikeMinGainBps vs average cost (0 disables). */
  spikeJumpBps: number;
  spikeMinGainBps: number;
  /** Stop-loss: sell once the marked value falls this many bps below average cost. */
  stopLossBps: number;
  /** Take-profit: sell once the marked value rises this many bps above average
      cost (0 disables). A fixed cap banks the gain before the dump that usually
      follows a burst, instead of giving it back to the trailing stop. */
  takeProfitBps: number;
  /** Sell everything once a position is this many slots old. 0 disables. */
  timeStopSlots: number;
  /** Slippage tolerance on every order, in bps. */
  slippageBps: number;
  /** Assumed per-leg curve fee (protocol + creator) for exit maths, in bps. */
  feeBps: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  stakeLamports: 50_000_000n, // 0.05 SOL
  filterTrades: 15,
  filterWindowSlots: 600, // ~2 min at ~4.7 slots/s
  minFirstBuyLamports: 500_000_000n, // 0.5 SOL
  minBuyFracBps: 8000, // 80% buys
  maxEntryRunupBps: 5000, // +50%
  trailBps: 1000, // -10% from the peak
  trailArmBps: 500, // arm once the peak is +5% above average cost
  spikeJumpBps: 500, // +5% in one batch
  spikeMinGainBps: 200, // ...while the trade is up at least +2% vs cost
  stopLossBps: 600, // -6% vs average cost
  takeProfitBps: 0, // off: the spike/trailing exits bank more than a fixed cap
  timeStopSlots: 6000, // ~21 min
  slippageBps: 500, // 5%
  feeBps: 125, // 95 protocol + 30 creator
};

/** Diagnostic counters only; the bot never reads them to decide. */
export const STATS = {
  batches: 0,
  evaluated: 0,
  filterPass: 0,
  skippedRunup: 0,
  skippedSlow: 0,
  skippedSmall: 0,
  skippedComplete: 0,
  buys: 0,
  buyLamports: 0n,
  sellsSpike: 0,
  sellsTrail: 0,
  sellsSl: 0,
  sellsTime: 0,
  firstBuySlot: 0,
};

/** What the bot remembers about one mint. */
interface Track {
  /** Slot of its CreateEvent (or of the first sighting). */
  createdSlot: number;
  /** Virtual reserves at the first trade: the price the run-up is measured from. */
  firstVq: bigint;
  firstVt: bigint;
  /** True once an entry decision (buy or skip) has been made for this mint. */
  decided: boolean;
  /** Slot the buy was decided on (0 when no buy was sent). */
  entrySlot: number;
  /** Best (highest) price seen while holding, as virtual reserves. */
  peakVq: bigint;
  peakVt: bigint;
  /** Price at the previous batch, as virtual reserves (0 when unseen). */
  prevVq: bigint;
  prevVt: bigint;
  /** First trade: whether it was a buy, its SOL size, and its slot. */
  firstBuy: boolean;
  firstBuyLamports: bigint;
  firstTradeSlot: number;
  /** Trades observed so far (capped at filterTrades), and buys among them. */
  tradesSeen: number;
  buysSeen: number;
}

const BPS = 10_000n;

export function createBot(params: StrategyParams): Bot {
  const tracks = new Map<string, Track>();

  function trackFor(mint: string, slot: number): Track {
    let t = tracks.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: slot,
        firstVq: 0n,
        firstVt: 0n,
        decided: false,
        entrySlot: 0,
        peakVq: 0n,
        peakVt: 0n,
        prevVq: 0n,
        prevVt: 0n,
        firstBuy: false,
        firstBuyLamports: 0n,
        firstTradeSlot: 0,
        tradesSeen: 0,
        buysSeen: 0,
      };
      tracks.set(mint, t);
    }
    return t;
  }

  /** Marked sell value of `tokens` at the curve's current reserves, fees and tx fee off. */
  function sellValueLamports(
    tokens: bigint,
    vq: bigint,
    vt: bigint,
    txFee: bigint,
  ): bigint {
    if (tokens <= 0n || vt <= 0n) return 0n;
    const gross = (tokens * vq * (BPS - BigInt(params.feeBps))) / (vt * BPS);
    return gross > txFee ? gross - txFee : 0n;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      STATS.batches += 1;
      const orders: OrderInput[] = [];
      const txFee = state.txFeeLamports();
      const caps = state.hello.caps;

      // --- 1. Take in this batch's events: register mints, first-trade price,
      // and the first few trades' directions (the hot filter's evidence).
      const touched: string[] = [];
      const seenTouched = new Set<string>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          trackFor(e.mint, e.slot);
        } else if (e.event === 'TradeEvent') {
          const t = trackFor(e.mint, e.slot);
          if (t.firstVq === 0n) {
            t.firstVq = BigInt(e.virtual_quote_reserves);
            t.firstVt = BigInt(e.virtual_token_reserves);
            t.firstBuy = e.is_buy;
            t.firstBuyLamports = BigInt(e.sol_amount);
            t.firstTradeSlot = e.slot;
          }
          if (t.tradesSeen < params.filterTrades) {
            t.tradesSeen += 1;
            if (e.is_buy) t.buysSeen += 1;
          }
        } else {
          // CompleteEvent: the curve is done; never touch it again.
          const t = tracks.get(e.mint);
          if (t !== undefined) t.decided = true;
        }
        if (!seenTouched.has(e.mint)) {
          seenTouched.add(e.mint);
          touched.push(e.mint);
        }
      }

      // --- 2. Exits first (sells before buys, so a sale's cash is free for entries).
      const sellPending = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell') sellPending.add(p.order.mint);
      }
      for (const [mint, pos] of state.positions) {
        if (sellPending.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tracks.get(mint);
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        // Keep the peak current: the best price seen while holding.
        if (t !== undefined && (t.peakVq === 0n || vq * t.peakVt > t.peakVq * vt)) {
          t.peakVq = vq;
          t.peakVt = vt;
        }
        const value = sellValueLamports(pos.token_amount, vq, vt, txFee);
        const cost = pos.cost_lamports;
        // Spike exit: one batch jumped hard while the trade is in profit — the
        // burst is climaxing, so take it now instead of riding the dump down.
        let spike = false;
        if (
          params.spikeJumpBps > 0 &&
          t !== undefined &&
          t.prevVq > 0n &&
          pos.token_amount > 0n
        ) {
          const jumped =
            vq * t.prevVt * BPS >
            t.prevVq * vt * (BPS + BigInt(params.spikeJumpBps));
          const upEnough =
            vq * pos.token_amount * BPS >
            cost * vt * (BPS + BigInt(params.spikeMinGainBps));
          spike = jumped && upEnough;
        }
        const stopLoss =
          value * BPS <= cost * (BPS - BigInt(params.stopLossBps));
        const takeProfit =
          params.takeProfitBps > 0 &&
          value * BPS >= cost * (BPS + BigInt(params.takeProfitBps));
        // Trailing stop: only once the peak sits clearly above average cost, so
        // it guards a real gain instead of cutting a dip after a small rise.
        let trail = false;
        if (t !== undefined && t.peakVq > 0n && pos.token_amount > 0n) {
          const armed =
            t.peakVq * pos.token_amount >
            cost * t.peakVt * (BPS + BigInt(params.trailArmBps)) / BPS;
          if (armed) {
            trail =
              vq * t.peakVt * BPS <= t.peakVq * vt * (BPS - BigInt(params.trailBps));
          }
        }
        const timedOut =
          params.timeStopSlots > 0 &&
          t !== undefined &&
          t.entrySlot > 0 &&
          state.slot - t.entrySlot >= params.timeStopSlots;
        if (stopLoss || trail || timedOut || spike || takeProfit) {
          const sell: SellInput = {
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: params.slippageBps,
          };
          orders.push(sell);
          if (t !== undefined) t.decided = true;
          if (spike) STATS.sellsSpike += 1;
          else if (takeProfit) STATS.sellsTrail += 1;
          else if (trail) STATS.sellsTrail += 1;
          else if (stopLoss) STATS.sellsSl += 1;
          else STATS.sellsTime += 1;
        }
        // Remember this batch's price for the next batch's jump check.
        if (t !== undefined) {
          t.prevVq = vq;
          t.prevVt = vt;
        }
      }

      // --- 3. Entries: on the batch where a mint's observed trades complete,
      // buy it once if it is hot, the price has not run too far, and a slot is free.
      let free = state.freeCashLamports();
      for (const mint of touched) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const t = tracks.get(mint);
        if (t === undefined || t.decided) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          STATS.skippedComplete += 1;
          t.decided = true;
          continue;
        }
        // Too slow to gather its observed trades: a coin that takes this long
        // to attract trades never spikes. Drop it. (Only once it has traded.)
        if (
          t.firstTradeSlot > 0 &&
          t.tradesSeen < params.filterTrades &&
          state.slot - t.firstTradeSlot > params.filterWindowSlots
        ) {
          STATS.skippedSlow += 1;
          t.decided = true;
          continue;
        }
        // Decide only once the observed trades are in.
        if (t.tradesSeen < params.filterTrades) continue;
        STATS.evaluated += 1;
        const hot =
          t.firstBuy &&
          t.firstBuyLamports >= params.minFirstBuyLamports &&
          t.buysSeen * 10_000 >= params.minBuyFracBps * params.filterTrades;
        if (!hot) {
          t.decided = true;
          continue;
        }
        STATS.filterPass += 1;
        if (t.firstVq === 0n || t.firstVt === 0n) {
          t.decided = true;
          continue;
        }
        // Do not chase a coin whose price already ran far past its start.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const ranUp =
          vq * t.firstVt * BPS >
          t.firstVq * vt * (BPS + BigInt(params.maxEntryRunupBps));
        if (ranUp) {
          STATS.skippedRunup += 1;
          t.decided = true;
          continue;
        }
        // One buy, sized by the 1%-of-reserve cap; a round trip only counts at
        // 0.01 SOL of buys, so never buy less than that.
        const cap = state.maxBuyLamports(mint);
        const amount =
          cap < params.stakeLamports ? cap : params.stakeLamports;
        if (amount < LAMPORTS_PER_SOL / 100n) {
          STATS.skippedSmall += 1;
          t.decided = true;
          continue;
        }
        if (state.committedPositionCount() >= caps.max_open_positions) continue;
        if (free < amount + txFee) continue;
        const buy: BuyInput = {
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: params.slippageBps,
        };
        orders.push(buy);
        STATS.buys += 1;
        STATS.buyLamports += amount;
        if (STATS.firstBuySlot === 0) STATS.firstBuySlot = state.slot;
        t.decided = true;
        t.entrySlot = state.slot;
        free -= amount + txFee;
      }

      return orders;
    },
  };
}
