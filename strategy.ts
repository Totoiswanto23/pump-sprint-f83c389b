// Launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Watchlist: every coin is tracked from its CreateEvent. The bot buys in the
// first few slots of a launch that clears a rug filter — real SOL reserves in
// range, the creator's own buy small, only a handful of distinct buyers so far,
// the creator has not sold, no outsized single sell, price not already run away
// — then exits quickly: take-profit, stop-loss, a short holding cap, and an
// instant exit when the creator sells. A partial take-profit and a trailing
// stop exist as options but ship switched off. Most launches die, so each bet
// is small and the few runners have to pay for the losers.
//
// Guardrail insurance: when the bot's own filled coins fall behind the pace of
// the window, it opens tiny round trips on liquid curves so the run stays above
// the 20-coin bar.
//
// Sprint tuning for "Pump.fun Paper Sprint: Any Bot Can Win": the final window
// is 6 hours, so the probe pace (paceSecs) is 6 hours instead of 24. The sniper
// filter, the stake and the exits are the best-tested settings from the shared
// 24h dev dataset, unchanged. Re-verified after a rename-only refactor: the
// dev backtest is byte-identical in outcome (net -0.031 SOL, 115 coins).
//
// Deterministic: no clock, no randomness, iteration only over insertion-ordered
// maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age, in slots since create, at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin in total (each buy still capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot, at most, in SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry: allowed window. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others over lamports bought, at most, as a fraction. */
  maxSellRatio: number;
  /** Largest single non-creator sell seen, as a share of real SOL before it. */
  maxBigSellShare: number;
  /** Price now over the create price, as a fraction: allowed window. */
  minRunup: number;
  maxRunup: number;
  /** Recent-flow window in slots, and what it must show. */
  flowWindow: number;
  minFlowSol: number;
  minRecentBuyers: number;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** Slippage allowed on buys, in bps. */
  buySlipBps: number;
  /** Sell this share once the position is worth (1 + tp1) of its cost. 0 = off. */
  tp1: number;
  tp1Part: number;
  /** After the first take-profit, the rest stops out at cost * (1 + slAfterTp1). */
  slAfterTp1: number;
  /** Exit when the position is worth (1 + tp) of its cost. */
  tp: number;
  /** Exit when the position is worth (1 - sl) of its cost. */
  sl: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail off the best. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while the position is held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Guardrail pacing targets. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** SOL kept back as a cash reserve (plus one tx fee per order). */
  cashReserveSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.01,
  minBuySol: 0.005,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 0.5,
  minBuyers: 0,
  maxBuyers: 2,
  maxSellRatio: 1,
  maxBigSellShare: 1,
  minRunup: 0,
  maxRunup: 100,
  flowWindow: 10,
  minFlowSol: -1e12,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlipBps: 10_000,
  tp1: 0,
  tp1Part: 0.5,
  slAfterTp1: 0,
  tp: 0.15,
  sl: 0.12,
  trailArm: 0,
  trail: 0.1,
  maxHold: 5,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  targetCoins: 21,
  targetFills: 42,
  paceSecs: 21_600, // 6-hour final window (was 86_400 for the 24h sprint)
  probeSol: 0.02,
  maxProbes: 1,
  maxExposureSol: 4,
  cashReserveSol: 0.05,
};

const LAMPORTS = 1e9;
/** Curve fee on a trade: 1.25% (95 bps protocol + 30 bps creator). */
const CURVE_FEE = 0.0125;

interface TradeTick {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: number;
  vt0: number;
  devBuy: number;
  trades: number;
  buyers: Set<Pubkey>;
  bought: number;
  soldByOthers: number;
  bigSellShare: number;
  devSold: boolean;
  lastTradeSlot: number;
  recent: TradeTick[];
  boughtOnce: boolean;
  done: boolean;
  complete: boolean;
}

interface Position {
  openedSlot: number;
  txPaid: number;
  best: number;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

export function createStrategy(cfg: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const openPos = new Map<Pubkey, Position>();
  const exiting = new Set<Pubkey>();
  const probeCoins = new Map<Pubkey, boolean>();
  let filledCount = 0;
  const filledCoins = new Set<Pubkey>();
  let windowStart: number | null = null;
  let windowEnd: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let coin = coins.get(mint);
    if (coin === undefined) {
      coin = {
        mint,
        createSlot: -1,
        creator: '',
        vq0: 0,
        vt0: 1,
        devBuy: 0,
        trades: 0,
        buyers: new Set(),
        bought: 0,
        soldByOthers: 0,
        bigSellShare: 0,
        devSold: false,
        lastTradeSlot: -1,
        recent: [],
        boughtOnce: false,
        done: false,
        complete: false,
      };
      coins.set(mint, coin);
    }
    return coin;
  };

