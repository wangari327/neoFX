require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { DerivDigitBot, roundMoney } = require('./bot');
const { createRunStore } = require('./run-store');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket']
});

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const RUN_HISTORY_LIMIT = 12;
const GROWTH_STAIR_MODES = {
  OFF: 'off',
  PROFIT: 'profit',
  LOSS_PRESSURE: 'loss_pressure'
};
const DIGIT_STRATEGY_MODES = {
  BASE: 'base',
  EXTREME: 'extreme_over_under',
  MATCH_SNIPER: 'match_sniper'
};
const TARGET_SIZING_MODES = {
  PHASED: 'phased',
  BOLD: 'bold'
};
const AUTO_RISK_PROFILES = {
  SAFE: 'safe',
  BALANCED: 'balanced',
  AGGRESSIVE: 'aggressive',
  INSANE_DEMO: 'insane_demo'
};

function configuredMongoUrl() {
  return String(process.env.MONGODB_URL || process.env.MONGO_URL || '').trim();
}

let runStore = createRunStore({
  mongoUrl: configuredMongoUrl(),
  dbName: process.env.MONGODB_DB || process.env.MONGO_DB || 'deriv_digit_bot'
});
let persistenceBackend = configuredMongoUrl() ? 'mongo' : 'memory';
let activeBot = null;
let activeRun = null;
let recentRunsCache = [];
let bootError = null;

function persistenceHint(error) {
  const message = String(error && error.message ? error.message : error || '');
  if (/SSL routines:.*alert internal error|SSL alert number 80|tlsv1 alert internal error/i.test(message)) {
    return 'MongoDB TLS handshake failed. If this is Atlas, check the IP access list and make sure Heroku is allowed to reach the cluster. Heroku dyno IPs are dynamic, so Atlas often needs a broad allowlist during testing.';
  }
  if (/authentication failed|bad auth|not authorized/i.test(message)) {
    return 'MongoDB authentication failed. Double-check the database username, password, and that the password is URL-encoded in the connection string.';
  }
  if (/server selection timed out|getaddrinfo ENOTFOUND|ENOTFOUND/i.test(message)) {
    return 'MongoDB could not be reached. Check the hostname, DNS, and whether the database host is publicly reachable from Heroku.';
  }
  return message;
}

function boolFrom(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function numberFrom(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeGrowthStairMode(value, legacyEnabled = false) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['loss', 'loss_pressure', 'loss_stairs', 'reverse', 'reverse_stairs'].includes(normalized)) {
    return GROWTH_STAIR_MODES.LOSS_PRESSURE;
  }
  if (['profit', 'profit_stairs', 'growth', 'on', 'true', '1'].includes(normalized)) {
    return GROWTH_STAIR_MODES.PROFIT;
  }
  if (['off', 'none', 'false', '0'].includes(normalized)) {
    return GROWTH_STAIR_MODES.OFF;
  }
  return legacyEnabled ? GROWTH_STAIR_MODES.PROFIT : GROWTH_STAIR_MODES.OFF;
}

function normalizeDigitStrategyMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['extreme', 'extreme_over_under', 'over_under_extreme', 'high_payout'].includes(normalized)) {
    return DIGIT_STRATEGY_MODES.EXTREME;
  }
  if (['match', 'matches', 'match_sniper', 'digit_match', 'digit_match_sniper'].includes(normalized)) {
    return DIGIT_STRATEGY_MODES.MATCH_SNIPER;
  }
  return DIGIT_STRATEGY_MODES.BASE;
}

function normalizeTargetSizingMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['bold', 'bold_target', 'target', 'target_sizing', 'goal', 'one_shot'].includes(normalized)) {
    return TARGET_SIZING_MODES.BOLD;
  }
  return TARGET_SIZING_MODES.PHASED;
}

function normalizeAutoRiskProfile(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['safe', 'conservative', 'low'].includes(normalized)) return AUTO_RISK_PROFILES.SAFE;
  if (['aggressive', 'high'].includes(normalized)) return AUTO_RISK_PROFILES.AGGRESSIVE;
  if (['insane', 'insane_demo', 'demo_insane', 'max', 'degen'].includes(normalized)) return AUTO_RISK_PROFILES.INSANE_DEMO;
  return AUTO_RISK_PROFILES.BALANCED;
}

function normalizeSymbol(value, fallback = 'R_100') {
  const symbol = String(value || '').trim().toUpperCase();
  if (['R_10', 'R_100'].includes(symbol)) return symbol;
  return fallback;
}

function optionalNumberFrom(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeMilestoneList(value, fallback = [0.25, 0.5, 0.75]) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? '')
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);

  const parsed = source
    .map((item) => {
      const numeric = Number(item);
      if (!Number.isFinite(numeric)) return null;
      return Math.min(Math.max(numeric > 1 || numeric < -1 ? numeric / 100 : numeric, -1), 1);
    })
    .filter((item) => item !== null);

  if (!parsed.length) return fallback.slice();

  const deduped = [];
  for (const milestone of parsed) {
    if (!deduped.some((item) => Math.abs(item - milestone) < 1e-9)) {
      deduped.push(milestone);
    }
  }

  return deduped.sort((a, b) => a - b);
}

function blindSniperLimit(milestones) {
  return Math.max(1, Array.isArray(milestones) ? milestones.length : 0);
}

function goalCalibrationFrom(seed, target) {
  const resolvedSeed = roundMoney(numberFrom(seed, 10));
  const resolvedTarget = roundMoney(numberFrom(target, resolvedSeed + 40));
  const gap = Math.max(0, resolvedTarget - resolvedSeed);
  const gapRatio = gap / Math.max(0.01, resolvedSeed);
  const compact = gapRatio <= 0.25;

  return {
    compact,
    label: compact ? 'compact' : 'standard',
    gap,
    gapRatio
  };
}

function basicAuthValid(headers) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true;

  const header = headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const user = separator >= 0 ? decoded.slice(0, separator) : '';
  const pass = separator >= 0 ? decoded.slice(separator + 1) : '';

  return user === (process.env.DASHBOARD_USER || 'admin') && pass === password;
}

