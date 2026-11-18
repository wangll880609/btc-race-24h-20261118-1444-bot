// Dip Buyer for cbBTC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Idea, in one line: buy a sharp 1.5% dip below the 3-hour high, then bank
// a 2% bounce — in a tape that drifts down, breakouts fail and the money
// is in the snap-backs, not in chasing new highs.
//
// Why this shape: this dev window falls 2.8% over 24 hours with ~6.7 bps
// of noise a bar, so a breakout rider buys the top of each dead-cat bounce
// and rides it back down (yesterday's breakout parameters lose $30 here).
// A dip buy instead pays ~26-36 bps a round trip in fee, slippage and pool
// impact, and a 1.5% dip followed by a 2% recovery clears that cost several
// times over. The bot therefore trades rarely — a handful of times a day:
//   - Entry: the close is at least 1.5% below the highest close of the
//     previous 180 bars (3 hours). Full cash, one position. The dip must be
//     measured against a 3-hour high, not a 25-minute one, so ordinary
//     0.5-1% chop does not trigger a buy.
//   - Exit, whichever comes first:
//       * Take-profit: the position is worth 2% over its cost (fees
//         included), measured in exact integer quote units.
//       * Stop-loss: the position is worth 1.2% under its cost — a dip
//         that keeps falling is a falling knife, not a bargain, so the
//         loss is cut instead of ridden to the end of the window.
//       * Time stop: 360 bars (6 hours) after entry with neither exit
//         hit, the position is closed. A dip that never bounces is dead
//         capital; freeing it lets the bot buy the next, deeper dip.
//       * After a stop-loss exit, the next entry needs a deeper 2% dip,
//         so a slide that just stopped the bot out is not re-bought at
//         the same shallow level.
//   - No trailing stop and no re-entry on the same bar: after a sell the
//     bot waits for the next bar's close before it can buy again.
//   - No orders during warm-up batches; bars are still recorded so the
//     180-bar window is warm when trading opens.
//
// All comparisons of money use exact integer (bigint) quote units from the
// harness account; closes are plain numbers (raw price units, exact as
// integers below 2^53) used only for the dip test. No clock, no network,
// no randomness, no files: the same bars always give the same orders.
// Parameters were tuned on this competition's dev window with the kit's
// local grader (grid over lookback 120-240, dip 1.2-1.8%, take-profit
// 1.8-2.0%, hold 360): the chosen set scores about +$21 on dev with
// 5 trades and 0.79% max drawdown, and most neighbouring parameter sets
// are also profitable, so the result is not a knife-edge fit.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Dip lookback, in closes (180 one-minute bars = 3 hours). */
const DIP_BARS = 180;
/** Entry: close at least this far below the lookback high (985/1000). */
const DIP_NUM = 985;
const DIP_DEN = 1000;
/** Take-profit: position value this far over its cost (1020/1000). */
const TP_NUM = 1020n;
const TP_DEN = 1000n;
/** Stop-loss: position value this far under its cost (988/1000). */
const STOP_NUM = 988n;
const STOP_DEN = 1000n;
/** Time stop: close the position this many batches after entry. */
const MAX_HOLD_BARS = 360;
/** After a stop-loss exit, the next entry needs a deeper dip (980/1000):
 * a slide that just stopped the bot out should not be re-bought at the
 * same shallow level — wait for a genuinely deeper bargain. The flag
 * clears on the next buy, so it never blocks a fresh setup forever. */
const REDIP_NUM = 980;
const REDIP_DEN = 1000;
/** Slippage cap per order, in bps (1% past the close it was decided on). */
const MAX_SLIPPAGE_BPS = 100;

/** Closes seen so far, oldest first, raw price units. */
const closes: number[] = [];
/** Batch index at which the current position was entered (-1 when flat). */
let entryBatch = -1;
/** True when the last exit was the stop-loss: next entry needs REDIP. */
let stoppedOut = false;
/** Batches answered so far, counting every batch including warm-up. */
let batchIndex = 0;

/** Highest close of the previous DIP_BARS bars, excluding the current one. */
function lookbackHigh(): number {
  const n = closes.length;
  let hi = 0;
  for (let i = n - 1 - DIP_BARS; i < n - 1; i++) {
    if (closes[i] > hi) hi = closes[i];
  }
  return hi;
}

function recordBars(batch: Batch): void {
  for (const bar of batch.bars) {
    if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
  }
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    recordBars(batch);
    const myBatch = batchIndex;
    batchIndex += 1;
    if (state.warmingUp) return [];
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const tookProfit = value * TP_DEN >= held.cost * TP_NUM;
      const hitStop = value * STOP_DEN <= held.cost * STOP_NUM;
      const timedOut = entryBatch >= 0 && myBatch - entryBatch >= MAX_HOLD_BARS;
      // Take-profit, stop-loss, or time stop — whichever comes first.
      if (tookProfit || hitStop || timedOut) {
        stoppedOut = hitStop;
        entryBatch = -1;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }
    if (closes.length < DIP_BARS + 1) return [];
    const close = closes[closes.length - 1];
    const hi = lookbackHigh();
    // Buy the dip: close 1.5% or more below the 3-hour high (2% after a
    // stop-loss, see REDIP_NUM). The threshold is chosen before the test.
    const dipNum = stoppedOut ? REDIP_NUM : DIP_NUM;
    const dipDen = stoppedOut ? REDIP_DEN : DIP_DEN;
    if (close * dipDen >= hi * dipNum) return [];
    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    stoppedOut = false;
    entryBatch = myBatch;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