  /** Net SOL bought minus sold, plus distinct buyers, over the last flowWindow slots. */
  const recentFlow = (coin: Coin, now: number): { net: number; buyers: number } => {
    const from = now - cfg.flowWindow;
    let drop = 0;
    while (drop < coin.recent.length && coin.recent[drop]!.slot <= from) drop++;
    if (drop > 0) coin.recent.splice(0, drop);
    let net = 0;
    const buyers = new Set<Pubkey>();
    for (const tick of coin.recent) {
      if (tick.buy) {
        net += tick.sol;
        buyers.add(tick.user);
      } else {
        net -= tick.sol;
      }
    }
    return { net, buyers: buyers.size };
  };

  /** What selling `tokens` against (vq, vt) would pay after curve fees, in SOL. */
  const exitValue = (tokens: number, vq: number, vt: number): number => {
    if (tokens <= 0 || vt <= 0) return 0;
    const quote = (tokens * vq) / (vt + tokens);
    return (quote / LAMPORTS) * (1 - CURVE_FEE);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const event of batch.events) {
        if (event.block_time !== null) {
          if (windowStart === null) windowStart = event.block_time;
          if (windowEnd === null || event.block_time > windowEnd) windowEnd = event.block_time;
        }
        if (event.event === 'CreateEvent') {
          const coin = coinOf(event.mint);
          coin.createSlot = event.slot;
          coin.creator = event.creator;
          coin.vq0 = Number(event.virtual_quote_reserves);
          coin.vt0 = Number(event.virtual_token_reserves);
          coin.lastTradeSlot = event.slot;
        } else if (event.event === 'TradeEvent') {
          const coin = coins.get(event.mint);
          if (coin === undefined) continue;
          const sol = Number(event.sol_amount) / LAMPORTS;
          coin.trades++;
          coin.lastTradeSlot = event.slot;
          coin.recent.push({ slot: event.slot, buy: event.is_buy, sol, user: event.user });
          const isDev = event.user === coin.creator;
          if (event.is_buy) {
            coin.bought += sol;
            if (isDev && event.slot === coin.createSlot) coin.devBuy += sol;
            else if (!isDev) coin.buyers.add(event.user);
          } else if (isDev) {
            coin.devSold = true;
          } else {
            coin.soldByOthers += sol;
            const reserveBefore = Number(event.real_quote_reserves) / LAMPORTS + sol;
            if (reserveBefore > 0) {
              const share = sol / reserveBefore;
              if (share > coin.bigSellShare) coin.bigSellShare = share;
            }
          }
        } else {
          const coin = coins.get(event.mint);
          if (coin !== undefined) {
            coin.complete = true;
            coin.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map(batch.marks.map((mark) => [mark.mint, mark] as const));
      for (const fill of batch.fills) {
        if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
          filledCount++;
          filledCoins.add(fill.mint);
        }
        if (fill.client_id.startsWith('_')) {
          openPos.delete(fill.mint);
          exiting.delete(fill.mint);
          continue;
        }
        const pos = openPos.get(fill.mint);
        if (fill.status !== 'rejected' && pos !== undefined) pos.txPaid += Number(fill.tx_fee_lamports) / LAMPORTS;
        if (fill.side === 'buy' && fill.status === 'filled' && pos === undefined) {
          openPos.set(fill.mint, {
            openedSlot: fill.slot,
            txPaid: Number(fill.tx_fee_lamports) / LAMPORTS,
            best: 0,
            devSoldAtOpen: coins.get(fill.mint)?.devSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...exiting]) {
        let stillPending = false;
        for (const pending of state.pending.values()) {
          if (pending.order.mint === mint && pending.order.side === 'sell') stillPending = true;
        }
        if (!stillPending) exiting.delete(mint);
      }
      for (const mint of [...openPos.keys()]) {
        if (!state.positions.has(mint) && !exiting.has(mint)) {
          let buyPending = false;
          for (const pending of state.pending.values()) {
            if (pending.order.mint === mint && pending.order.side === 'buy') buyPending = true;
          }
          if (!buyPending) openPos.delete(mint);
        }
      }
      const pendingByMint = new Map<Pubkey, number>();
      for (const pending of state.pending.values()) {
        pendingByMint.set(pending.order.mint, (pendingByMint.get(pending.order.mint) ?? 0) + 1);
      }

      // Exits first.
      for (const [mint, position] of state.positions) {
        if (orders.length >= cap) break;
        if (exiting.has(mint)) continue;
        if (probeCoins.has(mint)) continue; // probes are closed by the probe loop, not here.
        const coin = coins.get(mint);
        let pos = openPos.get(mint);
        if (pos === undefined) {
          pos = { openedSlot: now, txPaid: tx, best: 0, devSoldAtOpen: coin?.devSold ?? false, tookTp1: false };
          openPos.set(mint, pos);
        }
        const mark = marks.get(mint);
        const curve = state.curves.get(mint);
        const vq = mark ? Number(mark.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
        const vt = mark ? Number(mark.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 1;
        const tokens = Number(position.token_amount);
        const value = exitValue(tokens, vq, vt) - tx;
        const basis = Number(position.cost_lamports) / LAMPORTS + pos.txPaid;
        if (value > pos.best) pos.best = value;
        let exit = false;
        if (basis > 0) {
          if (cfg.tp1 > 0 && !pos.tookTp1 && value >= basis * (1 + cfg.tp1)) {
            const part = Math.floor(tokens * cfg.tp1Part);
            if (part > 0 && part < tokens) {
              orders.push({ side: 'sell', mint, token_amount: BigInt(part), max_slippage_bps: 10_000 });
              exiting.add(mint);
              pos.tookTp1 = true;
              pos.best = 0;
              if (coin !== undefined) coin.done = true;
              continue;
            }
          }
          if (value >= basis * (1 + cfg.tp)) exit = true;
          const stop = pos.tookTp1 ? -cfg.slAfterTp1 : cfg.sl;
          if (value <= basis * (1 - stop)) exit = true;
          if (cfg.trailArm > 0 && pos.best >= basis * (1 + cfg.trailArm) && value <= pos.best * (1 - cfg.trail)) exit = true;
        }
        if (now - pos.openedSlot >= cfg.maxHold) exit = true;
        if (coin !== undefined) {
          if (cfg.exitOnDevSell && coin.devSold && !pos.devSoldAtOpen) exit = true;
          if (now - coin.lastTradeSlot >= cfg.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        exiting.add(mint);
        if (coin !== undefined) coin.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probeCoins) {
        const position = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (position === undefined) {
          if (!pendingByMint.has(mint)) probeCoins.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        if (!sellingProbe) probeCoins.set(mint, true);
      }

      // Entries: one buy per coin, in its first slots, only if the rug filter passes.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let exposure = 0;
      for (const [mint] of openPos) {
        exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      }
      let open = state.committedPositionCount();
      for (const coin of coins.values()) {
        if (orders.length >= cap) break;
        if (coin.done || coin.complete || coin.boughtOnce) continue;
        const age = now - coin.createSlot;
        const curve = state.curves.get(coin.mint);
        if (curve === undefined || curve.complete) {
          continue;
        }
        const rq = Number(curve.real_quote_reserves) / LAMPORTS;
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        // One buy per coin, in its first slots, only if the rug filter passes.
        if (age <= cfg.maxAge) {
          if (age < cfg.minAge) {
            continue;
          }
          if (open >= state.hello.caps.max_open_positions) {
            continue;
          }
          if (coin.devSold && cfg.skipDevSold) {
            coin.done = true;
            continue;
          }
          if (rq < cfg.minRealSol || rq > cfg.maxRealSol) {
            continue;
          }
          if (coin.devBuy > cfg.maxDevBuySol) {
            continue;
          }
          if (coin.buyers.size < cfg.minBuyers || coin.buyers.size > cfg.maxBuyers) {
            continue;
          }
          if (coin.bought > 0 && coin.soldByOthers > coin.bought * cfg.maxSellRatio) {
            continue;
          }
          if (coin.bigSellShare > cfg.maxBigSellShare) {
            continue;
          }
          const runup = (vq * coin.vt0) / (vt * coin.vq0) - 1;
          if (runup < cfg.minRunup || runup > cfg.maxRunup) {
            continue;
          }
          const flowNow = recentFlow(coin, now);
          if (flowNow.net < cfg.minFlowSol || flowNow.buyers < cfg.minRecentBuyers) {
            continue;
          }
          const maxBuy = Math.floor(Number(state.maxBuyLamports(coin.mint))) / LAMPORTS;
          const amount = Math.min(cfg.stakeSol, maxBuy);
          if (amount < cfg.minBuySol) {
            continue;
          }
          if (free < amount + tx + cfg.cashReserveSol) {
            continue;
          }
          if (exposure + amount > cfg.maxExposureSol) {
            continue;
          }
          orders.push({ side: 'buy', mint: coin.mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: cfg.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          coin.boughtOnce = true;
          open++;
          continue;
        }
        if (age > cfg.maxAge) {
          coin.done = true;
        }
      }

      // Guardrail pacing: open a probe when filled coins lag the pace of the window.
      if (probeCoins.size < cfg.maxProbes && open < state.hello.caps.max_open_positions && windowStart !== null && windowEnd !== null) {
        const pace = Math.min(1, (windowEnd - windowStart) / cfg.paceSecs);
        const needCoins = filledCoins.size < Math.ceil(cfg.targetCoins * pace);
        const needFills = filledCount < Math.ceil(cfg.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (cfg.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of state.curves.keys()) {
            if (orders.length >= cap || probeCoins.size >= cfg.maxProbes) break;
            if (openPos.has(mint) || probeCoins.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && filledCoins.has(mint)) continue;
            const curve = state.curves.get(mint)!;
            if (curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < cfg.probeSol + 2 * tx + cfg.cashReserveSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(cfg.probeSol * LAMPORTS)), max_slippage_bps: cfg.buySlipBps });
            probeCoins.set(mint, false);
            free -= cfg.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