function requireBasicAuth(req, res, next) {
  if (basicAuthValid(req.headers)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Deriv Digit Bot"');
  res.status(401).send('Authentication required');
}

function publicConfig() {
  const blindSniperStartRatio = numberFrom(process.env.BLIND_SNIPER_START_RATIO, 0.75);
  const growthStairMode = normalizeGrowthStairMode(
    process.env.GROWTH_STAIR_MODE,
    boolFrom(process.env.GROWTH_STAIRS_ENABLED, false)
  );
  const blindSniperMilestones = normalizeMilestoneList(
    process.env.BLIND_SNIPER_MILESTONES,
    [0.25, 0.5, blindSniperStartRatio]
  );

  return {
    defaultMode: process.env.DEFAULT_MODE || 'demo',
    defaultSymbol: normalizeSymbol(process.env.SYMBOL, 'R_100'),
    digitStrategyMode: normalizeDigitStrategyMode(process.env.DIGIT_STRATEGY_MODE),
    targetSizingMode: normalizeTargetSizingMode(process.env.TARGET_SIZING_MODE),
    invertDigitSignal: boolFrom(process.env.INVERT_DIGIT_SIGNAL, false),
    autoModeEnabled: boolFrom(process.env.AUTO_MODE_ENABLED, false),
    autoCycleMode: boolFrom(process.env.AUTO_CYCLE_MODE, true),
    autoCycleProfit: optionalNumberFrom(process.env.AUTO_CYCLE_PROFIT, null),
    autoCycleStake: optionalNumberFrom(process.env.AUTO_CYCLE_STAKE, null),
    autoCyclePartialExitTradeThreshold: numberFrom(process.env.AUTO_CYCLE_PARTIAL_EXIT_TRADE_THRESHOLD, 60),
    autoCyclePartialExitProfitRatio: numberFrom(process.env.AUTO_CYCLE_PARTIAL_EXIT_PROFIT_RATIO, 0.5),
    autoCycleRecycleTradeThreshold: numberFrom(process.env.AUTO_CYCLE_RECYCLE_TRADE_THRESHOLD, 100),
    autoRiskProfile: normalizeAutoRiskProfile(process.env.AUTO_RISK_PROFILE),
    autoReviewIntervalTrades: numberFrom(process.env.AUTO_REVIEW_INTERVAL_TRADES, 5),
    matchSniperCooldownTrades: numberFrom(process.env.MATCH_SNIPER_COOLDOWN_TRADES, 3),
    matchSniperMaxCount: numberFrom(process.env.MATCH_SNIPER_MAX_COUNT, 1),
    minStake: numberFrom(process.env.MIN_STAKE, 0.35),
    windowSize: numberFrom(process.env.WINDOW_SIZE, 20),
    guideFilters: boolFrom(process.env.GUIDE_FILTERS, false),
    strictBarFilters: boolFrom(process.env.STRICT_BAR_FILTERS, false),
    growthMilestonePercent: numberFrom(process.env.GROWTH_MILESTONE_PERCENT, 0.025),
    growthStakeBumpPercent: numberFrom(process.env.GROWTH_STAKE_BUMP_PERCENT, 0.15),
    growthStakeCapPercent: numberFrom(process.env.GROWTH_STAKE_CAP_PERCENT, 0.12),
    growthStairMode,
    growthStairsEnabled: growthStairMode !== GROWTH_STAIR_MODES.OFF,
    lossStairMaxTier: numberFrom(process.env.LOSS_STAIR_MAX_TIER, 3),
    lossStairWinResetCount: numberFrom(process.env.LOSS_STAIR_WIN_RESET_COUNT, 2),
    lossStairDebtCapPercent: numberFrom(process.env.LOSS_STAIR_DEBT_CAP_PERCENT, 0.18),
    profitGatePercent: numberFrom(process.env.PROFIT_GATE_PERCENT, 0.08),
    profitAggression: clamp(numberFrom(process.env.PROFIT_AGGRESSION, 2), 1, 5),
    recoveryBufferPercent: numberFrom(process.env.RECOVERY_BUFFER_PERCENT, 0.05),
    initialStake: optionalNumberFrom(process.env.INITIAL_STAKE, null),
    blindSniperEnabled: boolFrom(process.env.BLIND_SNIPER_ENABLED, false),
    blindSniperCadenceTrades: numberFrom(process.env.BLIND_SNIPER_CADENCE_TRADES, 3),
    blindSniperStartRatio: blindSniperMilestones[blindSniperMilestones.length - 1] ?? blindSniperStartRatio,
    blindSniperMilestones,
    blindSniperMaxUses: Math.max(1, blindSniperMilestones.length),
    blindSniperStakeFraction: numberFrom(process.env.BLIND_SNIPER_STAKE_FRACTION, 1 / 3),
    hasEnvToken: Boolean(
      process.env.DERIV_API_TOKEN ||
      process.env.DERIV_DEMO_API_TOKEN ||
      process.env.DERIV_REAL_API_TOKEN
    ),
    persistenceBackend
  };
}

function resolveToken(overrideToken) {
  return String(
    overrideToken ||
    process.env.DERIV_API_TOKEN ||
    process.env.DERIV_DEMO_API_TOKEN ||
    process.env.DERIV_REAL_API_TOKEN ||
    ''
  ).trim();
}

function sanitizeStartPayload(payload = {}) {
  const seed = roundMoney(numberFrom(payload.seed, 10));
  const target = roundMoney(numberFrom(payload.target, 50));
  const mode = payload.mode === 'real' ? 'real' : 'demo';
  const token = resolveToken(payload.token);
  const accountId = String(payload.accountId || process.env.DERIV_ACCOUNT_ID || '').trim();
  const appId = String(process.env.DERIV_APP_ID || '').trim();
  const apiBaseUrl = String(process.env.DERIV_API_BASE_URL || 'https://api.derivws.com').trim();
  const envStartRatio = numberFrom(process.env.BLIND_SNIPER_START_RATIO, 0.75);
  const envGrowthStairMode = normalizeGrowthStairMode(
    process.env.GROWTH_STAIR_MODE,
    boolFrom(process.env.GROWTH_STAIRS_ENABLED, false)
  );
  const growthStairMode = normalizeGrowthStairMode(
    payload.growthStairMode ?? payload.growthStairsMode,
    boolFrom(payload.growthStairsEnabled, envGrowthStairMode !== GROWTH_STAIR_MODES.OFF)
  );
  const defaultBlindSniperMilestones = normalizeMilestoneList(
    process.env.BLIND_SNIPER_MILESTONES,
    [0.25, 0.5, envStartRatio]
  );
  const payloadStartRatio = numberFrom(payload.blindSniperStartRatio, envStartRatio);
  const blindSniperMilestones = normalizeMilestoneList(
    payload.blindSniperMilestones ?? payload.blindSniperMarks,
    defaultBlindSniperMilestones.length ? defaultBlindSniperMilestones : [0.25, 0.5, payloadStartRatio]
  );
  const blindSniperStartRatio = blindSniperMilestones[blindSniperMilestones.length - 1] ?? payloadStartRatio;

  if (seed < 1) throw new Error('Seed must be at least 1.00.');
  if (target <= seed) throw new Error('Target must be greater than seed.');
  if (!token) throw new Error('A Deriv API token is required.');
  if (!appId || appId === '1089') {
    throw new Error(
      'DERIV_APP_ID is required. Register a new PAT application on developers.deriv.com and use its App ID. ' +
      'The legacy 1089 App ID does not work with the current API.'
    );
  }

  return {
    mode,
    token,
    accountId,
    apiBaseUrl,
    appId,
    seed,
    target,
    symbol: normalizeSymbol(payload.symbol, normalizeSymbol(process.env.SYMBOL, 'R_100')),
    currency: process.env.CURRENCY || 'USD',
    minStake: numberFrom(process.env.MIN_STAKE, 0.35),
    baseStakePercent: numberFrom(process.env.BASE_STAKE_PERCENT, 0.02),
    riskyStakePercent: numberFrom(process.env.RISKY_STAKE_PERCENT, 0.35),
    martingaleCapPercent: numberFrom(process.env.MARTINGALE_CAP_PERCENT, 0.4),
    allInLossStreakThreshold: numberFrom(payload.allInLossStreakThreshold, numberFrom(process.env.ALL_IN_LOSS_STREAK_THRESHOLD, 3)),
    allInStakePercent: numberFrom(payload.allInStakePercent, numberFrom(process.env.ALL_IN_STAKE_PERCENT, 0.25)),
    growthMilestonePercent: numberFrom(process.env.GROWTH_MILESTONE_PERCENT, 0.025),
    growthStakeBumpPercent: numberFrom(process.env.GROWTH_STAKE_BUMP_PERCENT, 0.15),
    growthStakeCapPercent: numberFrom(process.env.GROWTH_STAKE_CAP_PERCENT, 0.12),
    growthStairMode,
    growthStairsEnabled: growthStairMode !== GROWTH_STAIR_MODES.OFF,
    lossStairMaxTier: numberFrom(payload.lossStairMaxTier, numberFrom(process.env.LOSS_STAIR_MAX_TIER, 3)),
    lossStairWinResetCount: numberFrom(payload.lossStairWinResetCount, numberFrom(process.env.LOSS_STAIR_WIN_RESET_COUNT, 2)),
    lossStairDebtCapPercent: numberFrom(payload.lossStairDebtCapPercent, numberFrom(process.env.LOSS_STAIR_DEBT_CAP_PERCENT, 0.18)),
    profitGatePercent: numberFrom(process.env.PROFIT_GATE_PERCENT, 0.08),
    profitAggression: clamp(numberFrom(payload.profitAggression, numberFrom(process.env.PROFIT_AGGRESSION, 2)), 1, 5),
    autoModeEnabled: boolFrom(payload.autoModeEnabled, boolFrom(process.env.AUTO_MODE_ENABLED, false)),
    autoCycleMode: boolFrom(payload.autoCycleMode, boolFrom(process.env.AUTO_CYCLE_MODE, true)),
    autoCycleProfit: optionalNumberFrom(payload.autoCycleProfit, optionalNumberFrom(process.env.AUTO_CYCLE_PROFIT, null)),
    autoCycleStake: optionalNumberFrom(payload.autoCycleStake, optionalNumberFrom(process.env.AUTO_CYCLE_STAKE, null)),
    autoCyclePartialExitTradeThreshold: numberFrom(payload.autoCyclePartialExitTradeThreshold, numberFrom(process.env.AUTO_CYCLE_PARTIAL_EXIT_TRADE_THRESHOLD, 60)),
    autoCyclePartialExitProfitRatio: numberFrom(payload.autoCyclePartialExitProfitRatio, numberFrom(process.env.AUTO_CYCLE_PARTIAL_EXIT_PROFIT_RATIO, 0.5)),
    autoCycleRecycleTradeThreshold: numberFrom(payload.autoCycleRecycleTradeThreshold, numberFrom(process.env.AUTO_CYCLE_RECYCLE_TRADE_THRESHOLD, 100)),
    autoRiskProfile: normalizeAutoRiskProfile(payload.autoRiskProfile ?? process.env.AUTO_RISK_PROFILE),
    autoReviewIntervalTrades: numberFrom(payload.autoReviewIntervalTrades, numberFrom(process.env.AUTO_REVIEW_INTERVAL_TRADES, 5)),
    targetSizingMode: normalizeTargetSizingMode(payload.targetSizingMode ?? process.env.TARGET_SIZING_MODE),
    digitStrategyMode: normalizeDigitStrategyMode(payload.digitStrategyMode ?? process.env.DIGIT_STRATEGY_MODE),
    invertDigitSignal: boolFrom(payload.invertDigitSignal, boolFrom(process.env.INVERT_DIGIT_SIGNAL, false)),
    matchSniperCooldownTrades: numberFrom(payload.matchSniperCooldownTrades, numberFrom(process.env.MATCH_SNIPER_COOLDOWN_TRADES, 3)),
    matchSniperMaxCount: numberFrom(payload.matchSniperMaxCount, numberFrom(process.env.MATCH_SNIPER_MAX_COUNT, 1)),
    recoveryBufferPercent: numberFrom(process.env.RECOVERY_BUFFER_PERCENT, 0.05),
    initialStake: optionalNumberFrom(payload.initialStake, optionalNumberFrom(process.env.INITIAL_STAKE, null)),
    windowSize: numberFrom(process.env.WINDOW_SIZE, 20),
    guideFilters: boolFrom(payload.guideFilters, boolFrom(process.env.GUIDE_FILTERS, false)),
    strictBarFilters: boolFrom(payload.strictBarFilters, boolFrom(process.env.STRICT_BAR_FILTERS, false)),
    blindSniperEnabled: boolFrom(payload.blindSniperEnabled, boolFrom(process.env.BLIND_SNIPER_ENABLED, false)),
    blindSniperCadenceTrades: numberFrom(payload.blindSniperCadenceTrades, numberFrom(process.env.BLIND_SNIPER_CADENCE_TRADES, 3)),
    blindSniperMaxUses: blindSniperLimit(blindSniperMilestones),
    blindSniperStartRatio,
    blindSniperMilestones,
    blindSniperStakeFraction: numberFrom(payload.blindSniperStakeFraction, numberFrom(process.env.BLIND_SNIPER_STAKE_FRACTION, 1 / 3))
  };
}

function summarizeRun(run, reason = run?.reason || 'manual') {
  if (!run) return null;

  const snapshot = run.snapshot || {};
  const seed = roundMoney(numberFrom(run.seed ?? run.config?.seed ?? snapshot.seed ?? snapshot.balance ?? 10, 10));
  const target = roundMoney(numberFrom(run.target ?? run.config?.target ?? seed, seed));
  const calibration = goalCalibrationFrom(seed, target);
  const finalBalance = roundMoney(numberFrom(snapshot.balance ?? run.balance ?? seed, seed));
  const totalTrades = Number(snapshot.totalTrades ?? run.totalTrades ?? 0);
  const wins = Number(snapshot.wins ?? run.wins ?? 0);
  const losses = Number(snapshot.losses ?? run.losses ?? 0);
  const winRate = totalTrades ? roundMoney((wins / totalTrades) * 100) : 0;
  const autoCycleMode = Boolean(snapshot.autoCycleMode ?? run.autoCycleMode ?? run.config?.autoCycleMode ?? false);
  const autoCycleBankedProfit = Number(snapshot.autoCycleBankedProfit ?? run.autoCycleBankedProfit ?? 0);
  const netProfit = autoCycleMode
    ? roundMoney(Number(snapshot.netProfitLoss ?? run.netProfitLoss ?? autoCycleBankedProfit + finalBalance - seed))
    : roundMoney(finalBalance - seed);
  const realizedProfit = autoCycleMode
    ? roundMoney(Number(snapshot.profitLoss ?? run.profitLoss ?? autoCycleBankedProfit))
    : netProfit;
  const summarizedFinalBalance = roundMoney(seed + netProfit);

  return {
    reason,
    startedAt: run.startedAt || snapshot.startedAt || null,
    stoppedAt: new Date().toISOString(),
    mode: run.mode || run.config?.mode || 'demo',
    accountId: run.accountId || run.config?.accountId || null,
    accountKind: snapshot.accountKind || run.accountKind || null,
    symbol: normalizeSymbol(snapshot.symbol ?? run.symbol ?? run.config?.symbol, 'R_100'),
    digitStrategyMode: normalizeDigitStrategyMode(snapshot.digitStrategyMode ?? run.digitStrategyMode ?? run.config?.digitStrategyMode),
    targetSizingMode: normalizeTargetSizingMode(snapshot.targetSizingMode ?? run.targetSizingMode ?? run.config?.targetSizingMode),
    invertDigitSignal: Boolean(snapshot.invertDigitSignal ?? run.invertDigitSignal ?? run.config?.invertDigitSignal ?? false),
    autoModeEnabled: Boolean(snapshot.autoModeEnabled ?? run.autoModeEnabled ?? run.config?.autoModeEnabled ?? false),
    autoCycleMode,
    autoCycleProfit: Number(snapshot.autoCycleProfit ?? run.autoCycleProfit ?? run.config?.autoCycleProfit ?? 0),
    autoCycleStake: Number(snapshot.autoCycleStake ?? run.autoCycleStake ?? run.config?.autoCycleStake ?? 0),
    autoCycleBankedProfit,
    autoCycleCompleted: Number(snapshot.autoCycleCompleted ?? run.autoCycleCompleted ?? 0),
    autoCycleRecycled: Number(snapshot.autoCycleRecycled ?? run.autoCycleRecycled ?? 0),
    autoCyclePartialLocked: Number(snapshot.autoCyclePartialLocked ?? run.autoCyclePartialLocked ?? 0),
    autoCycleHardRecovery: Boolean(snapshot.autoCycleHardRecovery ?? run.autoCycleHardRecovery ?? false),
    autoCycleTrades: Number(snapshot.autoCycleTrades ?? run.autoCycleTrades ?? 0),
    autoCycleMinBalance: Number(snapshot.autoCycleMinBalance ?? run.autoCycleMinBalance ?? seed),
    autoCycleStruggled: Boolean(snapshot.autoCycleStruggled ?? run.autoCycleStruggled ?? false),
    autoCyclePartialExitTradeThreshold: Number(snapshot.autoCyclePartialExitTradeThreshold ?? run.autoCyclePartialExitTradeThreshold ?? 60),
    autoCyclePartialExitProfitRatio: Number(snapshot.autoCyclePartialExitProfitRatio ?? run.autoCyclePartialExitProfitRatio ?? 0.5),
    autoCycleRecycleTradeThreshold: Number(snapshot.autoCycleRecycleTradeThreshold ?? run.autoCycleRecycleTradeThreshold ?? 100),
    strategyTarget: Number(snapshot.strategyTarget ?? run.strategyTarget ?? target),
    autoRiskProfile: normalizeAutoRiskProfile(snapshot.autoRiskProfile ?? run.autoRiskProfile ?? run.config?.autoRiskProfile),
    autoState: snapshot.autoState ?? run.autoState ?? null,
    autoReason: snapshot.autoReason ?? run.autoReason ?? '',
    autoDecision: snapshot.autoDecision ?? run.autoDecision ?? null,
    autoReviewIntervalTrades: Number(snapshot.autoReviewIntervalTrades ?? run.autoReviewIntervalTrades ?? run.config?.autoReviewIntervalTrades ?? 5),
    autoLastReviewTrade: Number(snapshot.autoLastReviewTrade ?? run.autoLastReviewTrade ?? -1),
    recentResults: Array.isArray(snapshot.recentResults) ? snapshot.recentResults.slice(-20) : [],
    matchSniperCooldownUntilTrade: Number(snapshot.matchSniperCooldownUntilTrade ?? run.matchSniperCooldownUntilTrade ?? 0),
    matchSniperCooldownTrades: Number(snapshot.matchSniperCooldownTrades ?? run.matchSniperCooldownTrades ?? run.config?.matchSniperCooldownTrades ?? 3),
    matchSniperMaxCount: Number(snapshot.matchSniperMaxCount ?? run.matchSniperMaxCount ?? run.config?.matchSniperMaxCount ?? 1),
    riskFloor: Number(snapshot.riskFloor ?? run.riskFloor ?? seed),
    recoveryDebt: Number(snapshot.recoveryDebt ?? run.recoveryDebt ?? 0),
    growthTier: Number(run.growthTier ?? 0),
    growthStep: Number(run.growthStep ?? 0),
    growthFloor: Number(run.growthFloor ?? 0),
    gateStep: Number(run.gateStep ?? 0),
    growthStairMode: normalizeGrowthStairMode(
      snapshot.growthStairMode ?? run.growthStairMode ?? run.config?.growthStairMode,
      Boolean(snapshot.growthStairsEnabled ?? run.growthStairsEnabled ?? run.config?.growthStairsEnabled ?? false)
    ),
    growthStairsEnabled: normalizeGrowthStairMode(
      snapshot.growthStairMode ?? run.growthStairMode ?? run.config?.growthStairMode,
      Boolean(snapshot.growthStairsEnabled ?? run.growthStairsEnabled ?? run.config?.growthStairsEnabled ?? false)
    ) !== GROWTH_STAIR_MODES.OFF,
    growthLossStairTier: Number(snapshot.growthLossStairTier ?? run.growthLossStairTier ?? 0),
    growthLossWinStreak: Number(snapshot.growthLossWinStreak ?? run.growthLossWinStreak ?? 0),
    lossStairMaxTier: Number(snapshot.lossStairMaxTier ?? run.lossStairMaxTier ?? run.config?.lossStairMaxTier ?? 3),
    lossStairWinResetCount: Number(snapshot.lossStairWinResetCount ?? run.lossStairWinResetCount ?? run.config?.lossStairWinResetCount ?? 2),
    lossStairDebtCapPercent: Number(snapshot.lossStairDebtCapPercent ?? run.lossStairDebtCapPercent ?? run.config?.lossStairDebtCapPercent ?? 0.18),
    initialStake: snapshot.initialStake ?? run.initialStake ?? run.config?.initialStake ?? null,
    initialStakeUsed: Boolean(snapshot.initialStakeUsed ?? run.initialStakeUsed ?? run.config?.initialStakeUsed ?? false),
    martingaleLossStreak: Number(snapshot.martingaleLossStreak ?? run.martingaleLossStreak ?? 0),
    martingaleRetryLimit: Number(snapshot.martingaleRetryLimit ?? run.martingaleRetryLimit ?? 2),
    emergencyAllInUsed: Boolean(snapshot.emergencyAllInUsed ?? run.emergencyAllInUsed ?? false),
    splitRecoveryArmed: Boolean(snapshot.splitRecoveryArmed ?? run.splitRecoveryArmed ?? run.config?.splitRecoveryArmed ?? false),
    splitRecoveryReadyAtTrade: Number(snapshot.splitRecoveryReadyAtTrade ?? run.splitRecoveryReadyAtTrade ?? 0),
    splitRecoveryPiecesRemaining: Number(snapshot.splitRecoveryPiecesRemaining ?? run.splitRecoveryPiecesRemaining ?? 0),
    splitRecoveryCooldownTrades: Number(snapshot.splitRecoveryCooldownTrades ?? run.splitRecoveryCooldownTrades ?? 3),
    splitRecoveryPieces: Number(snapshot.splitRecoveryPieces ?? run.splitRecoveryPieces ?? 2),
    splitRecoveryCapPercent: Number(snapshot.splitRecoveryCapPercent ?? run.splitRecoveryCapPercent ?? 0.22),
    goalMode: snapshot.goalMode ?? run.goalMode ?? calibration.label,
    boldTargetStake: Number(snapshot.boldTargetStake ?? run.boldTargetStake ?? 0),
    goalGap: Number(snapshot.goalGap ?? run.goalGap ?? calibration.gap),
    goalGapRatio: Number(snapshot.goalGapRatio ?? run.goalGapRatio ?? calibration.gapRatio),
    profitAggression: Number(snapshot.profitAggression ?? run.profitAggression ?? run.config?.profitAggression ?? 2),
    profitPushArmed: Boolean(snapshot.profitPushArmed ?? run.profitPushArmed ?? false),
    profitPushReason: snapshot.profitPushReason ?? run.profitPushReason ?? null,
    profitPushStake: Number(snapshot.profitPushStake ?? run.profitPushStake ?? 0),
    profitPushStartRatio: Number(snapshot.profitPushStartRatio ?? run.profitPushStartRatio ?? 0),
    profitPushCapPercent: Number(snapshot.profitPushCapPercent ?? run.profitPushCapPercent ?? 0),
    estimatedWinProfitRatio: Number(snapshot.estimatedWinProfitRatio ?? run.estimatedWinProfitRatio ?? snapshot.lastWinProfitRatio ?? 0.22),
    lastProposalProfitRatio: Number(snapshot.lastProposalProfitRatio ?? run.lastProposalProfitRatio ?? 0.22),
    tradeCooldownUntil: Number(snapshot.tradeCooldownUntil ?? run.tradeCooldownUntil ?? 0),
    tradeCooldownReason: snapshot.tradeCooldownReason ?? run.tradeCooldownReason ?? null,
    tradeCooldownDetail: snapshot.tradeCooldownDetail ?? run.tradeCooldownDetail ?? null,
    totalTrades,
    wins,
    losses,
    winRate,
    startingBalance: seed,
    finalBalance: summarizedFinalBalance,
    activeCycleBalance: autoCycleMode ? finalBalance : null,
    realizedProfit,
    netProfit,
    target,
    blindSniperEnabled: Boolean(snapshot.blindSniperEnabled ?? run.blindSniperEnabled ?? run.config?.blindSniperEnabled ?? false),
    blindSniperUses: Number(snapshot.blindSniperUses ?? run.blindSniperUses ?? run.config?.blindSniperUses ?? 0),
    blindSniperMilestones: normalizeMilestoneList(
      snapshot.blindSniperMilestones ?? run.blindSniperMilestones ?? run.config?.blindSniperMilestones ?? null,
      [0.25, 0.5, Number(snapshot.blindSniperStartRatio ?? run.blindSniperStartRatio ?? run.config?.blindSniperStartRatio ?? 0.75)]
    ),
    blindSniperMaxUses: blindSniperLimit(
      normalizeMilestoneList(
        snapshot.blindSniperMilestones ?? run.blindSniperMilestones ?? run.config?.blindSniperMilestones ?? null,
        [0.25, 0.5, Number(snapshot.blindSniperStartRatio ?? run.blindSniperStartRatio ?? run.config?.blindSniperStartRatio ?? 0.75)]
      )
    ),
    blindSniperProgress: Math.max(
      -1,
      Math.min(
        1,
        (finalBalance - seed) /
          Math.max(0.01, Number(run.target ?? run.config?.target ?? seed) - seed)
      )
    ),
    blindSniperNextMilestone: snapshot.blindSniperNextMilestone ?? run.blindSniperNextMilestone ?? null
  };
}

function buildRunPatch(bot, runDoc, extra = {}) {
  const snapshot = bot ? bot.snapshot() : runDoc?.snapshot || null;
  const seed = roundMoney(numberFrom(runDoc?.seed ?? runDoc?.config?.seed ?? snapshot?.balance ?? 10, 10));
  const target = roundMoney(numberFrom(runDoc?.target ?? runDoc?.config?.target ?? seed, seed));
  const calibration = goalCalibrationFrom(seed, target);

  return {
    snapshot,
    balance: snapshot ? snapshot.balance : runDoc?.balance ?? null,
    accountBalance: snapshot ? snapshot.accountBalance : runDoc?.accountBalance ?? null,
    accountKind: snapshot ? snapshot.accountKind : runDoc?.accountKind ?? null,
    symbol: normalizeSymbol(snapshot?.symbol ?? runDoc?.symbol ?? runDoc?.config?.symbol, 'R_100'),
    digitStrategyMode: normalizeDigitStrategyMode(snapshot?.digitStrategyMode ?? runDoc?.digitStrategyMode ?? runDoc?.config?.digitStrategyMode),
    targetSizingMode: normalizeTargetSizingMode(snapshot?.targetSizingMode ?? runDoc?.targetSizingMode ?? runDoc?.config?.targetSizingMode),
    invertDigitSignal: Boolean(snapshot?.invertDigitSignal ?? runDoc?.invertDigitSignal ?? runDoc?.config?.invertDigitSignal ?? false),
    autoModeEnabled: Boolean(snapshot?.autoModeEnabled ?? runDoc?.autoModeEnabled ?? runDoc?.config?.autoModeEnabled ?? false),
    autoRiskProfile: normalizeAutoRiskProfile(snapshot?.autoRiskProfile ?? runDoc?.autoRiskProfile ?? runDoc?.config?.autoRiskProfile),
    autoState: snapshot?.autoState ?? runDoc?.autoState ?? null,
    autoReason: snapshot?.autoReason ?? runDoc?.autoReason ?? '',
    autoDecision: snapshot?.autoDecision ?? runDoc?.autoDecision ?? null,
    autoReviewIntervalTrades: Number(snapshot?.autoReviewIntervalTrades ?? runDoc?.autoReviewIntervalTrades ?? runDoc?.config?.autoReviewIntervalTrades ?? 5),
    autoLastReviewTrade: Number(snapshot?.autoLastReviewTrade ?? runDoc?.autoLastReviewTrade ?? -1),
    recentResults: Array.isArray(snapshot?.recentResults) ? snapshot.recentResults.slice(-20) : [],
    matchSniperCooldownUntilTrade: Number(snapshot?.matchSniperCooldownUntilTrade ?? runDoc?.matchSniperCooldownUntilTrade ?? 0),
    matchSniperCooldownTrades: Number(snapshot?.matchSniperCooldownTrades ?? runDoc?.matchSniperCooldownTrades ?? runDoc?.config?.matchSniperCooldownTrades ?? 3),
    matchSniperMaxCount: Number(snapshot?.matchSniperMaxCount ?? runDoc?.matchSniperMaxCount ?? runDoc?.config?.matchSniperMaxCount ?? 1),
    phase: snapshot ? snapshot.phase : runDoc?.phase ?? null,
    riskFloor: snapshot ? snapshot.riskFloor : runDoc?.riskFloor ?? null,
    recoveryDebt: snapshot ? snapshot.recoveryDebt : runDoc?.recoveryDebt ?? null,
    totalTrades: snapshot ? snapshot.totalTrades : runDoc?.totalTrades ?? 0,
    wins: snapshot ? snapshot.wins : runDoc?.wins ?? 0,
    losses: snapshot ? snapshot.losses : runDoc?.losses ?? 0,
    winRate: bot ? bot.winRate() : runDoc?.winRate ?? 0,
    growthTier: bot ? bot.growthTier() : runDoc?.growthTier ?? 0,
    growthStep: bot ? bot.growthMilestoneStep() : runDoc?.growthStep ?? 0,
    growthFloor: bot ? bot.growthStakeFloor() : runDoc?.growthFloor ?? 0,
    growthStairMode: normalizeGrowthStairMode(
      snapshot?.growthStairMode ?? runDoc?.growthStairMode ?? runDoc?.config?.growthStairMode,
      Boolean(snapshot?.growthStairsEnabled ?? runDoc?.growthStairsEnabled ?? runDoc?.config?.growthStairsEnabled ?? false)
    ),
    growthStairsEnabled: normalizeGrowthStairMode(
      snapshot?.growthStairMode ?? runDoc?.growthStairMode ?? runDoc?.config?.growthStairMode,
      Boolean(snapshot?.growthStairsEnabled ?? runDoc?.growthStairsEnabled ?? runDoc?.config?.growthStairsEnabled ?? false)
    ) !== GROWTH_STAIR_MODES.OFF,
    growthLossStairTier: Number(snapshot?.growthLossStairTier ?? runDoc?.growthLossStairTier ?? 0),
    growthLossWinStreak: Number(snapshot?.growthLossWinStreak ?? runDoc?.growthLossWinStreak ?? 0),
    lossStairMaxTier: Number(snapshot?.lossStairMaxTier ?? runDoc?.lossStairMaxTier ?? runDoc?.config?.lossStairMaxTier ?? 3),
    lossStairWinResetCount: Number(snapshot?.lossStairWinResetCount ?? runDoc?.lossStairWinResetCount ?? runDoc?.config?.lossStairWinResetCount ?? 2),
    lossStairDebtCapPercent: Number(snapshot?.lossStairDebtCapPercent ?? runDoc?.lossStairDebtCapPercent ?? runDoc?.config?.lossStairDebtCapPercent ?? 0.18),
    gateStep: bot ? bot.profitGateStep() : runDoc?.gateStep ?? 0,
    goalMode: snapshot?.goalMode ?? runDoc?.goalMode ?? calibration.label,
    boldTargetStake: Number(snapshot?.boldTargetStake ?? runDoc?.boldTargetStake ?? 0),
    goalGap: Number(snapshot?.goalGap ?? runDoc?.goalGap ?? calibration.gap),
    goalGapRatio: Number(snapshot?.goalGapRatio ?? runDoc?.goalGapRatio ?? calibration.gapRatio),
    profitAggression: Number(snapshot?.profitAggression ?? runDoc?.profitAggression ?? runDoc?.config?.profitAggression ?? 2),
    profitPushArmed: Boolean(snapshot?.profitPushArmed ?? runDoc?.profitPushArmed ?? false),
    profitPushReason: snapshot?.profitPushReason ?? runDoc?.profitPushReason ?? null,
    profitPushStake: Number(snapshot?.profitPushStake ?? runDoc?.profitPushStake ?? 0),
    profitPushStartRatio: Number(snapshot?.profitPushStartRatio ?? runDoc?.profitPushStartRatio ?? 0),
    profitPushCapPercent: Number(snapshot?.profitPushCapPercent ?? runDoc?.profitPushCapPercent ?? 0),
    estimatedWinProfitRatio: Number(snapshot?.estimatedWinProfitRatio ?? runDoc?.estimatedWinProfitRatio ?? snapshot?.lastWinProfitRatio ?? 0.22),
    lastProposalProfitRatio: Number(snapshot?.lastProposalProfitRatio ?? runDoc?.lastProposalProfitRatio ?? 0.22),
    tradeCooldownUntil: snapshot?.tradeCooldownUntil ?? runDoc?.tradeCooldownUntil ?? 0,
    tradeCooldownReason: snapshot?.tradeCooldownReason ?? runDoc?.tradeCooldownReason ?? null,
    tradeCooldownDetail: snapshot?.tradeCooldownDetail ?? runDoc?.tradeCooldownDetail ?? null,
    emergencyAllInUsed: Boolean(snapshot?.emergencyAllInUsed ?? runDoc?.emergencyAllInUsed ?? false),
    updatedAt: new Date(),
    ...extra
  };
}

function upsertRecentRun(run) {
  if (!run) return;
  recentRunsCache = [run, ...recentRunsCache.filter((item) => item.id !== run.id)]
    .sort((a, b) => new Date(b.updatedAt || b.startedAt || 0) - new Date(a.updatedAt || a.startedAt || 0))
    .slice(0, RUN_HISTORY_LIMIT);
}

function latestPausedRun() {
  return recentRunsCache.find((run) => run.status === 'paused' && !(run.snapshot && run.snapshot.tradeInFlight)) || null;
}

function latestClosedRun() {
  return recentRunsCache.find((run) => !['running', 'starting', 'paused'].includes(run.status)) || null;
}

function buildSessionState() {
  const resumeRun = activeRun && activeRun.status === 'paused'
    ? activeRun
    : latestPausedRun();

  return {
    activeRun,
    resumeRun,
    lastClosedRun: latestClosedRun(),
    recentRuns: recentRunsCache,
    persistenceBackend,
    bootError,
    canStartNewRun: !activeRun,
    canPause: Boolean(activeBot && !activeBot.paused && !activeBot.stopped),
    canResume: Boolean(resumeRun)
  };
}

function runBalanceState(run) {
  if (!run) return null;

  const snapshot = run.snapshot || {};
  const seed = roundMoney(numberFrom(run.seed ?? run.config?.seed ?? snapshot.balance ?? 10, 10));
  const target = roundMoney(numberFrom(run.target ?? run.config?.target ?? seed + 40, seed + 40));
  const calibration = goalCalibrationFrom(seed, target);
  const balance = roundMoney(numberFrom(snapshot.balance ?? run.balance ?? seed, seed));
  const totalTrades = Number(snapshot.totalTrades ?? run.totalTrades ?? 0);
  const wins = Number(snapshot.wins ?? run.wins ?? 0);
  const losses = Number(snapshot.losses ?? run.losses ?? 0);
  const phase = snapshot.phase || run.phase || 'growth';
  const confidenceGateLocked = Boolean(snapshot.confidenceGateLocked ?? run.confidenceGateLocked ?? false);
  const confidenceGateWinRate = Number(snapshot.confidenceGateWinRate ?? run.confidenceGateWinRate ?? (totalTrades ? (wins / totalTrades) * 100 : 0));
  const confidenceGateTriggerWinRate = Number(snapshot.confidenceGateTriggerWinRate ?? run.confidenceGateTriggerWinRate ?? 81);
  const confidenceGateReleaseWinRate = Number(snapshot.confidenceGateReleaseWinRate ?? run.confidenceGateReleaseWinRate ?? 82);
  const blindSniperEnabled = Boolean(snapshot.blindSniperEnabled ?? run.blindSniperEnabled ?? run.config?.blindSniperEnabled ?? false);
  const blindSniperUses = Number(snapshot.blindSniperUses ?? run.blindSniperUses ?? run.config?.blindSniperUses ?? 0);
  const blindSniperCadenceTrades = Number(snapshot.blindSniperCadenceTrades ?? run.blindSniperCadenceTrades ?? run.config?.blindSniperCadenceTrades ?? 3);
  const blindSniperStartRatio = Number(snapshot.blindSniperStartRatio ?? run.blindSniperStartRatio ?? run.config?.blindSniperStartRatio ?? 0.75);
  const blindSniperMilestones = normalizeMilestoneList(
    snapshot.blindSniperMilestones ?? run.blindSniperMilestones ?? run.config?.blindSniperMilestones ?? null,
    [0.25, 0.5, blindSniperStartRatio]
  );
  const blindSniperMaxUses = blindSniperLimit(blindSniperMilestones);
  const blindSniperStakeFraction = Number(snapshot.blindSniperStakeFraction ?? run.blindSniperStakeFraction ?? run.config?.blindSniperStakeFraction ?? 1 / 3);
  const blindSniperTradesSinceLastShot = Number(snapshot.blindSniperTradesSinceLastShot ?? run.blindSniperTradesSinceLastShot ?? run.config?.blindSniperTradesSinceLastShot ?? 0);
  const blindSniperProgress = Math.max(-1, Math.min(1, (balance - seed) / Math.max(0.01, target - seed)));
  const blindSniperMilestoneIndex = Math.min(blindSniperUses, blindSniperMilestones.length);
  const blindSniperNextMilestone = blindSniperMilestoneIndex < blindSniperMilestones.length
    ? blindSniperMilestones[blindSniperMilestoneIndex]
    : null;
  const blindSniperUsesRemaining = Math.max(0, blindSniperMaxUses - blindSniperUses);
  const blindSniperTradesUntilShot = Math.max(0, blindSniperCadenceTrades - blindSniperTradesSinceLastShot);
  const blindSniperArmed =
    blindSniperEnabled &&
    !['martingale', 'rebuild', 'stopped'].includes(phase) &&
    blindSniperUsesRemaining > 0 &&
    blindSniperProgress >= blindSniperNextMilestone &&
    blindSniperTradesSinceLastShot >= blindSniperCadenceTrades;
  const blindSniperReason = !blindSniperEnabled
    ? 'disabled'
    : blindSniperUsesRemaining <= 0
      ? 'quota_exhausted'
      : ['martingale', 'rebuild', 'stopped'].includes(phase)
        ? 'phase_blocked'
        : blindSniperProgress < blindSniperNextMilestone
          ? 'progress_wait'
          : blindSniperTradesSinceLastShot < blindSniperCadenceTrades
            ? 'cadence_wait'
            : 'armed';
  const blindSniperStakeValue = Number(snapshot.blindSniperStake ?? run.blindSniperStake);
  const blindSniperStakeRawValue = Number(snapshot.blindSniperStakeRaw ?? run.blindSniperStakeRaw);
  const blindSniperStake = Number.isFinite(blindSniperStakeValue) ? blindSniperStakeValue : null;
  const blindSniperStakeRaw = Number.isFinite(blindSniperStakeRawValue) ? blindSniperStakeRawValue : null;
  const blindSniperStakeCapped = Boolean(snapshot.blindSniperStakeCapped ?? run.blindSniperStakeCapped ?? false);
  const blindSniperRemainingGapValue = Number(snapshot.blindSniperRemainingGap ?? run.blindSniperRemainingGap);
  const blindSniperProfitAboveFloorValue = Number(snapshot.blindSniperProfitAboveFloor ?? run.blindSniperProfitAboveFloor);
  const blindSniperGapCapValue = Number(snapshot.blindSniperGapCap ?? run.blindSniperGapCap);
  const blindSniperProfitCapValue = Number(snapshot.blindSniperProfitCap ?? run.blindSniperProfitCap);
  const blindSniperProgressTaperValue = Number(snapshot.blindSniperProgressTaper ?? run.blindSniperProgressTaper);
  const autoCycleMode = Boolean(snapshot.autoCycleMode ?? run.autoCycleMode ?? run.config?.autoCycleMode ?? false);
  const autoCycleBankedProfit = Number(snapshot.autoCycleBankedProfit ?? run.autoCycleBankedProfit ?? 0);
  const profitLoss = autoCycleMode
    ? roundMoney(Number(snapshot.profitLoss ?? run.profitLoss ?? autoCycleBankedProfit))
    : roundMoney(balance - seed);
  const netProfitLoss = autoCycleMode
    ? roundMoney(Number(snapshot.netProfitLoss ?? run.netProfitLoss ?? autoCycleBankedProfit + balance - seed))
    : profitLoss;

  return {
    runId: run.id,
    status: run.status,
    balance,
    accountBalance: snapshot.accountBalance ?? run.accountBalance ?? null,
    phase,
    symbol: normalizeSymbol(snapshot.symbol ?? run.symbol ?? run.config?.symbol, 'R_100'),
    digitStrategyMode: normalizeDigitStrategyMode(snapshot.digitStrategyMode ?? run.digitStrategyMode ?? run.config?.digitStrategyMode),
    targetSizingMode: normalizeTargetSizingMode(snapshot.targetSizingMode ?? run.targetSizingMode ?? run.config?.targetSizingMode),
    invertDigitSignal: Boolean(snapshot.invertDigitSignal ?? run.invertDigitSignal ?? run.config?.invertDigitSignal ?? false),
    autoModeEnabled: Boolean(snapshot.autoModeEnabled ?? run.autoModeEnabled ?? run.config?.autoModeEnabled ?? false),
    autoCycleMode,
    autoCycleProfit: Number(snapshot.autoCycleProfit ?? run.autoCycleProfit ?? run.config?.autoCycleProfit ?? 0),
    autoCycleStake: Number(snapshot.autoCycleStake ?? run.autoCycleStake ?? run.config?.autoCycleStake ?? 0),
    autoCycleBankedProfit,
    autoCycleCompleted: Number(snapshot.autoCycleCompleted ?? run.autoCycleCompleted ?? 0),
    autoCycleRecycled: Number(snapshot.autoCycleRecycled ?? run.autoCycleRecycled ?? 0),
    autoCyclePartialLocked: Number(snapshot.autoCyclePartialLocked ?? run.autoCyclePartialLocked ?? 0),
    autoCycleHardRecovery: Boolean(snapshot.autoCycleHardRecovery ?? run.autoCycleHardRecovery ?? false),
    autoCycleStartTrade: Number(snapshot.autoCycleStartTrade ?? run.autoCycleStartTrade ?? 0),
    autoCycleTrades: Number(snapshot.autoCycleTrades ?? run.autoCycleTrades ?? 0),
    autoCycleMinBalance: Number(snapshot.autoCycleMinBalance ?? run.autoCycleMinBalance ?? seed),
    autoCycleStruggled: Boolean(snapshot.autoCycleStruggled ?? run.autoCycleStruggled ?? false),
    autoCyclePartialExitTradeThreshold: Number(snapshot.autoCyclePartialExitTradeThreshold ?? run.autoCyclePartialExitTradeThreshold ?? 60),
    autoCyclePartialExitProfitRatio: Number(snapshot.autoCyclePartialExitProfitRatio ?? run.autoCyclePartialExitProfitRatio ?? 0.5),
    autoCycleRecycleTradeThreshold: Number(snapshot.autoCycleRecycleTradeThreshold ?? run.autoCycleRecycleTradeThreshold ?? 100),
    strategyTarget: Number(snapshot.strategyTarget ?? run.strategyTarget ?? target),
    overallProgressRatio: Number(snapshot.overallProgressRatio ?? run.overallProgressRatio ?? 0),
    autoRiskProfile: normalizeAutoRiskProfile(snapshot.autoRiskProfile ?? run.autoRiskProfile ?? run.config?.autoRiskProfile),
    autoState: snapshot.autoState ?? run.autoState ?? null,
    autoReason: snapshot.autoReason ?? run.autoReason ?? '',
    autoDecision: snapshot.autoDecision ?? run.autoDecision ?? null,
    autoReviewIntervalTrades: Number(snapshot.autoReviewIntervalTrades ?? run.autoReviewIntervalTrades ?? run.config?.autoReviewIntervalTrades ?? 5),
    autoLastReviewTrade: Number(snapshot.autoLastReviewTrade ?? run.autoLastReviewTrade ?? -1),
    recentResults: Array.isArray(snapshot.recentResults) ? snapshot.recentResults.slice(-20) : [],
    matchSniperCooldownUntilTrade: Number(snapshot.matchSniperCooldownUntilTrade ?? run.matchSniperCooldownUntilTrade ?? 0),
    matchSniperCooldownTrades: Number(snapshot.matchSniperCooldownTrades ?? run.matchSniperCooldownTrades ?? run.config?.matchSniperCooldownTrades ?? 3),
    matchSniperMaxCount: Number(snapshot.matchSniperMaxCount ?? run.matchSniperMaxCount ?? run.config?.matchSniperMaxCount ?? 1),
    seed,
    target,
    profitLoss,
    netProfitLoss,
    openCycleProfitLoss: autoCycleMode
      ? roundMoney(Number(snapshot.openCycleProfitLoss ?? run.openCycleProfitLoss ?? balance - seed))
      : 0,
    totalTrades,
    wins,
    losses,
    winRate: totalTrades ? roundMoney((wins / totalTrades) * 100) : 0,
    riskFloor: Number(snapshot.riskFloor ?? run.riskFloor ?? seed),
    recoveryDebt: Number(snapshot.recoveryDebt ?? run.recoveryDebt ?? 0),
    growthTier: Number(snapshot.growthTier ?? run.growthTier ?? 0),
    growthStep: Number(snapshot.growthStep ?? run.growthStep ?? 0),
    growthFloor: Number(snapshot.growthFloor ?? run.growthFloor ?? 0),
    gateStep: Number(snapshot.gateStep ?? run.gateStep ?? 0),
    growthStairMode: normalizeGrowthStairMode(
      snapshot.growthStairMode ?? run.growthStairMode ?? run.config?.growthStairMode,
      Boolean(snapshot.growthStairsEnabled ?? run.growthStairsEnabled ?? run.config?.growthStairsEnabled ?? false)
    ),
    growthStairsEnabled: normalizeGrowthStairMode(
      snapshot.growthStairMode ?? run.growthStairMode ?? run.config?.growthStairMode,
      Boolean(snapshot.growthStairsEnabled ?? run.growthStairsEnabled ?? run.config?.growthStairsEnabled ?? false)
    ) !== GROWTH_STAIR_MODES.OFF,
    growthLossStairTier: Number(snapshot.growthLossStairTier ?? run.growthLossStairTier ?? 0),
    growthLossWinStreak: Number(snapshot.growthLossWinStreak ?? run.growthLossWinStreak ?? 0),
    lossStairMaxTier: Number(snapshot.lossStairMaxTier ?? run.lossStairMaxTier ?? run.config?.lossStairMaxTier ?? 3),
    lossStairWinResetCount: Number(snapshot.lossStairWinResetCount ?? run.lossStairWinResetCount ?? run.config?.lossStairWinResetCount ?? 2),
    lossStairDebtCapPercent: Number(snapshot.lossStairDebtCapPercent ?? run.lossStairDebtCapPercent ?? run.config?.lossStairDebtCapPercent ?? 0.18),
    initialStake: snapshot.initialStake ?? run.initialStake ?? run.config?.initialStake ?? null,
    initialStakeUsed: Boolean(snapshot.initialStakeUsed ?? run.initialStakeUsed ?? run.config?.initialStakeUsed ?? false),
    martingaleLossStreak: Number(snapshot.martingaleLossStreak ?? run.martingaleLossStreak ?? 0),
    martingaleRetryLimit: Number(snapshot.martingaleRetryLimit ?? run.martingaleRetryLimit ?? 2),
    emergencyAllInUsed: Boolean(snapshot.emergencyAllInUsed ?? run.emergencyAllInUsed ?? false),
    splitRecoveryArmed: Boolean(snapshot.splitRecoveryArmed ?? run.splitRecoveryArmed ?? false),
    splitRecoveryReadyAtTrade: Number(snapshot.splitRecoveryReadyAtTrade ?? run.splitRecoveryReadyAtTrade ?? 0),
    splitRecoveryPiecesRemaining: Number(snapshot.splitRecoveryPiecesRemaining ?? run.splitRecoveryPiecesRemaining ?? 0),
    splitRecoveryCooldownTrades: Number(snapshot.splitRecoveryCooldownTrades ?? run.splitRecoveryCooldownTrades ?? 3),
    splitRecoveryPieces: Number(snapshot.splitRecoveryPieces ?? run.splitRecoveryPieces ?? 2),
    splitRecoveryCapPercent: Number(snapshot.splitRecoveryCapPercent ?? run.splitRecoveryCapPercent ?? 0.22),
    goalMode: snapshot.goalMode ?? run.goalMode ?? calibration.label,
    boldTargetStake: Number(snapshot.boldTargetStake ?? run.boldTargetStake ?? 0),
    goalGap: Number(snapshot.goalGap ?? run.goalGap ?? calibration.gap),
    goalGapRatio: Number(snapshot.goalGapRatio ?? run.goalGapRatio ?? calibration.gapRatio),
    profitAggression: Number(snapshot.profitAggression ?? run.profitAggression ?? run.config?.profitAggression ?? 2),
    profitPushArmed: Boolean(snapshot.profitPushArmed ?? run.profitPushArmed ?? false),
    profitPushReason: snapshot.profitPushReason ?? run.profitPushReason ?? null,
    profitPushStake: Number(snapshot.profitPushStake ?? run.profitPushStake ?? 0),
    profitPushStartRatio: Number(snapshot.profitPushStartRatio ?? run.profitPushStartRatio ?? 0),
    profitPushCapPercent: Number(snapshot.profitPushCapPercent ?? run.profitPushCapPercent ?? 0),
    estimatedWinProfitRatio: Number(snapshot.estimatedWinProfitRatio ?? run.estimatedWinProfitRatio ?? snapshot.lastWinProfitRatio ?? 0.22),
    lastProposalProfitRatio: Number(snapshot.lastProposalProfitRatio ?? run.lastProposalProfitRatio ?? 0.22),
    tradeCooldownUntil: Number(snapshot.tradeCooldownUntil ?? run.tradeCooldownUntil ?? 0),
    tradeCooldownReason: snapshot.tradeCooldownReason ?? run.tradeCooldownReason ?? null,
    tradeCooldownDetail: snapshot.tradeCooldownDetail ?? run.tradeCooldownDetail ?? null,
    confidenceGateLocked,
    confidenceGateWinRate,
    confidenceGateTriggerWinRate,
    confidenceGateReleaseWinRate,
    blindSniperEnabled,
    blindSniperUses,
    blindSniperUsesRemaining,
    blindSniperTradesSinceLastShot,
    blindSniperTradesUntilShot,
    blindSniperCadenceTrades,
    blindSniperMaxUses,
    blindSniperStartRatio,
    blindSniperMilestones,
    blindSniperStakeFraction,
    blindSniperProgress,
    blindSniperArmed,
    blindSniperNextMilestone,
    blindSniperReason,
    blindSniperStake,
    blindSniperStakeRaw,
    blindSniperStakeCapped,
    blindSniperRemainingGap: Number.isFinite(blindSniperRemainingGapValue) ? blindSniperRemainingGapValue : null,
    blindSniperProfitAboveFloor: Number.isFinite(blindSniperProfitAboveFloorValue) ? blindSniperProfitAboveFloorValue : null,
    blindSniperGapCap: Number.isFinite(blindSniperGapCapValue) ? blindSniperGapCapValue : null,
    blindSniperProfitCap: Number.isFinite(blindSniperProfitCapValue) ? blindSniperProfitCapValue : null,
    blindSniperProgressTaper: Number.isFinite(blindSniperProgressTaperValue) ? blindSniperProgressTaperValue : null,
    blindSniperMaxUses: Math.max(1, blindSniperMilestones.length)
  };
}

async function persistRunState(bot, { eventType = null, payload = {}, appendEvent = true, extraPatch = {} } = {}) {
  if (!activeRun) return null;

  const patch = buildRunPatch(bot, activeRun, extraPatch);
  if (appendEvent && eventType) {
    await runStore.appendEvent(activeRun.id, { type: eventType, payload });
  }

  const updated = await runStore.updateRun(activeRun.id, patch);
  if (updated) {
    activeRun = updated;
    upsertRecentRun(updated);
  }
  return updated;
}

async function initializePersistence() {
  try {
    await runStore.connect();
    persistenceBackend = configuredMongoUrl() ? 'mongo' : 'memory';
  } catch (error) {
    const hint = persistenceHint(error);
    console.warn(`Persistence store unavailable (${hint}). Falling back to in-memory history.`);
    bootError = hint;
    runStore = createRunStore({});
    await runStore.connect();
    persistenceBackend = 'memory';
  }

  recentRunsCache = await runStore.listRuns(RUN_HISTORY_LIMIT);

  const latestActive = await runStore.getLatestActiveRun();
  if (!latestActive) return;

  if (['running', 'starting'].includes(latestActive.status)) {
    const snapshot = latestActive.snapshot || {};
    if (snapshot.tradeInFlight) {
      const interrupted = await runStore.updateRun(latestActive.id, {
        status: 'interrupted',
        interruptedAt: new Date().toISOString(),
        reason: 'server_restart',
        summary: summarizeRun(latestActive, 'interrupted')
      });
      if (interrupted) upsertRecentRun(interrupted);
      activeRun = null;
      return;
    }

    const paused = await runStore.updateRun(latestActive.id, {
      status: 'paused',
      pausedAt: new Date().toISOString(),
      pauseReason: 'server_restart',
      reason: 'server_restart',
      snapshot: {
        ...snapshot,
        paused: true,
        pauseReason: 'server_restart',
        stopped: false
      }
    });
    if (paused) {
      activeRun = paused;
      upsertRecentRun(paused);
    }
    return;
  }

  if (latestActive.status === 'paused') {
    activeRun = latestActive;
    upsertRecentRun(latestActive);
  }
}

function bindBot(bot) {
  bot.on('status', (event) => {
    io.emit('status', event);
    void persistRunState(bot, {
      eventType: 'status',
      payload: event,
      appendEvent: true,
      extraPatch: {
        status: event.status === 'stopped' ? 'ended' : event.status,
        reason: event.pauseReason || activeRun?.reason || null
      }
    }).catch((error) => {
      console.error('Failed to persist status event:', error);
    });
  });

  bot.on('account', (event) => {
    io.emit('account', event);
    void persistRunState(bot, {
      appendEvent: false,
      extraPatch: {
        accountId: event.accountId || activeRun?.accountId || null,
        accountKind: event.accountKind || activeRun?.accountKind || null,
        accountBalance: event.balance ?? null
      }
    }).catch((error) => {
      console.error('Failed to persist account snapshot:', error);
    });
  });

  bot.on('digit', (event) => io.emit('digit', event));
  bot.on('analysis', (event) => io.emit('analysis', event));

  bot.on('trade', (event) => {
    io.emit('trade', event);
    void persistRunState(bot, {
      eventType: 'trade',
      payload: event,
      appendEvent: true
    }).catch((error) => {
      console.error('Failed to persist trade event:', error);
    });
  });

  bot.on('phase_change', (event) => {
    io.emit('phase_change', event);
    void persistRunState(bot, {
      eventType: 'phase_change',
      payload: event,
      appendEvent: true,
      extraPatch: {
        phase: event.to
      }
    }).catch((error) => {
      console.error('Failed to persist phase change:', error);
    });
  });

  bot.on('balance_update', (event) => {
    io.emit('balance_update', event);
    void persistRunState(bot, {
      appendEvent: false,
      extraPatch: {
        balance: event.balance,
        accountBalance: event.accountBalance ?? null,
        phase: event.phase,
        symbol: event.symbol,
        digitStrategyMode: event.digitStrategyMode,
        targetSizingMode: event.targetSizingMode,
        invertDigitSignal: event.invertDigitSignal,
        autoModeEnabled: event.autoModeEnabled,
        autoCycleMode: event.autoCycleMode,
        autoCycleProfit: event.autoCycleProfit,
        autoCycleStake: event.autoCycleStake,
        autoCycleBankedProfit: event.autoCycleBankedProfit,
        autoCycleCompleted: event.autoCycleCompleted,
        autoCycleRecycled: event.autoCycleRecycled,
        autoCyclePartialLocked: event.autoCyclePartialLocked,
        autoCycleHardRecovery: event.autoCycleHardRecovery,
        autoCycleStartTrade: event.autoCycleStartTrade,
        autoCycleTrades: event.autoCycleTrades,
        autoCycleMinBalance: event.autoCycleMinBalance,
        autoCycleStruggled: event.autoCycleStruggled,
        autoCyclePartialExitTradeThreshold: event.autoCyclePartialExitTradeThreshold,
        autoCyclePartialExitProfitRatio: event.autoCyclePartialExitProfitRatio,
        autoCycleRecycleTradeThreshold: event.autoCycleRecycleTradeThreshold,
        strategyTarget: event.strategyTarget,
        overallProgressRatio: event.overallProgressRatio,
        profitLoss: event.profitLoss,
        netProfitLoss: event.netProfitLoss,
        openCycleProfitLoss: event.openCycleProfitLoss,
        autoRiskProfile: event.autoRiskProfile,
        autoState: event.autoState,
        autoReason: event.autoReason,
        autoDecision: event.autoDecision,
        autoReviewIntervalTrades: event.autoReviewIntervalTrades,
        autoLastReviewTrade: event.autoLastReviewTrade,
        recentResults: event.recentResults,
        matchSniperCooldownUntilTrade: event.matchSniperCooldownUntilTrade,
        matchSniperCooldownTrades: event.matchSniperCooldownTrades,
        matchSniperMaxCount: event.matchSniperMaxCount,
        totalTrades: event.totalTrades,
        wins: event.wins,
        losses: event.losses,
        winRate: event.winRate,
        riskFloor: event.riskFloor,
        recoveryDebt: event.recoveryDebt,
        growthTier: event.growthTier,
        growthStep: event.growthStep,
        growthFloor: event.growthFloor,
        growthStairMode: event.growthStairMode,
        growthStairsEnabled: event.growthStairsEnabled,
        growthLossStairTier: event.growthLossStairTier,
        growthLossWinStreak: event.growthLossWinStreak,
        lossStairMaxTier: event.lossStairMaxTier,
        lossStairWinResetCount: event.lossStairWinResetCount,
        lossStairDebtCapPercent: event.lossStairDebtCapPercent,
        gateStep: event.gateStep,
        boldTargetStake: event.boldTargetStake,
        profitAggression: event.profitAggression,
        profitPushArmed: event.profitPushArmed,
        profitPushReason: event.profitPushReason,
        profitPushStake: event.profitPushStake,
        profitPushStartRatio: event.profitPushStartRatio,
        profitPushCapPercent: event.profitPushCapPercent,
        estimatedWinProfitRatio: event.estimatedWinProfitRatio,
        lastProposalProfitRatio: event.lastProposalProfitRatio
      }
    }).catch((error) => {
      console.error('Failed to persist balance update:', error);
    });
  });

  bot.on('error_event', (event) => {
    io.emit('bot_error', event);
    void persistRunState(bot, {
      eventType: 'error',
      payload: event,
      appendEvent: true
    }).catch((error) => {
      console.error('Failed to persist bot error:', error);
    });
  });

  bot.on('bot_stopped', (summary) => {
    io.emit('bot_stopped', summary);
    void persistRunState(bot, {
      eventType: 'bot_stopped',
      payload: summary,
      appendEvent: true,
      extraPatch: {
        status: 'ended',
        endedAt: summary.stoppedAt,
        summary,
        reason: summary.reason
      }
    })
      .then((updated) => {
        if (updated) upsertRecentRun(updated);
        activeBot = null;
        activeRun = null;
      })
      .catch((error) => {
        console.error('Failed to persist run stop:', error);
        activeBot = null;
        activeRun = null;
      });
  });
}

function sendSessionState(socket) {
  const state = buildSessionState();
  socket.emit('config', publicConfig());
  socket.emit('session_state', state);

  const currentState = runBalanceState(activeRun);
  if (currentState) {
    socket.emit('balance_update', currentState);
  }
}

function buildRunFromResumeSource(payload = {}) {
  if (!activeRun) return null;

  const token = resolveToken(payload.token || '');
  if (activeRun.snapshot && activeRun.snapshot.tradeInFlight) {
    throw new Error('This run was interrupted while a trade was still open. End it and start a new run instead.');
  }

  const resumePayload = {
    ...activeRun.config,
    seed: activeRun.seed,
    target: activeRun.target,
    mode: activeRun.mode,
    accountId: activeRun.accountId || activeRun.config?.accountId || '',
    guideFilters: activeRun.config?.guideFilters,
    strictBarFilters: activeRun.config?.strictBarFilters,
    token
  };

  return sanitizeStartPayload(resumePayload);
}

async function startFreshRun(payload = {}) {
  const config = sanitizeStartPayload(payload);
  const { token, ...storedConfig } = config;
  const bot = new DerivDigitBot(config);
  const initialSnapshot = bot.snapshot();

  const runDoc = await runStore.createRun({
    status: 'starting',
    reason: 'manual',
    mode: config.mode,
    symbol: config.symbol,
    digitStrategyMode: config.digitStrategyMode,
    targetSizingMode: config.targetSizingMode,
    invertDigitSignal: config.invertDigitSignal,
    autoModeEnabled: initialSnapshot.autoModeEnabled,
    autoCycleMode: initialSnapshot.autoCycleMode,
    autoCycleProfit: initialSnapshot.autoCycleProfit,
    autoCycleStake: initialSnapshot.autoCycleStake,
    autoCycleBankedProfit: initialSnapshot.autoCycleBankedProfit,
    autoCycleCompleted: initialSnapshot.autoCycleCompleted,
    autoCycleRecycled: initialSnapshot.autoCycleRecycled,
    autoCyclePartialLocked: initialSnapshot.autoCyclePartialLocked,
    autoCycleHardRecovery: initialSnapshot.autoCycleHardRecovery,
    autoCycleStartTrade: initialSnapshot.autoCycleStartTrade,
    autoCycleTrades: initialSnapshot.autoCycleTrades,
    autoCycleMinBalance: initialSnapshot.autoCycleMinBalance,
    autoCycleStruggled: initialSnapshot.autoCycleStruggled,
    autoCyclePartialExitTradeThreshold: initialSnapshot.autoCyclePartialExitTradeThreshold,
    autoCyclePartialExitProfitRatio: initialSnapshot.autoCyclePartialExitProfitRatio,
    autoCycleRecycleTradeThreshold: initialSnapshot.autoCycleRecycleTradeThreshold,
    strategyTarget: initialSnapshot.strategyTarget,
    autoRiskProfile: initialSnapshot.autoRiskProfile,
    autoState: initialSnapshot.autoState,
    autoReason: initialSnapshot.autoReason,
    autoDecision: initialSnapshot.autoDecision,
    autoReviewIntervalTrades: initialSnapshot.autoReviewIntervalTrades,
    autoLastReviewTrade: initialSnapshot.autoLastReviewTrade,
    recentResults: initialSnapshot.recentResults,
    matchSniperCooldownUntilTrade: initialSnapshot.matchSniperCooldownUntilTrade,
    matchSniperCooldownTrades: initialSnapshot.matchSniperCooldownTrades,
    matchSniperMaxCount: initialSnapshot.matchSniperMaxCount,
    currency: config.currency,
    accountId: config.accountId || null,
    accountKind: null,
    seed: config.seed,
    target: config.target,
    config: storedConfig,
    snapshot: initialSnapshot,
    balance: initialSnapshot.balance,
    accountBalance: initialSnapshot.accountBalance,
    phase: initialSnapshot.phase,
    riskFloor: initialSnapshot.riskFloor,
    recoveryDebt: initialSnapshot.recoveryDebt,
    totalTrades: initialSnapshot.totalTrades,
    wins: initialSnapshot.wins,
    losses: initialSnapshot.losses,
    winRate: 0,
    growthTier: bot.growthTier(),
    growthStep: bot.growthMilestoneStep(),
    growthFloor: bot.growthStakeFloor(),
    growthStairMode: initialSnapshot.growthStairMode,
    growthStairsEnabled: initialSnapshot.growthStairsEnabled,
    growthLossStairTier: initialSnapshot.growthLossStairTier,
    growthLossWinStreak: initialSnapshot.growthLossWinStreak,
    lossStairMaxTier: initialSnapshot.lossStairMaxTier,
    lossStairWinResetCount: initialSnapshot.lossStairWinResetCount,
    lossStairDebtCapPercent: initialSnapshot.lossStairDebtCapPercent,
    gateStep: bot.profitGateStep(),
    goalMode: initialSnapshot.goalMode,
    goalGap: initialSnapshot.goalGap,
    goalGapRatio: initialSnapshot.goalGapRatio,
    profitAggression: initialSnapshot.profitAggression,
    profitPushArmed: initialSnapshot.profitPushArmed,
    profitPushReason: initialSnapshot.profitPushReason,
    profitPushStake: initialSnapshot.profitPushStake,
    profitPushStartRatio: initialSnapshot.profitPushStartRatio,
    profitPushCapPercent: initialSnapshot.profitPushCapPercent,
    estimatedWinProfitRatio: initialSnapshot.estimatedWinProfitRatio,
    lastProposalProfitRatio: initialSnapshot.lastProposalProfitRatio,
    tradeCooldownUntil: initialSnapshot.tradeCooldownUntil,
    tradeCooldownReason: initialSnapshot.tradeCooldownReason,
    tradeCooldownDetail: initialSnapshot.tradeCooldownDetail,
    emergencyAllInUsed: initialSnapshot.emergencyAllInUsed,
    startedAt: bot.startedAt ? bot.startedAt.toISOString() : new Date().toISOString()
  });

  activeBot = bot;
  activeRun = runDoc;
  upsertRecentRun(runDoc);
  bindBot(bot);

  try {
    await bot.start();
    activeRun = await runStore.getRun(runDoc.id);
    if (activeRun) upsertRecentRun(activeRun);
    return runDoc;
  } catch (error) {
    const failedRun = await runStore.updateRun(runDoc.id, {
      status: 'failed',
      endedAt: new Date().toISOString(),
      reason: error.message,
      summary: {
        reason: 'start_failed',
        message: error.message,
        startedAt: runDoc.startedAt,
        stoppedAt: new Date().toISOString(),
        mode: config.mode,
        seed: config.seed,
        target: config.target
      }
    });
    if (failedRun) upsertRecentRun(failedRun);
    activeBot = null;
    activeRun = null;
    throw error;
  }
}

async function resumePausedRun(payload = {}) {
  const sourceRun = activeRun && activeRun.status === 'paused' ? activeRun : latestPausedRun();
  if (!sourceRun) {
    throw new Error('No paused run is available to resume.');
  }

  if (sourceRun.snapshot && sourceRun.snapshot.tradeInFlight) {
    throw new Error('This paused run still thinks a trade is in flight. End it and start fresh instead.');
  }

  const config = sanitizeStartPayload({
    ...sourceRun.config,
    seed: sourceRun.seed,
    target: sourceRun.target,
    mode: sourceRun.mode,
    accountId: sourceRun.accountId || sourceRun.config?.accountId || '',
    guideFilters: sourceRun.config?.guideFilters,
    strictBarFilters: sourceRun.config?.strictBarFilters,
    token: payload.token || ''
  });

  const bot = new DerivDigitBot(config);
  bot.restoreState(sourceRun.snapshot || {});

  activeBot = bot;
  activeRun = sourceRun;
  bindBot(bot);

  await bot.start();
  activeRun = await runStore.getRun(sourceRun.id);
  if (activeRun) upsertRecentRun(activeRun);
  return activeRun;
}

async function pauseActiveRun(reason = 'manual') {
  if (!activeBot || !activeRun) {
    throw new Error('No active run is running.');
  }

  activeBot.pause(reason);
  return true;
}

async function stopActiveRun(reason = 'manual') {
  if (activeBot && activeRun) {
    const bot = activeBot;
    await bot.stop(reason);
    return true;
  }

  if (activeRun && activeRun.status === 'paused') {
    const summary = summarizeRun(activeRun, reason);
    const updated = await runStore.updateRun(activeRun.id, {
      status: 'ended',
      endedAt: new Date().toISOString(),
      reason,
      summary
    });
    if (updated) upsertRecentRun(updated);
    io.emit('bot_stopped', summary);
    activeRun = null;
    return true;
  }

  throw new Error('No bot is running.');
}

app.use(requireBasicAuth);
app.get('/api/config', (req, res) => res.json(publicConfig()));
app.get('/api/state', (req, res) => res.json(buildSessionState()));
app.get('/api/runs', async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(50, numberFrom(req.query.limit, RUN_HISTORY_LIMIT)));
    const runs = await runStore.listRuns(limit);
    res.json({ runs, persistenceBackend });
  } catch (error) {
    next(error);
  }
});
app.get('/api/runs/:runId', async (req, res, next) => {
  try {
    const run = await runStore.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }
    res.json({ run });
  } catch (error) {
    next(error);
  }
});
app.get('/api/runs/:runId/events', async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(500, numberFrom(req.query.limit, 200)));
    const run = await runStore.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }
    const events = await runStore.getRunEvents(run.id, limit);
    res.json({ runId: run.id, events });
  } catch (error) {
    next(error);
  }
});
app.use(express.static(PUBLIC_DIR));

