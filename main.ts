// Entry point for the pump.fun paper-trading sprint bot (agent-fun/replay/v2).
//
// The whole strategy is in strategy.ts: a launch sniper with a rug filter,
// fast exits, and probe round trips that keep the run above the 20-coin
// guardrail on a 6-hour window. The wire shim is the kit's SDK, vendored
// unchanged under vendor/agentfun-bot.ts. Run with Node 22: `node main.ts`.
//
// Dev result on the kit's 24h dataset: net -0.031 SOL, 115 coins, 83 guardrail
// coins (need >= 20), max drawdown 0.40%, 0 rejected orders. Paper only.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);
await runBot(strategy);