io.use((socket, next) => {
  if (basicAuthValid(socket.handshake.headers)) return next();
  next(new Error('Authentication required'));
});

io.on('connection', (socket) => {
  sendSessionState(socket);

  socket.on('start_bot', async (payload, ack) => {
    try {
      if (activeBot && !activeBot.stopped) {
        throw new Error('A run is already active. Pause or stop it before starting a new one.');
      }

      await startFreshRun(payload);
      if (typeof ack === 'function') ack({ ok: true, run: activeRun });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
      socket.emit('bot_error', { message: error.message });
    }
  });

  socket.on('pause_bot', async (_payload, ack) => {
    try {
      await pauseActiveRun('manual');
      if (typeof ack === 'function') ack({ ok: true, run: activeRun });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
      socket.emit('bot_error', { message: error.message });
    }
  });

  socket.on('resume_bot', async (payload, ack) => {
    try {
      if (activeBot && activeRun && activeRun.status === 'paused') {
        activeBot.resume('manual');
        if (typeof ack === 'function') ack({ ok: true, run: activeRun });
        return;
      }

      await resumePausedRun(payload || {});
      if (typeof ack === 'function') ack({ ok: true, run: activeRun });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
      socket.emit('bot_error', { message: error.message });
    }
  });

  socket.on('stop_bot', async (_payload, ack) => {
    try {
      await stopActiveRun('manual');
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
      socket.emit('bot_error', { message: error.message });
    }
  });

  socket.on('refresh_runs', async (_payload, ack) => {
    try {
      recentRunsCache = await runStore.listRuns(RUN_HISTORY_LIMIT);
      if (typeof ack === 'function') {
        ack({ ok: true, state: buildSessionState() });
      } else {
        socket.emit('session_state', buildSessionState());
      }
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
      socket.emit('bot_error', { message: error.message });
    }
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: error.message || 'Internal server error' });
});

async function main() {
  await initializePersistence();

  server.listen(PORT, () => {
    console.log(`Deriv Digit Bot dashboard listening on http://localhost:${PORT}`);
    if (!process.env.DASHBOARD_PASSWORD) {
      console.log('Warning: DASHBOARD_PASSWORD is not set. Do not expose this dashboard publicly.');
    }
    if (bootError) {
      console.log(`Persistence notice: ${bootError}`);
    }
  });
}

void main().catch((error) => {
  console.error('Failed to boot server:', error);
  process.exitCode = 1;
});
