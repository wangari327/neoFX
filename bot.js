const EventEmitter = require('events');
const WebSocket = require('ws');

const CONDITIONS = {
  OVER_1: {
    id: 'over_1',
    label: 'Over 1',
    contractType: 'DIGITOVER',
    barrier: '1',
    entryDigit: 1,
    losingDigits: [0, 1],
    wins: (digit) => digit > 1
  },
  UNDER_8: {
    id: 'under_8',
    label: 'Under 8',
    contractType: 'DIGITUNDER',
    barrier: '8',
    entryDigit: 8,
    losingDigits: [8, 9],
    wins: (digit) => digit < 8
  }
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

const AUTO_STATES = {
  MANUAL: 'manual',
  SCOUT: 'scout',
  GRIND: 'grind',
  PRESSURE: 'pressure',
  BLAST: 'blast',
  RECOVERY: 'recovery',
  DEFENSE: 'defense',
  FINISH: 'finish'
};

const PHASES = {
  GROWTH: 'growth',
  RISKY: 'risky_jump',
  MARTINGALE: 'martingale',
  REBUILD: 'rebuild',
  BLIND_SNIPER: 'blind_sniper',
  STOPPED: 'stopped'
};

const DEFAULT_API_BASE_URL = 'https://api.derivws.com';
const CONFIDENCE_GUARD_TRIGGER_WIN_RATE = 81;
const CONFIDENCE_GUARD_RELEASE_WIN_RATE = 82;
const CONFIDENCE_THROTTLE_MIN_TRADES = 20;
const CONFIDENCE_THROTTLE_MIN_MS = 2500;
const CONFIDENCE_THROTTLE_MAX_MS = 12000;
const BLIND_SNIPER_PROFIT_CAP_FRACTION = 0.25;
const BLIND_SNIPER_PROGRESS_TAPER_FLOOR = 0.2;
const DEFAULT_DIGIT_WIN_PROFIT_RATIO = 0.22;
const DEFAULT_DIGIT_DIFF_WIN_PROFIT_RATIO = 0.09;
const PROFIT_AGGRESSION_DEFAULT = 2;
const AUTO_CYCLE_DEFAULT_PROFIT_PERCENT = 0.1;
const AUTO_CYCLE_DEFAULT_STAKE_PERCENT = 0.05;
const AUTO_CYCLE_PARTIAL_EXIT_TRADE_THRESHOLD = 60;
const AUTO_CYCLE_PARTIAL_EXIT_PROFIT_RATIO = 0.5;
const AUTO_CYCLE_RECYCLE_TRADE_THRESHOLD = 100;
const AUTO_CYCLE_MILESTONES = [0.25, 0.5];
const GROWTH_STAIR_MODES = {
  OFF: 'off',
  PROFIT: 'profit',
  LOSS_PRESSURE: 'loss_pressure'
};

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toOptionalNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
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

function digitOverCondition(barrier, label = `Over ${barrier}`) {
  const resolvedBarrier = Number(barrier);
  return {
    id: `over_${resolvedBarrier}`,
    label,
    contractType: 'DIGITOVER',
    barrier: String(resolvedBarrier),
    entryDigit: resolvedBarrier,
    losingDigits: Array.from({ length: resolvedBarrier + 1 }, (_, digit) => digit),
    strategyMode: DIGIT_STRATEGY_MODES.EXTREME,
    wins: (digit) => digit > resolvedBarrier
  };
}

function digitUnderCondition(barrier, label = `Under ${barrier}`) {
  const resolvedBarrier = Number(barrier);
  return {
    id: `under_${resolvedBarrier}`,
    label,
    contractType: 'DIGITUNDER',
    barrier: String(resolvedBarrier),
    entryDigit: resolvedBarrier,
    losingDigits: Array.from({ length: 10 - resolvedBarrier }, (_, index) => resolvedBarrier + index),
    strategyMode: DIGIT_STRATEGY_MODES.EXTREME,
    wins: (digit) => digit < resolvedBarrier
  };
}

function digitMatchCondition(digit) {
  const resolvedDigit = Number(digit);
  return {
    id: `match_${resolvedDigit}`,
    label: `Match ${resolvedDigit}`,
    contractType: 'DIGITMATCH',
    barrier: String(resolvedDigit),
    entryDigit: resolvedDigit,
    losingDigits: Array.from({ length: 10 }, (_, value) => value).filter((value) => value !== resolvedDigit),
    strategyMode: DIGIT_STRATEGY_MODES.MATCH_SNIPER,
    wins: (exitDigit) => exitDigit === resolvedDigit
  };
}

function digitDiffCondition(digit) {
  const resolvedDigit = Number(digit);
  return {
    id: `diff_${resolvedDigit}`,
    label: `Differs ${resolvedDigit}`,
    contractType: 'DIGITDIFF',
    barrier: String(resolvedDigit),
    entryDigit: resolvedDigit,
    losingDigits: [resolvedDigit],
    strategyMode: DIGIT_STRATEGY_MODES.MATCH_SNIPER,
    wins: (exitDigit) => exitDigit !== resolvedDigit
  };
}

function invertDigitCondition(condition) {
  if (!condition) return null;

  const barrier = Number(condition.barrier);
  let inverted = null;
  if (condition.contractType === 'DIGITOVER') {
    inverted = digitUnderCondition(barrier + 1, `Under ${barrier + 1}`);
  } else if (condition.contractType === 'DIGITUNDER') {
    inverted = digitOverCondition(barrier - 1, `Over ${barrier - 1}`);
  } else if (condition.contractType === 'DIGITMATCH') {
    inverted = digitDiffCondition(barrier);
  } else if (condition.contractType === 'DIGITDIFF') {
    inverted = digitMatchCondition(barrier);
  }

  if (!inverted) return condition;
  return {
    ...inverted,
    id: `invert_${condition.id}_to_${inverted.id}`,
    label: `Invert: ${inverted.label}`,
    sourceConditionId: condition.id,
    sourceConditionLabel: condition.label,
    inverted: true
  };
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
      return clamp(numeric > 1 || numeric < -1 ? numeric / 100 : numeric, -1, 1);
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

function joinUrl(base, path) {
  const cleanBase = String(base || DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '');
  const cleanPath = String(path || '').trim().replace(/^\/+/, '');
  return `${cleanBase}/${cleanPath}`;
}

function quoteToDigit(quote, pipSize = 2) {
  if (quote === null || quote === undefined || quote === '') return null;
  const numeric = Number(quote);
  if (!Number.isFinite(numeric)) return null;
  const normalized = numeric.toFixed(Math.max(0, pipSize));
  const digits = normalized.replace(/\D/g, '');
  if (!digits) return null;
  return Number(digits[digits.length - 1]);
}

function accountTypeFromAccount(account = {}) {
  const accountType = String(account.account_type || account.accountType || '').toLowerCase();
  if (accountType === 'demo' || accountType === 'real') return accountType;

  if (account.is_virtual === 1 || account.is_virtual === true) return 'demo';
  if (account.is_virtual === 0 || account.is_virtual === false) return 'real';

  const loginid = String(account.loginid || account.account_id || '');
  if (/^VRTC/i.test(loginid) || /^VR/i.test(loginid)) return 'demo';
  if (loginid) return 'real';
  return 'unknown';
}

function normalizeAccountList(payload = {}) {
  const candidate =
    (Array.isArray(payload.data) && payload.data) ||
    (Array.isArray(payload.accounts) && payload.accounts) ||
    (Array.isArray(payload.result) && payload.result) ||
    (Array.isArray(payload) && payload) ||
    null;

  if (candidate) return candidate;
  if (payload.data && typeof payload.data === 'object') return [payload.data];
  if (payload.account && typeof payload.account === 'object') return [payload.account];
  return [];
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const fallbackMessage =
      payload?.errors?.[0]?.message ||
      payload?.error?.message ||
      payload?.message ||
      `Deriv request failed with status ${response.status}.`;
    const message = response.status === 401
      ? 'Deriv rejected the authorization token or App ID. Check DERIV_API_TOKEN, DERIV_APP_ID, and make sure the PAT app type matches the token type.'
      : response.status === 403
        ? 'Deriv denied access. Check the token scopes, App ID, and account access.'
        : fallbackMessage;
    throw new Error(message);
  }

  return payload;
}

class DerivDigitBot extends EventEmitter {
  constructor(options = {}) {
    super();

    const growthStairMode = normalizeGrowthStairMode(
      options.growthStairMode ?? options.growthStairsMode,
      options.growthStairsEnabled === true
    );

    this.options = {
      mode: options.mode || 'demo',
      token: options.token || '',
      apiBaseUrl: options.apiBaseUrl || DEFAULT_API_BASE_URL,
      accountId: options.accountId || '',
      appId: options.appId || '1089',
      symbol: normalizeSymbol(options.symbol, 'R_100'),
      currency: options.currency || 'USD',
      seed: roundMoney(toNumber(options.seed, 10)),
      target: roundMoney(toNumber(options.target, 50)),
      minStake: roundMoney(toNumber(options.minStake, 0.35)),
      baseStakePercent: toNumber(options.baseStakePercent, 0.02),
      riskyStakePercent: toNumber(options.riskyStakePercent, 0.35),
      martingaleCapPercent: toNumber(options.martingaleCapPercent, 0.4),
      martingaleRetryLimit: Math.max(2, Math.floor(toNumber(options.martingaleRetryLimit, 2))),
      allInLossStreakThreshold: Math.max(2, Math.floor(toNumber(options.allInLossStreakThreshold, 3))),
      allInStakePercent: clamp(toNumber(options.allInStakePercent, 0.25), 0.05, 1),
      splitRecoveryCooldownTrades: Math.max(1, Math.floor(toNumber(options.splitRecoveryCooldownTrades, 3))),
      splitRecoveryPieces: Math.max(2, Math.floor(toNumber(options.splitRecoveryPieces, 2))),
      splitRecoveryCapPercent: clamp(toNumber(options.splitRecoveryCapPercent, 0.22), 0.05, 1),
      growthMilestonePercent: toNumber(options.growthMilestonePercent, 0.025),
      growthStakeBumpPercent: toNumber(options.growthStakeBumpPercent, 0.15),
      growthStakeCapPercent: toNumber(options.growthStakeCapPercent, 0.12),
      growthStairMode,
      growthStairsEnabled: growthStairMode !== GROWTH_STAIR_MODES.OFF,
      lossStairMaxTier: Math.max(1, Math.floor(toNumber(options.lossStairMaxTier, 3))),
      lossStairWinResetCount: Math.max(1, Math.floor(toNumber(options.lossStairWinResetCount, 2))),
      lossStairDebtCapPercent: clamp(toNumber(options.lossStairDebtCapPercent, 0.18), 0.02, 1),
      profitGatePercent: toNumber(options.profitGatePercent, 0.08),
      profitAggression: clamp(toNumber(options.profitAggression, PROFIT_AGGRESSION_DEFAULT), 1, 5),
      autoModeEnabled: options.autoModeEnabled === true,
      autoCycleMode: options.autoCycleMode !== false,
      autoCycleProfit: toOptionalNumber(options.autoCycleProfit, null),
      autoCycleStake: toOptionalNumber(options.autoCycleStake, null),
      autoCyclePartialExitTradeThreshold: Math.max(1, Math.floor(toNumber(options.autoCyclePartialExitTradeThreshold, AUTO_CYCLE_PARTIAL_EXIT_TRADE_THRESHOLD))),
      autoCyclePartialExitProfitRatio: clamp(toNumber(options.autoCyclePartialExitProfitRatio, AUTO_CYCLE_PARTIAL_EXIT_PROFIT_RATIO), 0.1, 1),
      autoCycleRecycleTradeThreshold: Math.max(1, Math.floor(toNumber(options.autoCycleRecycleTradeThreshold, AUTO_CYCLE_RECYCLE_TRADE_THRESHOLD))),
      autoRiskProfile: normalizeAutoRiskProfile(options.autoRiskProfile),
      autoReviewIntervalTrades: Math.max(1, Math.floor(toNumber(options.autoReviewIntervalTrades, 5))),
      targetSizingMode: normalizeTargetSizingMode(options.targetSizingMode ?? options.goalSizingMode),
      digitStrategyMode: normalizeDigitStrategyMode(options.digitStrategyMode ?? options.highRiskDigitMode),
      invertDigitSignal: options.invertDigitSignal === true,
      matchSniperCooldownTrades: Math.max(1, Math.floor(toNumber(options.matchSniperCooldownTrades, 3))),
      matchSniperMaxCount: Math.max(0, Math.floor(toNumber(options.matchSniperMaxCount, 1))),
      recoveryBufferPercent: toNumber(options.recoveryBufferPercent, 0.05),
      initialStake: toOptionalNumber(options.initialStake, null),
      blindSniperEnabled: options.blindSniperEnabled === true,
      blindSniperCadenceTrades: Math.max(1, Math.floor(toNumber(options.blindSniperCadenceTrades, 3))),
      blindSniperMaxUses: Math.max(0, Math.floor(toNumber(options.blindSniperMaxUses, 3))),
      blindSniperStartRatio: clamp(toNumber(options.blindSniperStartRatio, 0.75), 0, 1),
      blindSniperMilestones: normalizeMilestoneList(
        options.blindSniperMilestones ?? options.blindSniperMarks,
        [0.25, 0.5, clamp(toNumber(options.blindSniperStartRatio, 0.75), 0, 1)]
      ),
      blindSniperStakeFraction: clamp(toNumber(options.blindSniperStakeFraction, 1 / 3), 0, 1),
      windowSize: Math.max(10, Math.floor(toNumber(options.windowSize, 20))),
      guideFilters: options.guideFilters === true,
      strictBarFilters: options.strictBarFilters === true,
      duration: Math.max(1, Math.floor(toNumber(options.duration, 1))),
      durationUnit: options.durationUnit || 't'
    };
    this.options.blindSniperStartRatio =
      this.options.blindSniperMilestones[this.options.blindSniperMilestones.length - 1] ??
      this.options.blindSniperStartRatio;
    this.options.blindSniperMaxUses = Math.max(1, this.options.blindSniperMilestones.length);

    this.balance = this.options.seed;
    this.accountBalance = null;
    this.accountKind = 'unknown';
    this.phase = PHASES.GROWTH;
    this.riskFloor = this.options.seed;
    this.recoveryDebt = 0;
    this.lastWinProfitRatio = DEFAULT_DIGIT_WIN_PROFIT_RATIO;
    this.lastProposalProfitRatio = this.strategyFallbackProfitRatio();
    this.lastPipSize = 2;
    this.autoState = this.options.autoModeEnabled ? AUTO_STATES.SCOUT : AUTO_STATES.MANUAL;
    this.autoReason = this.options.autoModeEnabled ? 'Auto mode starts in Scout while it gathers early run evidence.' : '';
    this.autoLastReviewTrade = -1;
    this.autoLastDecision = null;
    this.autoCycleBankedProfit = 0;
    this.autoCycleCompleted = 0;
    this.autoCycleRecycled = 0;
    this.autoCyclePartialLocked = 0;
    this.autoCycleHardRecovery = false;
    this.autoCycleStartTrade = 0;
    this.autoCycleMinBalance = this.options.seed;
    this.autoCycleStruggled = false;
    this.autoBaseConfig = {
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.options.targetSizingMode,
      invertDigitSignal: this.options.invertDigitSignal,
      autoCycleMode: this.options.autoCycleMode,
      autoCycleProfit: this.options.autoCycleProfit,
      autoCycleStake: this.options.autoCycleStake,
      profitAggression: this.options.profitAggression,
      growthStairMode: this.options.growthStairMode,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperMilestones: this.options.blindSniperMilestones.slice(),
      blindSniperStakeFraction: this.options.blindSniperStakeFraction,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount,
      guideFilters: this.options.guideFilters,
      strictBarFilters: this.options.strictBarFilters
    };
    this.growthAnchorBalance = this.options.seed;
    this.growthLossStairTier = 0;
    this.growthLossWinStreak = 0;
    this.martingaleLossStreak = 0;
    this.splitRecoveryArmed = false;
    this.splitRecoveryReadyAtTrade = 0;
    this.splitRecoveryPiecesRemaining = 0;
    this.confidenceGateLocked = false;
    this.paused = false;
    this.pauseRequested = false;
    this.pauseReason = 'manual';
    this.initialStakeUsed = false;
    this.blindSniperUses = 0;
    this.tradesSinceBlindSniper = 0;
    this.sniperOverlayNet = 0;
    this.emergencyAllInUsed = false;
    this.matchSniperCooldownUntilTrade = 0;

    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.recentResults = [];
    this.tradeInFlight = false;
    this.stopped = false;
    this.startedAt = null;
    this.currentPlan = null;

    this.digits = [];
    this.ws = null;
    this.pending = new Map();
    this.contractWatchers = new Map();
    this.tickSubscriptionId = null;
    this.tickSymbol = this.options.symbol;
    this.symbolSwitchInFlight = null;
    this.reqId = 1;
    this.pingTimer = null;
    this.analysisState = {
      key: '',
      emittedAt: 0
    };
    this.tradeCooldownUntil = 0;
    this.tradeCooldownReason = '';
    this.tradeCooldownDetail = '';
  }

  async start() {
    this.startedAt = this.startedAt || new Date();
    this.stopped = false;
    this.paused = false;
    this.pauseRequested = false;
    this.pauseReason = 'manual';
    this.tradeCooldownUntil = 0;
    this.tradeCooldownReason = '';
    this.tradeCooldownDetail = '';
    this.emergencyAllInUsed = false;
    this.emitStatus('starting');

    if (!this.options.token) {
      throw new Error('A Deriv API token is required for demo or real trading.');
    }

    await this.connectDeriv();
    this.emitStatus('running');
  }

  pause(reason = 'manual') {
    if (this.stopped) return;

    this.paused = true;
    this.pauseRequested = false;
    this.pauseReason = reason;

    this.emitStatus('paused');
    this.emitAnalysis(
      'paused',
      this.tradeInFlight
        ? `Pause requested (${reason}). The current trade will finish, then the bot will stay paused.`
        : `Bot paused (${reason}). Trading is halted until you resume this run.`,
      {}
    );
  }

  resume(reason = 'manual') {
    if (this.stopped) return;

    this.paused = false;
    this.pauseRequested = false;
    this.pauseReason = reason;
    this.emitStatus('running');
    this.emitAnalysis('resumed', `Bot resumed (${reason}). Trading will continue from the saved run state.`, {});
  }

  async stop(reason = 'manual') {
    if (this.stopped) return;
    this.stopped = true;
    this.paused = false;
    this.pauseRequested = false;
    this.tradeCooldownUntil = 0;
    this.tradeCooldownReason = '';
    this.tradeCooldownDetail = '';
    this.emergencyAllInUsed = false;
    this.currentPlan = null;
    this.tradeInFlight = false;

    clearInterval(this.pingTimer);

    for (const watcher of this.contractWatchers.values()) {
      clearTimeout(watcher.timeout);
      watcher.reject(new Error(`Bot stopped: ${reason}`));
    }
    this.contractWatchers.clear();

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Bot stopped: ${reason}`));
    }
    this.pending.clear();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, reason);
    }

    const previous = this.phase;
    this.phase = PHASES.STOPPED;
    this.emit('phase_change', this.phasePayload(previous, this.phase, reason));
    this.emit('bot_stopped', this.summary(reason));
    this.logSummary(reason);
  }

  async connectDeriv() {
    const account = await this.resolveAccount();
    const otp = await this.requestOtp(account.account_id);
    const wsUrl = String(otp?.data?.url || '').trim();

    if (!wsUrl) {
      throw new Error('Deriv did not return a WebSocket URL.');
    }

    this.accountKind = accountTypeFromAccount(account);
    this.accountBalance = roundMoney(toNumber(account.balance, this.accountBalance ?? this.balance));
    this.emit('account', {
      accountId: account.account_id,
      loginid: account.loginid || account.account_id,
      currency: account.currency,
      balance: this.accountBalance,
      accountKind: this.accountKind
    });
    this.emitBalance();
    this.emitAnalysis('connecting', 'Connected to the selected account. Waiting for recent digits and live ticks.');

    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      const openTimeout = setTimeout(() => {
        reject(new Error('Timed out connecting to Deriv WebSocket.'));
      }, 15000);

      this.ws.once('open', () => {
        clearTimeout(openTimeout);
        resolve();
      });

      this.ws.once('error', (error) => {
        clearTimeout(openTimeout);
        reject(error);
      });

      this.ws.on('message', (data) => this.handleDerivMessage(data));
      this.ws.on('close', () => {
        if (!this.stopped) this.stop('connection_closed');
      });
    });

    await this.send({ balance: 1, subscribe: 1 });
    const tickSubscription = await this.send({ ticks: this.options.symbol, subscribe: 1 });
    this.tickSubscriptionId = tickSubscription.subscription && tickSubscription.subscription.id
      ? tickSubscription.subscription.id
      : null;
    this.tickSymbol = this.options.symbol;
    void this.seedHistoricalDigits();
    this.emitAnalysis('listening', 'Live ticks are flowing. Building the digit window now.');

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);
  }

  apiRequest(path, { method = 'GET', body, extraHeaders = {} } = {}) {
    const headers = {
      'Deriv-App-ID': this.options.appId,
      Authorization: `Bearer ${this.options.token}`,
      ...extraHeaders
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    return requestJson(joinUrl(this.options.apiBaseUrl, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }

  async fetchAccounts() {
    const payload = await this.apiRequest('/trading/v1/options/accounts');
    const accounts = normalizeAccountList(payload);
    return accounts.map((account) => ({
      ...account,
      accountType: accountTypeFromAccount(account)
    }));
  }

  pickAccount(accounts) {
    const requestedId = String(this.options.accountId || '').trim();
    const requestedType = this.options.mode;

    if (!accounts.length) {
      throw new Error('Deriv did not return any Options accounts for this token.');
    }

    if (requestedId) {
      const exact = accounts.find((account) => String(account.account_id || '').trim() === requestedId);
      if (!exact) {
        const availableIds = accounts.map((account) => account.account_id).filter(Boolean).join(', ');
        throw new Error(
          `Account ID ${requestedId} was not returned for this token. Available accounts: ${availableIds || 'none'}.`
        );
      }

      if (accountTypeFromAccount(exact) !== requestedType) {
        throw new Error(
          `Selected account ${requestedId} is ${accountTypeFromAccount(exact)}, but the dashboard is set to ${requestedType}.`
        );
      }

      return exact;
    }

    const matching = accounts.filter((account) => accountTypeFromAccount(account) === requestedType);
    const activeMatching = matching.find((account) => String(account.status || '').toLowerCase() === 'active');

    if (activeMatching) return activeMatching;
    if (matching.length) return matching[0];

    const available = accounts.map((account) => `${account.account_id} (${accountTypeFromAccount(account)})`).join(', ');
    throw new Error(
      `No ${requestedType} Options account is available for this token. Available accounts: ${available || 'none'}.`
    );
  }

  async resolveAccount() {
    const accounts = await this.fetchAccounts();
    const account = this.pickAccount(accounts);
    return account;
  }

  async requestOtp(accountId) {
    return this.apiRequest(`/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, {
      method: 'POST'
    });
  }

  async seedHistoricalDigits() {
    const count = Math.max(this.options.windowSize * 2, this.options.windowSize);

    try {
      const response = await this.send({
        ticks_history: this.options.symbol,
        count,
        end: 'latest',
        style: 'ticks'
      });

      const history = response.history || {};
      const prices = Array.isArray(history.prices) ? history.prices : [];
      if (!prices.length) return;

      const pipSizeValue = Number(response.pip_size);
      const pipSize = Number.isFinite(pipSizeValue) ? pipSizeValue : this.lastPipSize;
      const digits = prices
        .map((price) => quoteToDigit(price, pipSize))
        .filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9);

      if (!digits.length) return;

      this.lastPipSize = Number.isFinite(pipSize) ? pipSize : this.lastPipSize;
      const mergedDigits = [...digits, ...this.digits];
      this.digits = mergedDigits.slice(-this.options.windowSize * 3);
      this.emitAnalysis(
        this.digits.length >= this.options.windowSize ? 'ready' : 'warming_up',
        this.digits.length >= this.options.windowSize
          ? `History loaded. Window is ready with ${this.digits.length} digits tracked.`
          : `History loaded. Warming up ${this.digits.length}/${this.options.windowSize}.`
      );
    } catch (error) {
      this.emit('error_event', { message: `Unable to preload recent ticks: ${error.message}` });
    }
  }

  requestSymbolSwitch(nextSymbol, reason = 'auto_symbol_switch') {
    const symbol = normalizeSymbol(nextSymbol, this.options.symbol);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.tickSymbol = symbol;
      return;
    }
    if (this.tickSymbol === symbol || this.symbolSwitchInFlight === symbol) return;

    const previousSymbol = this.tickSymbol;
    this.symbolSwitchInFlight = symbol;
    this.emitAnalysis(
      'symbol_switch',
      `Switching live tick stream ${previousSymbol} -> ${symbol}. Rebuilding the digit window before the next trade.`,
      { auto: this.autoLastDecision, plan: { kind: 'symbol_switch' } }
    );

    (async () => {
      if (this.tickSubscriptionId) {
        await this.send({ forget: this.tickSubscriptionId }, 5000).catch(() => {});
      }

      this.digits = [];
      this.tickSubscriptionId = null;
      const tickSubscription = await this.send({ ticks: symbol, subscribe: 1 });
      this.tickSubscriptionId = tickSubscription.subscription && tickSubscription.subscription.id
        ? tickSubscription.subscription.id
        : null;
      this.tickSymbol = symbol;
      this.symbolSwitchInFlight = null;
      await this.seedHistoricalDigits();
      this.emitAnalysis(
        'symbol_switch',
        `Live tick stream is now ${symbol}. The bot will trade after the window is ready.`,
        { auto: this.autoLastDecision, plan: { kind: 'symbol_switch' } }
      );
    })().catch(async (error) => {
      this.options.symbol = previousSymbol;
      this.lastProposalProfitRatio = this.strategyFallbackProfitRatio();
      try {
        const fallbackSubscription = await this.send({ ticks: previousSymbol, subscribe: 1 }, 5000);
        this.tickSubscriptionId = fallbackSubscription.subscription && fallbackSubscription.subscription.id
          ? fallbackSubscription.subscription.id
          : null;
        this.tickSymbol = previousSymbol;
        void this.seedHistoricalDigits();
      } catch {
        this.tickSubscriptionId = null;
      }
      this.symbolSwitchInFlight = null;
      this.emit('error_event', { message: `Symbol switch failed: ${error.message}` });
    });
  }

  emitAnalysis(stage, detail, extras = {}) {
    const immediate = new Set(['connecting', 'listening', 'ready', 'signal_ready', 'placing_trade', 'auto_commander', 'symbol_switch']);
    const now = Date.now();
    const key = [
      stage,
      extras.currentDigit ?? '',
      extras.condition ? extras.condition.id : '',
      extras.plan ? extras.plan.kind : '',
      extras.auto ? extras.auto.state : '',
      extras.auto ? extras.auto.reason : '',
      extras.tradeInFlight ? '1' : '0'
    ].join('|');

    if (!immediate.has(stage)) {
      if (key === this.analysisState.key && now - this.analysisState.emittedAt < 2000) {
        return;
      }
      if (now - this.analysisState.emittedAt < 1000 && this.analysisState.key.startsWith(stage)) {
        return;
      }
    }

    this.analysisState.key = key;
    this.analysisState.emittedAt = now;
    const calibration = this.goalCalibration();

    this.emit('analysis', {
      time: new Date().toISOString(),
      stage,
      detail,
      phase: this.phase,
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.targetSizingMode(),
      invertDigitSignal: this.options.invertDigitSignal,
      autoModeEnabled: this.options.autoModeEnabled,
      autoCycleMode: this.autoCycleModeEnabled(),
      autoCycleProfit: this.autoCycleProfitTarget(),
      autoCycleStake: this.autoCycleStakeFloor(),
      autoCycleBankedProfit: this.autoCycleBankedProfit,
      autoCycleCompleted: this.autoCycleCompleted,
      autoCycleRecycled: this.autoCycleRecycled,
      autoCyclePartialLocked: this.autoCyclePartialLocked,
      autoCycleHardRecovery: this.autoCycleHardRecovery,
      autoCycleTrades: Math.max(0, this.totalTrades - this.autoCycleStartTrade),
      autoCycleMinBalance: this.autoCycleMinBalance,
      autoCycleStruggled: this.autoCycleStruggled,
      autoCyclePartialExitTradeThreshold: this.options.autoCyclePartialExitTradeThreshold,
      autoCyclePartialExitProfitRatio: this.options.autoCyclePartialExitProfitRatio,
      autoCycleRecycleTradeThreshold: this.options.autoCycleRecycleTradeThreshold,
      strategyTarget: this.strategyTarget(),
      overallProgressRatio: this.overallProgressRatio(),
      autoRiskProfile: this.options.autoRiskProfile,
      autoState: this.autoState,
      autoReason: this.autoReason,
      autoDecision: this.autoLastDecision,
      tradeInFlight: this.tradeInFlight,
      digitsSeen: this.digits.length,
      windowSize: this.options.windowSize,
      currentDigit: extras.currentDigit ?? null,
      candidate: extras.condition ? extras.condition.label : null,
      entryDigit: extras.condition ? extras.condition.entryDigit : null,
      guideFilters: this.options.guideFilters,
      strictBarFilters: this.options.strictBarFilters,
      plan: extras.plan ? extras.plan.kind : null,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: Math.max(0, this.options.blindSniperMaxUses - this.blindSniperUses),
      blindSniperTradesSinceLastShot: this.tradesSinceBlindSniper,
      blindSniperTradesUntilShot: Math.max(0, calibration.sniperCadenceTrades - this.tradesSinceBlindSniper),
      blindSniperProgress: this.sessionProgressRatio(),
      blindSniperArmed: this.blindSniperState().armed,
      growthStairMode: this.growthStairMode(),
      growthStairsEnabled: this.growthStairsEnabled(),
      growthLossStairTier: this.growthLossStairTier,
      growthLossWinStreak: this.growthLossWinStreak,
      lossStairMaxTier: this.options.lossStairMaxTier,
      profitAggression: this.options.profitAggression,
      profitPushStartRatio: calibration.profitPushStartRatio,
      profitPushCapPercent: calibration.profitPushCapPercent,
      estimatedWinProfitRatio: calibration.estimatedWinProfitRatio,
      lastProposalProfitRatio: this.lastProposalProfitRatio,
      matchSniperCooldownUntilTrade: this.matchSniperCooldownUntilTrade,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount,
      martingaleLossStreak: this.martingaleLossStreak,
      splitRecoveryArmed: this.splitRecoveryArmed,
      splitRecoveryReadyAtTrade: this.splitRecoveryReadyAtTrade,
      splitRecoveryPiecesRemaining: this.splitRecoveryPiecesRemaining,
      splitRecoveryCooldownTrades: this.options.splitRecoveryCooldownTrades,
      splitRecoveryPieces: this.options.splitRecoveryPieces,
      splitRecoveryCapPercent: calibration.splitRecoveryCapPercent,
      goalMode: calibration.label
    });
  }

  growthMilestoneStep() {
    return roundMoney(Math.max(
      this.options.minStake * 0.5,
      this.options.seed * this.options.growthMilestonePercent
    ));
  }

  growthStairMode() {
    return normalizeGrowthStairMode(this.options.growthStairMode, this.options.growthStairsEnabled);
  }

  growthStairsEnabled() {
    return this.growthStairMode() !== GROWTH_STAIR_MODES.OFF;
  }

  lossPressureStairsEnabled() {
    return this.growthStairMode() === GROWTH_STAIR_MODES.LOSS_PRESSURE;
  }

  profitStairsEnabled() {
    return this.growthStairMode() === GROWTH_STAIR_MODES.PROFIT;
  }

  growthTier() {
    if (!this.growthStairsEnabled()) return 0;
    if (this.lossPressureStairsEnabled()) {
      return Math.max(0, Math.floor(toNumber(this.growthLossStairTier, 0)));
    }

    const step = this.growthMilestoneStep();
    if (step <= 0) return 0;
    const anchor = Number.isFinite(this.growthAnchorBalance) ? this.growthAnchorBalance : this.options.seed;
    const profitAboveAnchor = Math.max(0, this.effectiveGrowthBalance() - anchor);
    return Math.floor(profitAboveAnchor / step);
  }

  growthStakeFloor(confidenceGate = this.confidenceGateState()) {
    let baseFloor = this.options.minStake;
    if (this.autoCycleModeEnabled()) {
      baseFloor = this.autoCycleStakeFloor();
    } else if (Number.isFinite(this.options.initialStake) && this.options.initialStake !== null) {
      baseFloor = Math.max(this.options.minStake, this.options.initialStake);
    }
    const floors = [baseFloor];

    if (this.growthStairsEnabled()) {
      const tier = confidenceGate.locked ? 0 : this.growthTier();
      floors.push(roundMoney(baseFloor * (1 + tier * this.options.growthStakeBumpPercent)));
    }

    return roundMoney(Math.max(...floors));
  }

  growthStake() {
    const calibration = this.goalCalibration();
    const confidenceGate = this.confidenceGateState();
    const floor = this.growthStakeFloor(confidenceGate);
    const boost = confidenceGate.locked ? 1 : calibration.growthBoost;
    let rawStake = Math.max(this.effectiveGrowthBalance() * this.options.baseStakePercent * boost, floor);
    if (!this.autoCycleModeEnabled() && this.hasCustomInitialStake()) {
      rawStake = Math.max(floor * calibration.customStakeMaxBoost, floor);
    }
    const floorCapPercent = Math.min(1, floor / Math.max(this.effectiveGrowthBalance(), this.options.minStake));
    const capPercent = Math.max(this.options.growthStakeCapPercent, calibration.growthStakeCapPercent, floorCapPercent);
    return this.normalizeStake(rawStake, capPercent);
  }

  hasCustomInitialStake() {
    return Number.isFinite(this.options.initialStake) && this.options.initialStake !== null;
  }

  riskyStakePercent(progress = this.progressRatio()) {
    const calibration = this.goalCalibration();
    const progressValue = clamp(Number(progress) || 0, 0, 1);
    const basePercent = calibration.compact
      ? Math.min(this.options.riskyStakePercent, calibration.compactRiskyStakePercent)
      : this.options.riskyStakePercent;
    return progressValue >= 0.6
      ? basePercent * 0.5
      : basePercent;
  }

  profitAggressionRatio() {
    return clamp((toNumber(this.options.profitAggression, PROFIT_AGGRESSION_DEFAULT) - 1) / 4, 0, 1);
  }

  strategyFallbackProfitRatio() {
    const mode = normalizeDigitStrategyMode(this.options.digitStrategyMode);
    const highRiskRatio = this.options.symbol === 'R_10' ? 3.65 : 3.55;
    const matchRatio = this.options.symbol === 'R_10' ? 7.7 : 7.33;
    if (this.options.invertDigitSignal) {
      if (mode === DIGIT_STRATEGY_MODES.MATCH_SNIPER) return DEFAULT_DIGIT_DIFF_WIN_PROFIT_RATIO;
      if (mode === DIGIT_STRATEGY_MODES.EXTREME) return DEFAULT_DIGIT_WIN_PROFIT_RATIO;
      return highRiskRatio;
    }
    if (mode === DIGIT_STRATEGY_MODES.MATCH_SNIPER) return matchRatio;
    if (mode === DIGIT_STRATEGY_MODES.EXTREME) return highRiskRatio;
    return DEFAULT_DIGIT_WIN_PROFIT_RATIO;
  }

  estimatedWinProfitRatio() {
    return clamp(
      toNumber(this.lastProposalProfitRatio, toNumber(this.lastWinProfitRatio, this.strategyFallbackProfitRatio())),
      0.05,
      10
    );
  }

  autoRiskSettings() {
    const requestedProfile = normalizeAutoRiskProfile(this.options.autoRiskProfile);
    const profile =
      requestedProfile === AUTO_RISK_PROFILES.INSANE_DEMO && this.options.mode !== 'demo'
        ? AUTO_RISK_PROFILES.AGGRESSIVE
        : requestedProfile;

    const settings = {
      [AUTO_RISK_PROFILES.SAFE]: {
        profile,
        minTradesForWinRate: 12,
        minWinRate: 82,
        pressureProgress: 0.42,
        blastProgress: 0.7,
        finishProgress: 0.78,
        fuelFraction: 0.22,
        blastFuelFraction: 0.38,
        baseAggression: 2,
        pressureAggression: 3,
        recoveryAggression: 1,
        defenseAggression: 1,
        finishAggression: 2,
        sniperAllowed: false,
        blastAllowed: false,
        maxLossStreak: 2,
        drawdownDefense: 0.12,
        matchSniperCooldownTrades: 4,
        matchSniperMaxCount: 0
      },
      [AUTO_RISK_PROFILES.BALANCED]: {
        profile,
        minTradesForWinRate: 10,
        minWinRate: 80,
        pressureProgress: 0.32,
        blastProgress: 0.62,
        finishProgress: 0.82,
        fuelFraction: 0.16,
        blastFuelFraction: 0.3,
        baseAggression: 2,
        pressureAggression: 4,
        recoveryAggression: 2,
        defenseAggression: 1,
        finishAggression: 2,
        sniperAllowed: true,
        blastAllowed: false,
        maxLossStreak: 2,
        drawdownDefense: 0.16,
        matchSniperCooldownTrades: 3,
        matchSniperMaxCount: 1
      },
      [AUTO_RISK_PROFILES.AGGRESSIVE]: {
        profile,
        minTradesForWinRate: 8,
        minWinRate: 76,
        pressureProgress: 0.22,
        blastProgress: 0.52,
        finishProgress: 0.86,
        fuelFraction: 0.1,
        blastFuelFraction: 0.22,
        baseAggression: 3,
        pressureAggression: 5,
        recoveryAggression: 2,
        defenseAggression: 1,
        finishAggression: 3,
        sniperAllowed: true,
        blastAllowed: true,
        maxLossStreak: 3,
        drawdownDefense: 0.22,
        matchSniperCooldownTrades: 2,
        matchSniperMaxCount: 1
      },
      [AUTO_RISK_PROFILES.INSANE_DEMO]: {
        profile,
        minTradesForWinRate: 6,
        minWinRate: 70,
        pressureProgress: 0.12,
        blastProgress: 0.35,
        finishProgress: 0.9,
        fuelFraction: 0.06,
        blastFuelFraction: 0.14,
        baseAggression: 4,
        pressureAggression: 5,
        recoveryAggression: 3,
        defenseAggression: 1,
        finishAggression: 3,
        sniperAllowed: true,
        blastAllowed: true,
        maxLossStreak: 3,
        drawdownDefense: 0.28,
        matchSniperCooldownTrades: 1,
        matchSniperMaxCount: 1
      }
    };

    return settings[profile] || settings[AUTO_RISK_PROFILES.BALANCED];
  }

  recentLossStreak() {
    let streak = 0;
    for (let index = this.recentResults.length - 1; index >= 0; index -= 1) {
      if (this.recentResults[index] === 'loss') streak += 1;
      else break;
    }
    return streak;
  }

  autoRelaxedHighRiskEntries() {
    if (!this.options.autoModeEnabled) return false;
    const profile = normalizeAutoRiskProfile(this.options.autoRiskProfile);
    const mode = normalizeDigitStrategyMode(this.options.digitStrategyMode);
    return [AUTO_RISK_PROFILES.AGGRESSIVE, AUTO_RISK_PROFILES.INSANE_DEMO].includes(profile) &&
      [AUTO_STATES.PRESSURE, AUTO_STATES.BLAST].includes(this.autoState) &&
      [DIGIT_STRATEGY_MODES.EXTREME, DIGIT_STRATEGY_MODES.MATCH_SNIPER].includes(mode);
  }

  applyAutoCycleCommander(force = false) {
    const cycleProfit = this.autoCycleProfitTarget();
    const cycleTarget = this.strategyTarget();
    const activeBalance = this.effectiveGrowthBalance();
    const overallProgress = this.overallProgressRatio();
    const recoveryDebt = this.currentRecoveryDebt();
    const nextState = recoveryDebt > 0
      ? AUTO_STATES.RECOVERY
      : activeBalance >= this.options.seed + cycleProfit * 0.75
        ? AUTO_STATES.FINISH
        : AUTO_STATES.GRIND;
    const reason = recoveryDebt > 0
      ? `Auto-cycle recovery is clearing ${recoveryDebt.toFixed(2)} debt inside the current ${cycleProfit.toFixed(2)} profit cycle.`
      : `Auto-cycle ${this.autoCycleCompleted + 1} is running the small-profit preset: active ${activeBalance.toFixed(2)} -> ${cycleTarget.toFixed(2)}, banked ${this.autoCycleBankedProfit.toFixed(2)}.`;
    const patch = {
      symbol: 'R_10',
      digitStrategyMode: DIGIT_STRATEGY_MODES.BASE,
      targetSizingMode: TARGET_SIZING_MODES.PHASED,
      invertDigitSignal: false,
      profitAggression: 4,
      growthStairMode: GROWTH_STAIR_MODES.LOSS_PRESSURE,
      blindSniperMilestones: AUTO_CYCLE_MILESTONES.slice(),
      blindSniperMaxUses: AUTO_CYCLE_MILESTONES.length,
      guideFilters: false,
      strictBarFilters: false,
      matchSniperCooldownTrades: 1,
      matchSniperMaxCount: 1
    };
    const before = {
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.options.targetSizingMode,
      invertDigitSignal: this.options.invertDigitSignal,
      profitAggression: this.options.profitAggression,
      growthStairMode: this.options.growthStairMode,
      blindSniperMilestones: this.options.blindSniperMilestones.slice(),
      blindSniperMaxUses: this.options.blindSniperMaxUses,
      guideFilters: this.options.guideFilters,
      strictBarFilters: this.options.strictBarFilters,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount
    };
    const next = {
      symbol: normalizeSymbol(patch.symbol, before.symbol),
      digitStrategyMode: normalizeDigitStrategyMode(patch.digitStrategyMode),
      targetSizingMode: normalizeTargetSizingMode(patch.targetSizingMode),
      invertDigitSignal: Boolean(patch.invertDigitSignal),
      profitAggression: clamp(toNumber(patch.profitAggression, before.profitAggression), 1, 5),
      growthStairMode: normalizeGrowthStairMode(patch.growthStairMode, true),
      blindSniperMilestones: patch.blindSniperMilestones.slice(),
      blindSniperMaxUses: patch.blindSniperMaxUses,
      guideFilters: Boolean(patch.guideFilters),
      strictBarFilters: Boolean(patch.strictBarFilters),
      matchSniperCooldownTrades: Math.max(1, Math.floor(toNumber(patch.matchSniperCooldownTrades, before.matchSniperCooldownTrades))),
      matchSniperMaxCount: Math.max(0, Math.floor(toNumber(patch.matchSniperMaxCount, before.matchSniperMaxCount)))
    };
    const milestonesChanged = JSON.stringify(before.blindSniperMilestones) !== JSON.stringify(next.blindSniperMilestones);
    const changed = Object.keys(next).some((key) => {
      if (key === 'blindSniperMilestones') return milestonesChanged;
      return before[key] !== next[key];
    });
    const stateChanged = nextState !== this.autoState || reason !== this.autoReason;

    if (changed) {
      const strategyChanged =
        before.symbol !== next.symbol ||
        before.digitStrategyMode !== next.digitStrategyMode ||
        before.targetSizingMode !== next.targetSizingMode ||
        before.invertDigitSignal !== next.invertDigitSignal;

      Object.assign(this.options, next);
      this.options.growthStairsEnabled = this.growthStairsEnabled();
      this.options.blindSniperStartRatio =
        this.options.blindSniperMilestones[this.options.blindSniperMilestones.length - 1] ??
        this.options.blindSniperStartRatio;

      if (strategyChanged) {
        this.lastProposalProfitRatio = this.strategyFallbackProfitRatio();
      }
      if (before.symbol !== next.symbol) {
        this.requestSymbolSwitch(next.symbol, nextState);
      }
    }

    this.autoState = nextState;
    this.autoReason = reason;
    this.autoLastDecision = {
      state: nextState,
      reason,
      profile: this.options.autoRiskProfile,
      mode: 'micro_cycles',
      changed,
      progress: this.progressRatio(),
      overallProgress,
      winRate: this.winRate(),
      activeBalance: roundMoney(activeBalance),
      totalBalance: roundMoney(this.balance),
      bankedProfit: roundMoney(this.autoCycleBankedProfit),
      cycleProfit,
      cycleTarget,
      cycleCompleted: this.autoCycleCompleted,
      cyclePartialLocked: this.autoCyclePartialLocked,
      cycleRecycled: this.autoCycleRecycled,
      cycleTrades: this.autoCycleTrades(),
      cycleMinBalance: this.autoCycleMinBalance,
      cycleStruggled: this.autoCycleStruggled,
      cycleStake: this.autoCycleStakeFloor(),
      recoveryDebt: roundMoney(recoveryDebt),
      remainingGap: roundMoney(Math.max(0, this.options.target - this.balance)),
      lossStreak: this.recentLossStreak(),
      settings: next
    };

    const reviewDue =
      force ||
      this.autoLastReviewTrade < 0 ||
      this.totalTrades === 0 ||
      this.totalTrades - this.autoLastReviewTrade >= this.options.autoReviewIntervalTrades;

    if (changed || stateChanged || reviewDue) {
      this.autoLastReviewTrade = this.totalTrades;
      this.emitAnalysis(
        'auto_commander',
        `${reason} Auto set R_10, base Over 1 / Under 8, loss-pressure stairs, aggression 4/5.`,
        { auto: this.autoLastDecision }
      );
    }

    return {
      enabled: true,
      ...this.autoLastDecision
    };
  }

  applyAutoCommander(force = false) {
    if (!this.options.autoModeEnabled) {
      this.autoState = AUTO_STATES.MANUAL;
      this.autoReason = '';
      return {
        enabled: false,
        state: this.autoState,
        reason: this.autoReason
      };
    }

    if (this.autoCycleModeEnabled()) {
      return this.applyAutoCycleCommander(force);
    }

    const settings = this.autoRiskSettings();
    if (this.options.autoRiskProfile !== settings.profile) {
      this.options.autoRiskProfile = settings.profile;
    }
    const reviewDue =
      force ||
      this.autoLastReviewTrade < 0 ||
      this.totalTrades === 0 ||
      this.totalTrades - this.autoLastReviewTrade >= this.options.autoReviewIntervalTrades;
    const confidenceGate = this.confidenceGateState();
    const progress = this.progressRatio();
    const sessionProgress = this.sessionProgressRatio();
    const winRate = this.winRate();
    const recoveryDebt = this.currentRecoveryDebt();
    const targetGap = Math.max(this.options.minStake, this.options.target - this.options.seed);
    const remainingGap = Math.max(0, this.options.target - this.effectiveGrowthBalance());
    const profitAboveSeed = Math.max(0, this.effectiveGrowthBalance() - this.options.seed);
    const profitFuel = Math.max(0, this.effectiveGrowthBalance() - Math.max(this.options.seed, this.riskFloor));
    const fuelNeeded = Math.max(this.options.minStake * 2, targetGap * settings.fuelFraction);
    const blastFuelNeeded = Math.max(this.options.minStake * 3, targetGap * settings.blastFuelFraction);
    const lossStreak = this.recentLossStreak();
    const weakWinRate = this.totalTrades >= settings.minTradesForWinRate && winRate < settings.minWinRate;
    const drawdownDefense = this.effectiveGrowthBalance() < this.options.seed * (1 - settings.drawdownDefense);
    const recoveryOpen =
      recoveryDebt > 0 ||
      this.splitRecoveryArmed ||
      [PHASES.MARTINGALE, PHASES.REBUILD].includes(this.phase);
    const defenseNeeded =
      !recoveryOpen &&
      (confidenceGate.locked || weakWinRate || drawdownDefense || lossStreak >= settings.maxLossStreak);
    const canSpendFuel =
      !recoveryOpen &&
      !defenseNeeded &&
      this.phase !== PHASES.STOPPED &&
      profitFuel >= fuelNeeded &&
      (this.totalTrades < settings.minTradesForWinRate || winRate >= settings.minWinRate);
    const pressureEligible =
      canSpendFuel &&
      progress >= settings.pressureProgress &&
      remainingGap > this.options.minStake;
    const blastEligible =
      pressureEligible &&
      settings.blastAllowed &&
      progress >= settings.blastProgress &&
      profitFuel >= blastFuelNeeded &&
      (this.totalTrades < settings.minTradesForWinRate || winRate >= settings.minWinRate + 4);
    const finishNeeded =
      !recoveryOpen &&
      progress >= settings.finishProgress &&
      remainingGap <= Math.max(this.options.minStake * 2, targetGap * 0.25);

    let nextState = AUTO_STATES.GRIND;
    let reason = 'Auto is grinding with the base strategy until it earns enough profit fuel.';
    const patch = {
      symbol: 'R_10',
      digitStrategyMode: DIGIT_STRATEGY_MODES.BASE,
      profitAggression: settings.baseAggression,
      growthStairMode: GROWTH_STAIR_MODES.LOSS_PRESSURE,
      blindSniperEnabled: false,
      guideFilters: false,
      strictBarFilters: false,
      matchSniperCooldownTrades: settings.matchSniperCooldownTrades,
      matchSniperMaxCount: settings.matchSniperMaxCount
    };

    if (this.totalTrades < settings.minTradesForWinRate && profitAboveSeed < fuelNeeded) {
      nextState = AUTO_STATES.SCOUT;
      reason = `Auto scout is collecting ${settings.minTradesForWinRate} trades or ${fuelNeeded.toFixed(2)} profit fuel before unlocking high-risk weapons.`;
      patch.profitAggression = Math.min(settings.baseAggression, 2);
      patch.growthStairMode = GROWTH_STAIR_MODES.OFF;
    } else if (recoveryOpen) {
      nextState = AUTO_STATES.RECOVERY;
      reason = `Auto recovery is active because ${recoveryDebt.toFixed(2)} recovery debt is open. High-risk weapons are locked until the debt clears.`;
      patch.profitAggression = settings.recoveryAggression;
      patch.growthStairMode = GROWTH_STAIR_MODES.OFF;
    } else if (defenseNeeded) {
      nextState = AUTO_STATES.DEFENSE;
      reason = weakWinRate
        ? `Auto defense is active because win rate ${winRate.toFixed(1)}% is below ${settings.minWinRate}%.`
        : drawdownDefense
          ? 'Auto defense is active because session equity is under the drawdown defense line.'
          : lossStreak >= settings.maxLossStreak
            ? `Auto defense is active after ${lossStreak} consecutive losses.`
            : 'Auto defense is active because the confidence gate is locked.';
      patch.profitAggression = settings.defenseAggression;
      patch.growthStairMode = GROWTH_STAIR_MODES.OFF;
    } else if (finishNeeded) {
      nextState = AUTO_STATES.FINISH;
      reason = `Auto finish mode is protecting progress near target. Remaining gap ${remainingGap.toFixed(2)}; high-risk weapons are locked.`;
      patch.profitAggression = settings.finishAggression;
      patch.growthStairMode = GROWTH_STAIR_MODES.LOSS_PRESSURE;
    } else if (blastEligible) {
      nextState = AUTO_STATES.BLAST;
      reason = `Auto blast unlocked: profit fuel ${profitFuel.toFixed(2)} covers the ${blastFuelNeeded.toFixed(2)} blast requirement.`;
      patch.digitStrategyMode = DIGIT_STRATEGY_MODES.MATCH_SNIPER;
      patch.profitAggression = settings.pressureAggression;
      patch.blindSniperEnabled = settings.sniperAllowed;
      patch.growthStairMode = GROWTH_STAIR_MODES.LOSS_PRESSURE;
    } else if (pressureEligible) {
      nextState = AUTO_STATES.PRESSURE;
      reason = `Auto pressure unlocked: profit fuel ${profitFuel.toFixed(2)} covers the ${fuelNeeded.toFixed(2)} high-risk requirement.`;
      patch.digitStrategyMode = DIGIT_STRATEGY_MODES.EXTREME;
      patch.profitAggression = settings.pressureAggression;
      patch.blindSniperEnabled = settings.sniperAllowed && profitFuel >= Math.max(this.options.minStake * 3, targetGap * 0.2);
      patch.growthStairMode = GROWTH_STAIR_MODES.LOSS_PRESSURE;
    } else {
      nextState = AUTO_STATES.GRIND;
      reason = `Auto grind is building fuel. Profit fuel ${profitFuel.toFixed(2)}/${fuelNeeded.toFixed(2)}, progress ${Math.round(progress * 100)}%.`;
      patch.profitAggression = settings.baseAggression;
    }

    const before = {
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      profitAggression: this.options.profitAggression,
      growthStairMode: this.options.growthStairMode,
      blindSniperEnabled: this.options.blindSniperEnabled,
      guideFilters: this.options.guideFilters,
      strictBarFilters: this.options.strictBarFilters,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount
    };

    const next = {
      symbol: normalizeSymbol(patch.symbol, before.symbol),
      digitStrategyMode: normalizeDigitStrategyMode(patch.digitStrategyMode),
      profitAggression: clamp(toNumber(patch.profitAggression, before.profitAggression), 1, 5),
      growthStairMode: normalizeGrowthStairMode(patch.growthStairMode, patch.growthStairMode !== GROWTH_STAIR_MODES.OFF),
      blindSniperEnabled: Boolean(patch.blindSniperEnabled),
      guideFilters: Boolean(patch.guideFilters),
      strictBarFilters: Boolean(patch.strictBarFilters),
      matchSniperCooldownTrades: Math.max(1, Math.floor(toNumber(patch.matchSniperCooldownTrades, before.matchSniperCooldownTrades))),
      matchSniperMaxCount: Math.max(0, Math.floor(toNumber(patch.matchSniperMaxCount, before.matchSniperMaxCount)))
    };

    const changed = Object.keys(next).some((key) => before[key] !== next[key]);
    const stateChanged = nextState !== this.autoState || reason !== this.autoReason;

    if (changed) {
      const strategyChanged =
        before.symbol !== next.symbol ||
        before.digitStrategyMode !== next.digitStrategyMode;
      Object.assign(this.options, next);
      if (strategyChanged) {
        this.lastProposalProfitRatio = this.strategyFallbackProfitRatio();
      }
      if (before.symbol !== next.symbol) {
        this.requestSymbolSwitch(next.symbol, nextState);
      }
    }

    this.autoState = nextState;
    this.autoReason = reason;
    this.autoLastDecision = {
      state: nextState,
      reason,
      profile: settings.profile,
      changed,
      progress,
      sessionProgress,
      winRate,
      profitFuel: roundMoney(profitFuel),
      fuelNeeded: roundMoney(fuelNeeded),
      blastFuelNeeded: roundMoney(blastFuelNeeded),
      recoveryDebt: roundMoney(recoveryDebt),
      remainingGap: roundMoney(remainingGap),
      lossStreak,
      settings: next
    };

    if (changed || stateChanged || reviewDue) {
      this.autoLastReviewTrade = this.totalTrades;
      this.emitAnalysis(
        'auto_commander',
        `${reason} Auto set ${next.symbol}, ${next.digitStrategyMode}, aggression ${next.profitAggression}/5.`,
        { auto: this.autoLastDecision }
      );
    }

    return {
      enabled: true,
      ...this.autoLastDecision
    };
  }

  autoTelemetry() {
    return {
      autoModeEnabled: this.options.autoModeEnabled,
      autoCycleMode: this.autoCycleModeEnabled(),
      autoCycleProfit: this.autoCycleProfitTarget(),
      autoCycleStake: this.autoCycleStakeFloor(),
      autoCycleBankedProfit: this.autoCycleBankedProfit,
      autoCycleCompleted: this.autoCycleCompleted,
      autoCycleRecycled: this.autoCycleRecycled,
      autoCyclePartialLocked: this.autoCyclePartialLocked,
      autoCycleHardRecovery: this.autoCycleHardRecovery,
      autoCycleStartTrade: this.autoCycleStartTrade,
      autoCycleTrades: this.autoCycleTrades(),
      autoCycleMinBalance: this.autoCycleMinBalance,
      autoCycleStruggled: this.autoCycleStruggled,
      autoCyclePartialExitTradeThreshold: this.options.autoCyclePartialExitTradeThreshold,
      autoCyclePartialExitProfitRatio: this.options.autoCyclePartialExitProfitRatio,
      autoCycleRecycleTradeThreshold: this.options.autoCycleRecycleTradeThreshold,
      strategyTarget: this.strategyTarget(),
      overallProgressRatio: this.overallProgressRatio(),
      autoRiskProfile: this.options.autoRiskProfile,
      autoState: this.autoState,
      autoReason: this.autoReason,
      autoDecision: this.autoLastDecision,
      autoReviewIntervalTrades: this.options.autoReviewIntervalTrades,
      autoLastReviewTrade: this.autoLastReviewTrade,
      recentResults: this.recentResults.slice(-20)
    };
  }

  progressRatio() {
    const span = Math.max(0.01, this.strategyTarget() - this.options.seed);
    return clamp((this.effectiveGrowthBalance() - this.options.seed) / span, 0, 1);
  }

  confidenceGateState() {
    const progress = this.progressRatio();
    const winRate = this.winRate();

    if (this.autoCycleModeEnabled()) {
      this.confidenceGateLocked = false;
      return {
        locked: false,
        progress,
        winRate,
        triggerWinRate: CONFIDENCE_GUARD_TRIGGER_WIN_RATE,
        releaseWinRate: CONFIDENCE_GUARD_RELEASE_WIN_RATE
      };
    }

    if (this.confidenceGateLocked) {
      if (progress <= 0 || winRate >= CONFIDENCE_GUARD_RELEASE_WIN_RATE) {
        this.confidenceGateLocked = false;
      }
    } else if (progress > 0 && winRate < CONFIDENCE_GUARD_TRIGGER_WIN_RATE) {
      this.confidenceGateLocked = true;
    }

    return {
      locked: this.confidenceGateLocked,
      progress,
      winRate,
      triggerWinRate: CONFIDENCE_GUARD_TRIGGER_WIN_RATE,
      releaseWinRate: CONFIDENCE_GUARD_RELEASE_WIN_RATE
    };
  }

  confidenceThrottleState(confidenceGate = this.confidenceGateState()) {
    const calibration = this.goalCalibration();
    const eligible =
      confidenceGate.locked &&
      confidenceGate.progress > 0 &&
      this.totalTrades >= CONFIDENCE_THROTTLE_MIN_TRADES;

    if (!eligible) {
      return {
        active: false,
        cooldownMs: 0,
        reason: '',
        detail: '',
        remainingMs: 0
      };
    }

    const deficit = Math.max(0, confidenceGate.triggerWinRate - confidenceGate.winRate);
    const severity = clamp(deficit, 0, 8);
    const cooldownFloor = CONFIDENCE_THROTTLE_MIN_MS * calibration.riskCooldownScale;
    const cooldownMs = Math.round(
      clamp(
        (CONFIDENCE_THROTTLE_MIN_MS + severity * 700 + (confidenceGate.winRate < 80 ? 1000 : 0)) *
          calibration.riskCooldownScale,
        cooldownFloor,
        CONFIDENCE_THROTTLE_MAX_MS
      )
    );

    return {
      active: cooldownMs > 0,
      cooldownMs,
      reason: 'confidence_throttle',
      detail: `Win rate ${confidenceGate.winRate.toFixed(1)}% is below the confidence line. Keeping small growth trades moving while delaying risky jumps, martingale recovery, and sniper shots for about ${Math.max(1, Math.ceil(cooldownMs / 1000))} second(s).`,
      remainingMs: Math.max(0, cooldownMs)
    };
  }

  setTradeCooldown(durationMs, reason, detail = '') {
    const now = Date.now();
    const until = now + Math.max(0, Math.floor(durationMs));
    if (until >= this.tradeCooldownUntil) {
      this.tradeCooldownUntil = until;
      this.tradeCooldownReason = String(reason || '');
      this.tradeCooldownDetail = String(detail || '');
    }
  }

  planShouldWaitForThrottle(plan) {
    if (!plan || Date.now() >= this.tradeCooldownUntil) return false;
    return [
      PHASES.RISKY,
      PHASES.MARTINGALE,
      PHASES.BLIND_SNIPER,
      'split_recovery'
    ].includes(plan.kind);
  }

  emergencyAllInState() {
    const calibration = this.goalCalibration();
    const threshold = Math.max(2, Math.floor(toNumber(this.options.allInLossStreakThreshold, 3)));
    const stakePercent = clamp(toNumber(this.options.allInStakePercent, 0.25), 0.05, 1);
    const strategyMode = normalizeDigitStrategyMode(this.options.digitStrategyMode);
    const highRiskBlocked = strategyMode !== DIGIT_STRATEGY_MODES.BASE;
    const debt = this.currentRecoveryDebt();
    const stake = highRiskBlocked ? 0 : this.emergencyRecoveryStake(calibration);
    const capPercent = Math.min(stakePercent, calibration.emergencyRecoveryCapPercent);
    const armed =
      !this.stopped &&
      this.balance >= this.options.minStake &&
      !this.emergencyAllInUsed &&
      !highRiskBlocked &&
      debt > 0 &&
      stake >= this.options.minStake &&
      this.martingaleLossStreak >= threshold;

    return {
      armed,
      threshold,
      stakePercent,
      stake,
      capPercent,
      highRiskBlocked,
      strategyMode,
      recoveryDebt: debt
    };
  }

  isLossPressurePlan(plan) {
    return [PHASES.GROWTH, 'profit_push', 'initial_stake'].includes(plan && plan.kind);
  }

  resetGrowthLossStairs() {
    this.growthLossStairTier = 0;
    this.growthLossWinStreak = 0;
  }

  updateLossPressureStairs(plan, result) {
    if (!this.lossPressureStairsEnabled() || !this.isLossPressurePlan(plan)) return;

    if (result.won) {
      this.growthLossWinStreak += 1;
      if (this.currentRecoveryDebt() <= 0 || this.growthLossWinStreak >= this.options.lossStairWinResetCount) {
        this.resetGrowthLossStairs();
      } else {
        this.growthLossStairTier = Math.max(1, this.growthLossStairTier - 1);
      }
      return;
    }

    this.growthLossWinStreak = 0;
    this.growthLossStairTier = Math.min(
      this.options.lossStairMaxTier,
      Math.max(0, this.growthLossStairTier) + 1
    );
  }

  lossPressureState(plan = null) {
    const enabled = this.lossPressureStairsEnabled();
    const debt = this.currentRecoveryDebt();
    const debtCap = Math.max(this.options.minStake, this.balance * this.options.lossStairDebtCapPercent);
    const tier = Math.max(0, Math.floor(toNumber(this.growthLossStairTier, 0)));
    const canAbsorb =
      enabled &&
      this.isLossPressurePlan(plan) &&
      !this.splitRecoveryArmed &&
      tier > 0 &&
      tier < this.options.lossStairMaxTier &&
      debt > 0 &&
      debt <= debtCap;

    return {
      enabled,
      canAbsorb,
      tier,
      maxTier: this.options.lossStairMaxTier,
      winStreak: this.growthLossWinStreak,
      winResetCount: this.options.lossStairWinResetCount,
      debt,
      debtCap: roundMoney(debtCap),
      debtCapPercent: this.options.lossStairDebtCapPercent,
      mode: this.growthStairMode()
    };
  }

  sessionProgressRatio() {
    const span = Math.max(0.01, this.strategyTarget() - this.options.seed);
    return clamp((this.effectiveGrowthBalance() - this.options.seed) / span, -1, 1);
  }

  goalCalibration() {
    const seed = Math.max(this.options.minStake, this.options.seed);
    const target = Math.max(seed + this.options.minStake, this.strategyTarget());
    const gap = Math.max(0, target - seed);
    const gapRatio = gap / Math.max(0.01, seed);
    const compact = gapRatio <= 0.25;
    const aggression = this.profitAggressionRatio();

    return {
      compact,
      label: this.autoCycleModeEnabled()
        ? 'auto-cycle'
        : this.boldTargetSizingEnabled()
          ? 'bold'
          : compact ? 'compact' : 'standard',
      targetSizingMode: this.targetSizingMode(),
      strategyTarget: target,
      overallTarget: this.options.target,
      autoCycleMode: this.autoCycleModeEnabled(),
      autoCycleProfit: this.autoCycleProfitTarget(),
      autoCycleStake: this.autoCycleStakeFloor(),
      autoCycleBankedProfit: this.autoCycleBankedProfit,
      autoCycleCompleted: this.autoCycleCompleted,
      gap,
      gapRatio,
      profitAggression: this.options.profitAggression,
      profitAggressionRatio: aggression,
      customStakeMaxBoost: compact ? 1 + aggression * 0.2 : 1 + aggression * 0.08,
      growthBoost: compact ? 1.25 + aggression * 0.45 : 1 + aggression * 0.12,
      growthStakeCapPercent: compact
        ? Math.max(this.options.growthStakeCapPercent, 0.12 + aggression * 0.06)
        : this.options.growthStakeCapPercent,
      floorRetainPercent: compact ? 0.65 : 1,
      recoveryCapPercent: compact ? 0.18 : 0.24,
      recoveryGapFraction: compact ? 0.35 : 0.5,
      splitRecoveryCapPercent: compact ? 0.15 + aggression * 0.03 : this.options.splitRecoveryCapPercent,
      splitRecoveryGapFraction: compact ? 0.25 : 0.33,
      sniperBoost: compact ? 1.2 + aggression * 0.35 : 1,
      sniperGapFraction: compact ? 0.38 + aggression * 0.12 : 1 / 3,
      sniperProfitCapFraction: compact ? 0.3 + aggression * 0.15 : BLIND_SNIPER_PROFIT_CAP_FRACTION,
      sniperProgressTaperFloor: compact ? 0.14 + aggression * 0.08 : BLIND_SNIPER_PROGRESS_TAPER_FLOOR,
      sniperCadenceTrades: compact
        ? Math.max(1, this.options.blindSniperCadenceTrades - (aggression >= 0.75 ? 2 : 1))
        : this.options.blindSniperCadenceTrades,
      martingaleRetryLimit: compact ? 1 : this.options.martingaleRetryLimit,
      compactRiskyStakePercent: compact ? 0.08 + aggression * 0.07 : this.options.riskyStakePercent,
      profitGateGapFraction: compact ? 0.62 - aggression * 0.22 : 1,
      profitPushStartRatio: compact ? Math.max(0.18, 0.4 - aggression * 0.18) : 0.7,
      profitPushGapFraction: compact ? 0.35 + aggression * 0.25 : 0.25 + aggression * 0.15,
      profitPushStakeMultiplier: 1.15 + aggression * 0.9,
      customProfitPushStakeMultiplier: compact ? 1.25 + aggression * 0.45 : 1.15 + aggression * 0.3,
      profitPushCapPercent: compact ? 0.08 + aggression * 0.08 : 0.06 + aggression * 0.04,
      emergencyRecoveryCapPercent: compact ? 0.08 + aggression * 0.04 : 0.12 + aggression * 0.05,
      emergencyRecoveryGapFraction: compact ? 0.35 + aggression * 0.15 : 0.5,
      emergencyRecoveryStakeMultiplier: compact ? 1.05 + aggression * 0.35 : 1.1 + aggression * 0.45,
      riskCooldownScale: 1 - aggression * 0.35,
      boldStake: this.boldTargetStake(),
      estimatedWinProfitRatio: this.estimatedWinProfitRatio()
    };
  }

  lockedProfitFloor(balance = this.effectiveGrowthBalance()) {
    const calibration = this.goalCalibration();
    const baseBalance = roundMoney(Math.max(this.options.seed, Number(balance) || this.options.seed));
    const profitAboveSeed = Math.max(0, baseBalance - this.options.seed);
    return roundMoney(this.options.seed + profitAboveSeed * calibration.floorRetainPercent);
  }

  sniperProgressStage(progress = this.sessionProgressRatio()) {
    const milestones = Array.isArray(this.options.blindSniperMilestones) && this.options.blindSniperMilestones.length
      ? this.options.blindSniperMilestones
      : [this.options.blindSniperStartRatio];
    return milestones.filter((milestone) => progress >= milestone).length;
  }

  syncBlindSniperCursor(progress = this.sessionProgressRatio()) {
    const stage = this.sniperProgressStage(progress);
    if (stage < this.blindSniperUses) {
      this.blindSniperUses = stage;
    }
    return stage;
  }

  autoCycleModeEnabled() {
    return this.options.autoModeEnabled && this.options.autoCycleMode;
  }

  autoCycleProfitTarget() {
    const totalGap = Math.max(this.options.minStake * 0.2, this.options.target - this.options.seed);
    const configured = toOptionalNumber(this.options.autoCycleProfit, null);
    const defaultProfit = Math.max(this.options.minStake * 2, this.options.seed * AUTO_CYCLE_DEFAULT_PROFIT_PERCENT);
    return roundMoney(clamp(configured ?? defaultProfit, this.options.minStake * 0.2, totalGap));
  }

  autoCycleStakeFloor() {
    const configured = toOptionalNumber(this.options.autoCycleStake, null);
    const initial = toOptionalNumber(this.options.initialStake, null);
    const defaultStake = this.options.seed * AUTO_CYCLE_DEFAULT_STAKE_PERCENT;
    return roundMoney(Math.max(this.options.minStake, configured ?? initial ?? defaultStake));
  }

  autoCycleOverallProfitTarget() {
    return roundMoney(Math.max(this.options.minStake * 0.2, this.options.target - this.options.seed));
  }

  strategyTarget() {
    return this.autoCycleModeEnabled()
      ? roundMoney(this.options.seed + this.autoCycleProfitTarget())
      : this.options.target;
  }

  activeTradeBalance() {
    return roundMoney(this.balance);
  }

  effectiveGrowthBalance() {
    return this.activeTradeBalance();
  }

  overallProgressRatio() {
    if (this.autoCycleModeEnabled()) {
      return clamp(this.autoCycleBankedProfit / Math.max(0.01, this.autoCycleOverallProfitTarget()), -1, 1);
    }
    const span = Math.max(0.01, this.options.target - this.options.seed);
    return clamp((this.balance - this.options.seed) / span, -1, 1);
  }

  sessionProfitLoss() {
    if (this.autoCycleModeEnabled()) {
      return roundMoney(this.autoCycleBankedProfit);
    }
    return roundMoney(this.balance - this.options.seed);
  }

  sessionNetProfitLoss() {
    if (this.autoCycleModeEnabled()) {
      return roundMoney(this.autoCycleBankedProfit + this.balance - this.options.seed);
    }
    return roundMoney(this.balance - this.options.seed);
  }

  targetSizingMode() {
    return normalizeTargetSizingMode(this.options.targetSizingMode);
  }

  boldTargetSizingEnabled() {
    return this.targetSizingMode() === TARGET_SIZING_MODES.BOLD;
  }

  currentRecoveryDebt() {
    return Math.max(0, roundMoney(this.riskFloor - this.effectiveGrowthBalance()));
  }

  stopLossTriggered() {
    return this.effectiveGrowthBalance() < this.options.seed * 0.5;
  }

  autoCycleTrades() {
    return Math.max(0, this.totalTrades - this.autoCycleStartTrade);
  }

  updateAutoCycleTracking() {
    if (!this.autoCycleModeEnabled()) return;
    const active = this.effectiveGrowthBalance();
    this.autoCycleMinBalance = roundMoney(Math.min(this.autoCycleMinBalance, active));
    if (active < this.options.seed) {
      this.autoCycleStruggled = true;
    }
  }

  autoCycleExitReason() {
    if (!this.autoCycleModeEnabled()) return null;
    const active = this.effectiveGrowthBalance();
    const cycleProfit = this.autoCycleProfitTarget();
    const cycleTrades = this.autoCycleTrades();
    const partialTarget = this.options.seed + cycleProfit * this.options.autoCyclePartialExitProfitRatio;

    if (active >= this.strategyTarget()) return 'cycle_target_hit';
    if (
      this.autoCycleStruggled &&
      cycleTrades >= this.options.autoCyclePartialExitTradeThreshold &&
      active >= partialTarget
    ) {
      return 'struggle_partial_profit_lock';
    }
    if (
      (this.autoCycleHardRecovery || this.autoCycleStruggled) &&
      cycleTrades >= this.options.autoCycleRecycleTradeThreshold &&
      active >= this.options.seed
    ) {
      return 'long_recovery_break_even';
    }
    return null;
  }

  resetAutoCycle(reason = 'cycle_reset') {
    if (!this.autoCycleModeEnabled()) return false;
    const activeBefore = this.effectiveGrowthBalance();
    if (activeBefore < this.options.seed) return false;

    const cycleTradesBefore = this.autoCycleTrades();
    const realizedCycleProfit = roundMoney(Math.max(0, activeBefore - this.options.seed));
    const completed = activeBefore >= this.strategyTarget();
    const partialLocked = reason === 'struggle_partial_profit_lock' && !completed;
    if (completed || partialLocked) {
      this.autoCycleBankedProfit = roundMoney(this.autoCycleBankedProfit + realizedCycleProfit);
    }
    if (completed) {
      this.autoCycleCompleted += 1;
    } else if (partialLocked) {
      this.autoCyclePartialLocked += 1;
    } else {
      this.autoCycleRecycled += 1;
    }

    this.balance = this.options.seed;
    this.phase = PHASES.GROWTH;
    this.riskFloor = this.options.seed;
    this.recoveryDebt = 0;
    this.growthAnchorBalance = this.options.seed;
    this.martingaleLossStreak = 0;
    this.emergencyAllInUsed = false;
    this.autoCycleHardRecovery = false;
    this.autoCycleStartTrade = this.totalTrades;
    this.autoCycleMinBalance = this.options.seed;
    this.autoCycleStruggled = false;
    this.clearSplitRecovery(null);
    this.resetGrowthLossStairs();
    this.blindSniperUses = 0;
    this.tradesSinceBlindSniper = 0;
    this.initialStakeUsed = false;

    this.emitAnalysis(
      'auto_cycle_reset',
      completed
        ? `Auto-cycle banked ${realizedCycleProfit.toFixed(2)} profit and started a fresh independent cycle.`
        : partialLocked
          ? `Auto-cycle struggled for ${cycleTradesBefore} trades, recovered more than half the cycle target, banked ${realizedCycleProfit.toFixed(2)}, and started fresh.`
          : `Auto-cycle recovered to seed after a long hard recovery. It is closing the damaged loop at break-even and starting fresh.`,
      {
        plan: { kind: 'auto_cycle_reset' },
        auto: {
          state: this.autoState,
          reason,
          activeBefore: roundMoney(activeBefore),
          cycleTrades: cycleTradesBefore,
          realizedCycleProfit,
          bankedProfit: this.autoCycleBankedProfit,
          cycleCompleted: this.autoCycleCompleted,
          cyclePartialLocked: this.autoCyclePartialLocked,
          cycleRecycled: this.autoCycleRecycled
        }
      }
    );
    this.emitBalance();
    if (this.autoCycleBankedProfit >= this.autoCycleOverallProfitTarget()) {
      void this.stop('take_profit');
    }
    return true;
  }

  blindSniperSizing() {
    const calibration = this.goalCalibration();
    const balance = this.effectiveGrowthBalance();
    const progress = clamp(this.sessionProgressRatio(), 0, 1);
    const remainingGap = Math.max(0, this.strategyTarget() - balance);
    const profitAboveFloor = Math.max(0, balance - this.riskFloor);
    const stakeFraction = clamp(this.options.blindSniperStakeFraction * calibration.sniperBoost, 0, 1);
    const legacyStake = Math.max(this.options.minStake, balance * stakeFraction);
    const progressTaper = clamp(1 - progress, calibration.sniperProgressTaperFloor, 1);
    const taperedStake = legacyStake * progressTaper;
    const gapCap = Math.max(this.options.minStake, remainingGap * calibration.sniperGapFraction);
    const profitCap = Math.max(this.options.minStake, profitAboveFloor * calibration.sniperProfitCapFraction);
    const rawStake = Math.max(this.options.minStake, Math.min(taperedStake, gapCap, profitCap));

    return {
      stake: roundMoney(rawStake),
      rawStake: roundMoney(legacyStake),
      taperedStake: roundMoney(taperedStake),
      gapCap: roundMoney(gapCap),
      profitCap: roundMoney(profitCap),
      remainingGap: roundMoney(remainingGap),
      profitAboveFloor: roundMoney(profitAboveFloor),
      progressTaper: roundMoney(progressTaper),
      capped: rawStake < legacyStake - 1e-9
    };
  }

  blindSniperState(confidenceGate = this.confidenceGateState()) {
    const enabled = this.options.blindSniperEnabled;
    const calibration = this.goalCalibration();
    const progress = this.sessionProgressRatio();
    const sizing = this.blindSniperSizing();
    const milestones = Array.isArray(this.options.blindSniperMilestones) && this.options.blindSniperMilestones.length
      ? this.options.blindSniperMilestones
      : [this.options.blindSniperStartRatio];
    const maxUses = Math.max(1, milestones.length);
    const progressStage = this.syncBlindSniperCursor(progress);
    const milestoneIndex = Math.min(this.blindSniperUses, milestones.length);
    const usesRemaining = Math.max(0, maxUses - this.blindSniperUses);
    const cadenceTrades = calibration.sniperCadenceTrades;
    const tradesUntilShot = Math.max(0, cadenceTrades - this.tradesSinceBlindSniper);
    const confidenceBlocked = Boolean(confidenceGate.locked && confidenceGate.progress > 0);
    const recoveryDebtOpen = this.currentRecoveryDebt() > 0;
    const phaseReady =
      ![PHASES.MARTINGALE, PHASES.REBUILD, PHASES.STOPPED].includes(this.phase) &&
      !this.splitRecoveryArmed &&
      !recoveryDebtOpen &&
      !confidenceBlocked;
    const nextMilestone = milestoneIndex < milestones.length ? milestones[milestoneIndex] : null;
    const armed =
      enabled &&
      phaseReady &&
      usesRemaining > 0 &&
      nextMilestone !== null &&
      progress >= nextMilestone &&
      this.tradesSinceBlindSniper >= cadenceTrades;

    let reason = 'disabled';
    if (!enabled) {
      reason = 'disabled';
    } else if (usesRemaining <= 0) {
      reason = 'quota_exhausted';
    } else if (!phaseReady) {
      reason = confidenceBlocked
        ? 'confidence_blocked'
        : this.splitRecoveryArmed || recoveryDebtOpen
          ? 'recovery_blocked'
          : 'phase_blocked';
    } else if (nextMilestone !== null && progress < nextMilestone) {
      reason = 'progress_wait';
    } else if (this.tradesSinceBlindSniper < cadenceTrades) {
      reason = 'cadence_wait';
    } else {
      reason = 'armed';
    }

    return {
      enabled,
      armed,
      reason,
      progress,
      uses: this.blindSniperUses,
      usesRemaining,
      milestones,
      milestoneIndex,
      progressStage,
      nextMilestone,
      stake: sizing.stake,
      rawStake: sizing.rawStake,
      taperedStake: sizing.taperedStake,
      gapCap: sizing.gapCap,
      profitCap: sizing.profitCap,
      remainingGap: sizing.remainingGap,
      profitAboveFloor: sizing.profitAboveFloor,
      progressTaper: sizing.progressTaper,
      stakeCapped: sizing.capped,
      cadenceTrades,
      tradesSinceLastShot: this.tradesSinceBlindSniper,
      tradesUntilShot,
      maxUses,
      startRatio: this.options.blindSniperStartRatio,
      stakeFraction: this.options.blindSniperStakeFraction,
      confidenceGateLocked: confidenceBlocked,
      recoveryDebtOpen,
      confidenceGateWinRate: confidenceGate.winRate,
      confidenceGateTriggerWinRate: confidenceGate.triggerWinRate,
      confidenceGateReleaseWinRate: confidenceGate.releaseWinRate
    };
  }

  blindSniperStake(confidenceGate = this.confidenceGateState()) {
    return this.blindSniperState(confidenceGate).stake;
  }

  profitGateStep() {
    const calibration = this.goalCalibration();
    const baseStep = Math.max(this.options.minStake * 2, this.options.seed * this.options.profitGatePercent);
    if (!calibration.compact) return roundMoney(baseStep);

    const gapStep = Math.max(this.options.minStake * 2, calibration.gap * calibration.profitGateGapFraction);
    return roundMoney(Math.min(baseStep, gapStep));
  }

  profitPushState(confidenceGate = this.confidenceGateState()) {
    const calibration = this.goalCalibration();
    const progress = this.progressRatio();
    const debt = this.currentRecoveryDebt();
    const phaseBlocked = [PHASES.MARTINGALE, PHASES.REBUILD, PHASES.STOPPED].includes(this.phase);
    const confidenceBlocked = Boolean(confidenceGate.locked && confidenceGate.progress > 0);
    const armed =
      calibration.compact &&
      !phaseBlocked &&
      !confidenceBlocked &&
      !this.splitRecoveryArmed &&
      debt <= 0 &&
      this.effectiveGrowthBalance() < this.strategyTarget() &&
      progress >= calibration.profitPushStartRatio;

    let reason = 'standard_goal';
    if (!calibration.compact) {
      reason = 'standard_goal';
    } else if (phaseBlocked) {
      reason = 'phase_blocked';
    } else if (confidenceBlocked) {
      reason = 'confidence_blocked';
    } else if (this.splitRecoveryArmed || debt > 0) {
      reason = 'recovery_blocked';
    } else if (this.effectiveGrowthBalance() >= this.strategyTarget()) {
      reason = 'target_reached';
    } else if (progress < calibration.profitPushStartRatio) {
      reason = 'progress_wait';
    } else {
      reason = 'armed';
    }

    return {
      armed,
      reason,
      progress,
      startRatio: calibration.profitPushStartRatio,
      stake: this.profitPushStake(calibration),
      capPercent: calibration.profitPushCapPercent,
      gapFraction: calibration.profitPushGapFraction,
      stakeMultiplier: calibration.profitPushStakeMultiplier,
      winRatio: calibration.estimatedWinProfitRatio
    };
  }

  profitPushStake(calibration = this.goalCalibration()) {
    const balance = Math.max(this.options.minStake, this.effectiveGrowthBalance());
    const remainingGap = Math.max(0, this.strategyTarget() - this.effectiveGrowthBalance());
    const targetProfit = Math.max(this.options.minStake * 0.2, remainingGap * calibration.profitPushGapFraction);
    const projectedStake = targetProfit / calibration.estimatedWinProfitRatio;
    const growthStake = this.growthStake();
    const stakeMultiplier = this.hasCustomInitialStake()
      ? Math.min(calibration.profitPushStakeMultiplier, calibration.customProfitPushStakeMultiplier)
      : calibration.profitPushStakeMultiplier;
    const rawStake = Math.max(growthStake * stakeMultiplier, projectedStake);
    const floorCapPercent = Math.min(1, growthStake / balance);
    const capPercent = Math.max(calibration.profitPushCapPercent, floorCapPercent);
    return this.normalizeStake(rawStake, capPercent);
  }

  boldTargetStake() {
    const remainingGap = Math.max(0, this.strategyTarget() - this.effectiveGrowthBalance());
    if (remainingGap <= 0) return 0;

    const winRatio = Math.max(0.01, this.estimatedWinProfitRatio());
    const stakeToTarget = remainingGap / winRatio;
    return this.normalizeStake(stakeToTarget, 1);
  }

  boldTargetState() {
    const stake = this.boldTargetStake();
    const remainingGap = Math.max(0, this.strategyTarget() - this.effectiveGrowthBalance());
    return {
      armed: stake >= this.options.minStake && remainingGap > 0,
      stake,
      remainingGap,
      winRatio: this.estimatedWinProfitRatio(),
      targetSizingMode: this.targetSizingMode()
    };
  }

  emergencyRecoveryStake(calibration = this.goalCalibration()) {
    const debt = this.currentRecoveryDebt();
    if (debt <= 0) return 0;

    const winRatio = Math.max(0.12, calibration.estimatedWinProfitRatio);
    const targetProfit = Math.max(this.options.minStake * 0.2, debt * (1 + this.options.recoveryBufferPercent));
    const projectedStake = (targetProfit / winRatio) * calibration.emergencyRecoveryStakeMultiplier;
    const capPercent = Math.min(this.options.allInStakePercent, calibration.emergencyRecoveryCapPercent);
    const balanceCap = Math.max(this.options.minStake, this.effectiveGrowthBalance() * capPercent);
    const remainingGap = Math.max(0, this.strategyTarget() - this.effectiveGrowthBalance());
    const gapCap = Math.max(this.options.minStake, remainingGap * calibration.emergencyRecoveryGapFraction);
    const stopReserve = Math.max(0, this.effectiveGrowthBalance() - this.options.seed * 0.5);
    const reserveCap = Math.max(this.options.minStake, stopReserve * 0.65);
    const rawStake = Math.min(projectedStake, balanceCap, gapCap, reserveCap);

    return rawStake >= this.options.minStake
      ? this.normalizeStake(rawStake, capPercent)
      : 0;
  }

  recoveryStake() {
    const calibration = this.goalCalibration();
    const confidenceGate = this.confidenceGateState();
    const debt = this.currentRecoveryDebt();
    const targetProfit = Math.max(this.options.minStake, debt * (1 + this.options.recoveryBufferPercent));
    const winRatio = calibration.estimatedWinProfitRatio;
    const projectedStake = (targetProfit / winRatio) * (confidenceGate.locked ? 0.9 : 1);
    const balanceCap = Math.max(this.options.minStake, this.effectiveGrowthBalance() * calibration.recoveryCapPercent);
    const gapCap = Math.max(this.options.minStake, Math.max(0, this.strategyTarget() - this.effectiveGrowthBalance()) * calibration.recoveryGapFraction);
    return Math.max(this.options.minStake, Math.min(projectedStake, balanceCap, gapCap));
  }

  splitRecoveryState() {
    const calibration = this.goalCalibration();
    const debt = this.currentRecoveryDebt();
    const armed = this.splitRecoveryArmed && this.splitRecoveryPiecesRemaining > 0 && debt > 0;
    const waitTrades = armed ? Math.max(0, this.splitRecoveryReadyAtTrade - this.totalTrades) : 0;
    const ready = armed && waitTrades <= 0;
    return {
      armed,
      ready,
      waitTrades,
      piecesRemaining: this.splitRecoveryPiecesRemaining,
      piecesTotal: this.options.splitRecoveryPieces,
      cooldownTrades: this.options.splitRecoveryCooldownTrades,
      capPercent: calibration.splitRecoveryCapPercent,
      strikeAtTrade: this.splitRecoveryReadyAtTrade,
      debt
    };
  }

  splitRecoveryStake() {
    const calibration = this.goalCalibration();
    const state = this.splitRecoveryState();
    const piecesRemaining = Math.max(1, state.piecesRemaining);
    const debt = this.currentRecoveryDebt();
    const targetProfit = Math.max(
      this.options.minStake,
      (debt * (1 + this.options.recoveryBufferPercent)) / piecesRemaining
    );
    const winRatio = calibration.estimatedWinProfitRatio;
    const projectedStake = targetProfit / winRatio;
    const balanceCap = Math.max(this.options.minStake, this.effectiveGrowthBalance() * calibration.splitRecoveryCapPercent);
    const gapCap = Math.max(this.options.minStake, Math.max(0, this.strategyTarget() - this.effectiveGrowthBalance()) * calibration.splitRecoveryGapFraction);
    return this.normalizeStake(Math.min(projectedStake, balanceCap, gapCap), calibration.splitRecoveryCapPercent);
  }

  armSplitRecovery(reason = 'martingale_retry_limit_reached') {
    this.resetGrowthLossStairs();
    if (this.autoCycleModeEnabled()) {
      this.autoCycleHardRecovery = true;
    }
    this.splitRecoveryArmed = true;
    this.splitRecoveryPiecesRemaining = this.options.splitRecoveryPieces;
    this.splitRecoveryReadyAtTrade = this.totalTrades + this.options.splitRecoveryCooldownTrades;
    this.martingaleLossStreak = 0;
    this.changePhase(PHASES.GROWTH, reason);
  }

  clearSplitRecovery(reason = 'split_recovery_cleared') {
    this.resetGrowthLossStairs();
    this.splitRecoveryArmed = false;
    this.splitRecoveryPiecesRemaining = 0;
    this.splitRecoveryReadyAtTrade = 0;
    this.martingaleLossStreak = 0;
    if (reason) {
      this.emitAnalysis('waiting_condition', `Split recovery completed (${reason}). The bot is back on the normal run.`, {});
    }
  }

  send(payload, timeoutMs = 15000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Deriv WebSocket is not open.'));
    }

    const reqId = this.reqId++;
    const request = { ...payload, req_id: reqId };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Deriv request timed out: ${Object.keys(payload).join(',')}`));
      }, timeoutMs);

      this.pending.set(reqId, { resolve, reject, timeout });
      this.ws.send(JSON.stringify(request), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(reqId);
        reject(error);
      });
    });
  }

  handleDerivMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.emit('error_event', { message: `Bad Deriv message: ${error.message}` });
      return;
    }

    if (message.req_id && this.pending.has(message.req_id)) {
      const pending = this.pending.get(message.req_id);
      clearTimeout(pending.timeout);
      this.pending.delete(message.req_id);

      if (message.error) {
        pending.reject(new Error(message.error.message || 'Deriv API error'));
      } else {
        pending.resolve(message);
      }
    } else if (message.error) {
      this.emit('error_event', { message: message.error.message || 'Deriv API error' });
    }

    if (message.msg_type === 'tick' && message.tick) {
      this.handleTick({
        quote: message.tick.quote,
        digit: quoteToDigit(message.tick.quote, message.tick.pip_size),
        pipSize: message.tick.pip_size,
        epoch: message.tick.epoch
      });
    }

    if (message.msg_type === 'balance' && message.balance) {
      this.accountBalance = roundMoney(message.balance.balance);
      this.emitBalance();
    }

    if (message.msg_type === 'proposal_open_contract' && message.proposal_open_contract) {
      this.handleOpenContract(message);
    }
  }

  handleOpenContract(message) {
    const contract = message.proposal_open_contract;
    const watcher = this.contractWatchers.get(contract.contract_id);
    if (!watcher || !contract.is_sold) return;

    clearTimeout(watcher.timeout);
    this.contractWatchers.delete(contract.contract_id);

    if (watcher.subscriptionId) {
      this.send({ forget: watcher.subscriptionId }, 5000).catch(() => {});
    }

    watcher.resolve(this.contractToResult(contract, watcher.condition, watcher.stake));
  }

  contractToResult(contract, condition, stake) {
    const exitQuote = contract.exit_tick || contract.sell_spot || contract.current_spot;
    const digit = quoteToDigit(exitQuote, this.lastPipSize);
    const fallbackWinProfit = stake * this.estimatedWinProfitRatio();
    const profit = roundMoney(toNumber(contract.profit, condition.wins(digit) ? fallbackWinProfit : -stake));
    const won = contract.status === 'won' || profit > 0;

    return {
      condition,
      stake,
      digit,
      won,
      profit,
      contractId: contract.contract_id,
      timestamp: new Date().toISOString()
    };
  }

  handleTick(tick) {
    if (this.stopped || tick.digit === null || tick.digit === undefined) return;

    this.lastPipSize = Number.isFinite(tick.pipSize) ? tick.pipSize : this.lastPipSize;
    this.digits.push(tick.digit);
    if (this.digits.length > this.options.windowSize * 3) {
      this.digits = this.digits.slice(-this.options.windowSize * 3);
    }

    this.emit('digit', {
      digit: tick.digit,
      quote: tick.quote,
      epoch: tick.epoch,
      stats: this.stats()
    });

    if (this.paused || this.pauseRequested) {
      this.emitAnalysis(
        'paused',
        'The bot is paused. Live analysis continues, but no new trades will be placed.',
        { currentDigit: tick.digit }
      );
      return;
    }

    if (this.tradeInFlight) {
      this.emitAnalysis('trade_in_flight', 'A trade has already been sent. Waiting for the contract result.', {
        currentDigit: tick.digit
      });
      return;
    }

    if (this.digits.length < this.options.windowSize) {
      this.emitAnalysis(
        'warming_up',
        `Warming up ${this.digits.length}/${this.options.windowSize}. The bot is still building the recent digit window.`,
        { currentDigit: tick.digit }
      );
      return;
    }

    const plan = this.nextTradePlan();
    if (!plan) {
      this.emitAnalysis(
        'waiting_balance',
        `Signal found, but the session balance is not high enough for the next stake.`,
        { currentDigit: tick.digit }
      );
      return;
    }

    if (plan.waitOnly) {
      this.emitAnalysis(
        'symbol_switch',
        `Auto is switching to ${this.symbolSwitchInFlight || this.options.symbol}. Waiting for the new digit window before trading.`,
        { currentDigit: tick.digit, plan, auto: this.autoLastDecision }
      );
      return;
    }

    if (Date.now() < this.tradeCooldownUntil && this.planShouldWaitForThrottle(plan)) {
      const remainingMs = Math.max(0, this.tradeCooldownUntil - Date.now());
      const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
      const cooldownReason = this.tradeCooldownReason === 'confidence_throttle'
        ? this.tradeCooldownDetail || `Confidence throttle active. Waiting ${remainingSeconds} second(s) before the next risky move.`
        : this.tradeCooldownReason === 'trade_failed'
          ? `A recent trade attempt failed. Waiting ${remainingSeconds} second(s) before trying again.`
          : `Cooling down for ${remainingSeconds} second(s) before the next risky move.`;
      this.emitAnalysis(
        'trade_cooldown',
        cooldownReason,
        { currentDigit: tick.digit, plan }
      );
      return;
    }

    if (this.tradeCooldownUntil > 0 && Date.now() >= this.tradeCooldownUntil) {
      this.tradeCooldownUntil = 0;
      this.tradeCooldownReason = '';
      this.tradeCooldownDetail = '';
    }

    const relaxedAutoEntry = this.autoRelaxedHighRiskEntries();
    const condition = this.selectCondition(tick.digit, {
      ignoreGuideFilters: plan.kind === PHASES.BLIND_SNIPER || plan.kind === 'all_in',
      relaxedAutoEntry
    });
    if (!condition) {
      this.emitAnalysis(
        plan.kind === PHASES.BLIND_SNIPER ? 'blind_sniper_waiting' : 'waiting_condition',
        plan.kind === PHASES.BLIND_SNIPER
          ? `Blind sniper is armed, but the cooler digit window has not lined up on ${tick.digit} yet.`
          : this.options.guideFilters
            ? `Window is ready, but the guide filters are not satisfied on digit ${tick.digit}.`
            : `Window is ready, but no trade setup was selected on digit ${tick.digit}.`,
        { currentDigit: tick.digit, plan }
      );
      return;
    }

    this.currentPlan = plan;
    this.emitAnalysis(
      'signal_ready',
      `Signal ready: ${condition.label} on digit ${tick.digit}. Placing ${plan.kind} stake of ${plan.stake.toFixed(2)}.`,
      { currentDigit: tick.digit, condition, plan }
    );
    this.placeTrade(condition, plan).catch((error) => {
      this.tradeInFlight = false;
      this.setTradeCooldown(3000, 'trade_failed', 'A recent trade attempt failed. Waiting briefly before trying again.');
      this.emitAnalysis(
        'trade_failed',
        `Trade failed: ${error.message}. Pausing briefly, then the bot will keep analyzing.`,
        { currentDigit: tick.digit, condition, plan }
      );
      this.emit('error_event', { message: `Trade failed: ${error.message}` });
    });
  }

  selectCondition(currentDigit, { ignoreGuideFilters = false, relaxedAutoEntry = false } = {}) {
    const mode = normalizeDigitStrategyMode(this.options.digitStrategyMode);
    let condition = null;
    if (mode === DIGIT_STRATEGY_MODES.EXTREME) {
      condition = this.selectExtremeCondition(currentDigit, { ignoreGuideFilters, relaxedAutoEntry });
    } else if (mode === DIGIT_STRATEGY_MODES.MATCH_SNIPER) {
      condition = this.selectMatchSniperCondition(currentDigit, { ignoreGuideFilters, relaxedAutoEntry });
    } else {
      condition = this.selectBaseCondition(currentDigit, { ignoreGuideFilters });
    }

    return this.options.invertDigitSignal ? invertDigitCondition(condition) : condition;
  }

  selectBaseCondition(currentDigit, { ignoreGuideFilters = false } = {}) {
    const stats = this.stats();
    const overHits = stats.window.filter(CONDITIONS.OVER_1.wins).length;
    const underHits = stats.window.filter(CONDITIONS.UNDER_8.wins).length;

    let condition;
    if (overHits < underHits) {
      condition = CONDITIONS.OVER_1;
    } else if (underHits < overHits) {
      condition = CONDITIONS.UNDER_8;
    } else {
      condition = stats.counts[1] <= stats.counts[8] ? CONDITIONS.OVER_1 : CONDITIONS.UNDER_8;
    }

    if (!ignoreGuideFilters && currentDigit !== condition.entryDigit) return null;
    if (ignoreGuideFilters) return condition;
    if (!this.options.guideFilters) return condition;
    return this.guideAllows(condition, currentDigit, stats) ? condition : null;
  }

  selectExtremeCondition(currentDigit, { ignoreGuideFilters = false, relaxedAutoEntry = false } = {}) {
    const stats = this.stats();
    const over = digitOverCondition(7, 'Over 7');
    const under = digitUnderCondition(2, 'Under 2');
    const overMetrics = this.extremeConditionMetrics(over, currentDigit, stats);
    const underMetrics = this.extremeConditionMetrics(under, currentDigit, stats);

    if (ignoreGuideFilters || relaxedAutoEntry) {
      if (overMetrics.score > underMetrics.score) return over;
      if (underMetrics.score > overMetrics.score) return under;
      return overMetrics.windowHitRate >= underMetrics.windowHitRate ? over : under;
    }

    const candidates = [
      { condition: over, metrics: overMetrics },
      { condition: under, metrics: underMetrics }
    ]
      .filter((candidate) => candidate.metrics.allowed)
      .sort((a, b) => b.metrics.score - a.metrics.score);

    return candidates[0] ? candidates[0].condition : null;
  }

  selectMatchSniperCondition(currentDigit, { ignoreGuideFilters = false, relaxedAutoEntry = false } = {}) {
    const stats = this.stats();
    if (!ignoreGuideFilters && !relaxedAutoEntry && this.totalTrades < this.matchSniperCooldownUntilTrade) return null;

    const minCount = Math.min(...stats.counts);
    if (!ignoreGuideFilters && !relaxedAutoEntry && minCount > this.options.matchSniperMaxCount) return null;

    const coldDigits = stats.counts
      .map((count, digit) => ({ count, digit }))
      .filter((item) => item.count === minCount)
      .sort((a, b) => {
        if (a.digit === currentDigit) return 1;
        if (b.digit === currentDigit) return -1;
        return a.digit - b.digit;
      });

    const target = coldDigits[0] ? coldDigits[0].digit : currentDigit;
    if (!Number.isInteger(target)) return null;
    return digitMatchCondition(target);
  }

  extremeConditionMetrics(condition, currentDigit, stats = this.stats()) {
    const winningDigits = condition.contractType === 'DIGITOVER' ? [8, 9] : [0, 1];
    const last10 = stats.window.slice(-10);
    const last5 = stats.window.slice(-5);
    const windowHits = stats.window.filter(condition.wins).length;
    const previousHits = stats.previousCounts
      ? winningDigits.reduce((sum, digit) => sum + stats.previousCounts[digit], 0)
      : windowHits;
    const last10Hits = last10.filter(condition.wins).length;
    const last5Hits = last5.filter(condition.wins).length;
    const currentSideAligned = condition.contractType === 'DIGITOVER'
      ? currentDigit >= condition.entryDigit
      : currentDigit <= condition.entryDigit;
    let losingStreak = 0;
    for (let index = stats.window.length - 1; index >= 0; index -= 1) {
      if (condition.wins(stats.window[index])) break;
      losingStreak += 1;
    }

    const windowSize = Math.max(1, stats.window.length);
    const windowHitRate = windowHits / windowSize;
    const previousHitRate = previousHits / Math.max(1, this.options.windowSize);
    const shortHitRate = last10Hits / Math.max(1, last10.length);
    const microHitRate = last5Hits / Math.max(1, last5.length);
    const breakEvenRate = 1 / (1 + this.strategyFallbackProfitRatio());
    const minWindowHits = Math.max(5, Math.ceil(windowSize * (breakEvenRate + 0.03)));
    const minShortHits = Math.max(2, Math.ceil(Math.max(1, last10.length) * breakEvenRate));
    const trendStable = !stats.previousCounts || windowHits >= previousHits - 1;
    const guidePenalty = this.options.guideFilters && !currentSideAligned ? 0.08 : 0;
    const score =
      windowHitRate - breakEvenRate +
      (shortHitRate - breakEvenRate) * 0.6 +
      (microHitRate - breakEvenRate) * 0.25 +
      (currentSideAligned ? 0.04 : -0.02) -
      losingStreak * 0.015 -
      guidePenalty;
    const allowed =
      stats.window.length >= this.options.windowSize &&
      windowHits >= minWindowHits &&
      last10Hits >= minShortHits &&
      last5Hits >= 1 &&
      losingStreak <= 4 &&
      trendStable &&
      (!this.options.guideFilters || currentSideAligned) &&
      (!this.options.strictBarFilters || microHitRate >= breakEvenRate);

    return {
      allowed,
      score,
      winningDigits,
      windowHits,
      previousHits,
      last10Hits,
      last5Hits,
      losingStreak,
      windowHitRate,
      previousHitRate,
      shortHitRate,
      microHitRate,
      breakEvenRate,
      minWindowHits,
      minShortHits,
      trendStable,
      currentSideAligned
    };
  }

  guideAllows(condition, currentDigit, stats) {
    if (currentDigit !== condition.entryDigit) return false;

    const losingDigitsQuiet = condition.losingDigits.every((digit) => stats.percentages[digit] < 10);
    if (!losingDigitsQuiet) return false;

    if (stats.previousCounts) {
      const stable = condition.losingDigits.every((digit) => {
        return Math.abs(stats.counts[digit] - stats.previousCounts[digit]) <= 1;
      });
      if (!stable) return false;
    }

    if (this.options.strictBarFilters) {
      const hasExtremeBar = condition.losingDigits.some((digit) => {
        return stats.hotDigits.includes(digit) || stats.coldDigits.includes(digit);
      });
      if (hasExtremeBar) return false;
    }

    return true;
  }

  nextTradePlan() {
    if (this.effectiveGrowthBalance() < this.options.minStake || this.balance < this.options.minStake) {
      this.stop('insufficient_session_balance');
      return null;
    }

    this.applyAutoCommander();
    if (this.symbolSwitchInFlight) {
      return {
        kind: 'symbol_switch_wait',
        stake: 0,
        waitOnly: true
      };
    }

    const calibration = this.goalCalibration();
    const confidenceGate = this.confidenceGateState();

    if (this.boldTargetSizingEnabled()) {
      const boldTarget = this.boldTargetState();
      if (!boldTarget.armed) {
        this.stop('take_profit');
        return null;
      }
      return {
        kind: 'bold_target',
        stake: boldTarget.stake,
        boldTarget
      };
    }

    const emergencyAllIn = this.emergencyAllInState();
    if (emergencyAllIn.armed) {
      return {
        kind: 'all_in',
        stake: emergencyAllIn.stake,
        emergencyAllIn
      };
    }

    if (
      emergencyAllIn.highRiskBlocked &&
      emergencyAllIn.recoveryDebt > 0 &&
      this.martingaleLossStreak >= emergencyAllIn.threshold
    ) {
      this.emitAnalysis(
        'all_in_blocked',
        'Emergency recovery shot is disabled in high-risk digit modes. The bot will use staged recovery instead.',
        { plan: { kind: 'all_in_blocked' }, emergencyAllIn }
      );
    }

    const throttle = this.confidenceThrottleState(confidenceGate);

    if (confidenceGate.locked && confidenceGate.progress > 0) {
      this.emitAnalysis(
        'confidence_gate',
        `Win rate ${confidenceGate.winRate.toFixed(1)}% is below ${confidenceGate.triggerWinRate}% while profit progress is positive. The bot is staying on small growth trades for now; martingale recovery, risky jumps, and sniper shots stay paused until it reaches ${confidenceGate.releaseWinRate}%+.`,
        { plan: { kind: 'confidence_gate' } }
      );
    }

    if (throttle.active && ![PHASES.REBUILD, PHASES.STOPPED].includes(this.phase)) {
      return {
        kind: PHASES.GROWTH,
        stake: this.growthStake(),
        confidenceThrottle: true
      };
    }

    const splitRecoveryState = this.splitRecoveryState();
    if (splitRecoveryState.armed && splitRecoveryState.ready) {
      return {
        kind: 'split_recovery',
        stake: this.splitRecoveryStake(),
        splitRecovery: splitRecoveryState
      };
    }

    const profitPush = this.profitPushState(confidenceGate);
    if (profitPush.armed) {
      return {
        kind: 'profit_push',
        stake: profitPush.stake,
        profitPush
      };
    }

    const sniperState = this.blindSniperState(confidenceGate);

    if (sniperState.armed) {
      return {
        kind: PHASES.BLIND_SNIPER,
        stake: sniperState.stake,
        sniper: sniperState
      };
    }

    if (sniperState.enabled && ![PHASES.MARTINGALE, PHASES.REBUILD, PHASES.STOPPED].includes(this.phase)) {
      const sniperProgress = Math.round((sniperState.nextMilestone ?? sniperState.startRatio ?? 0.75) * 100);
      const reasonText = sniperState.reason === 'quota_exhausted'
        ? 'Blind sniper quota has been used up.'
        : sniperState.reason === 'confidence_blocked'
          ? `Blind sniper waits for win rate recovery. It will stay paused until the run reaches ${sniperState.confidenceGateReleaseWinRate}%+.`
        : sniperState.reason === 'phase_blocked'
          ? 'Blind sniper waits for an offensive phase.'
          : sniperState.reason === 'recovery_blocked'
            ? 'Blind sniper waits for the staged recovery to finish.'
          : sniperState.reason === 'progress_wait'
            ? `Blind sniper waits for ${sniperProgress}% progress to target.`
            : `Blind sniper cooldown, ${sniperState.tradesUntilShot} trade(s) until the next shot.`;
      this.emitAnalysis('blind_sniper_waiting', reasonText, { plan: { kind: PHASES.BLIND_SNIPER } });
    }

    if (splitRecoveryState.armed && !splitRecoveryState.ready) {
      this.emitAnalysis(
        'recovery_delay',
        `Martingale paused after ${calibration.martingaleRetryLimit} attempt(s). Waiting ${splitRecoveryState.waitTrades} more trade(s) before the next split recovery strike.`,
        { plan: { kind: 'split_recovery' } }
      );
    }

    const lossPressure = this.lossPressureState({ kind: PHASES.GROWTH });
    if (lossPressure.canAbsorb) {
      this.emitAnalysis(
        'loss_pressure_stairs',
        `Loss-pressure stairs are carrying ${lossPressure.debt.toFixed(2)} recovery debt with growth tier ${lossPressure.tier}/${lossPressure.maxTier}. Full martingale waits unless the cap is exceeded.`,
        { plan: { kind: PHASES.GROWTH }, lossPressure }
      );
      return {
        kind: PHASES.GROWTH,
        stake: this.growthStake(),
        lossPressure
      };
    }

    if (
      profitPush.reason === 'progress_wait' &&
      calibration.compact &&
      this.phase === PHASES.GROWTH &&
      this.currentRecoveryDebt() <= 0
    ) {
      this.emitAnalysis(
        'profit_push_waiting',
        `Compact target mode: profit push arms at ${Math.round(profitPush.startRatio * 100)}% progress. Until then the bot keeps grinding with growth stakes.`,
        { plan: { kind: 'profit_push' } }
      );
    }

    if (
      this.currentRecoveryDebt() > 0 &&
      ![PHASES.MARTINGALE, PHASES.REBUILD, PHASES.STOPPED].includes(this.phase)
    ) {
      this.changePhase(PHASES.MARTINGALE, 'open_recovery_debt');
    }

    if (
      this.phase === PHASES.GROWTH &&
      !this.initialStakeUsed &&
      this.options.initialStake !== null &&
      this.options.initialStake !== undefined &&
      this.totalTrades === 0
    ) {
      return {
        kind: 'initial_stake',
        stake: this.normalizeStake(this.options.initialStake, this.options.growthStakeCapPercent)
      };
    }

    if (
      this.phase === PHASES.GROWTH &&
      !this.splitRecoveryArmed &&
      (!confidenceGate.locked || confidenceGate.progress <= 0) &&
      this.effectiveGrowthBalance() >= this.riskFloor + this.profitGateStep()
    ) {
      this.changePhase(PHASES.RISKY, 'realized_profit_gate_hit');
    }

    if (this.phase === PHASES.GROWTH) {
      return {
        kind: PHASES.GROWTH,
        stake: this.growthStake()
      };
    }

    if (this.phase === PHASES.RISKY) {
      if (confidenceGate.locked && confidenceGate.progress > 0) {
        this.changePhase(PHASES.GROWTH, 'confidence_gate_active');
        return {
          kind: PHASES.GROWTH,
          stake: this.growthStake(),
          confidenceGateLocked: true
        };
      }
      const progress = this.progressRatio();
      const riskyStakePercent = this.riskyStakePercent(progress);
      if (progress >= 0.6) {
        this.emitAnalysis(
          'risky_jump_reduced',
          `Risky jump stake reduced to ${(riskyStakePercent * 100).toFixed(1)}% because ${Math.round(progress * 100)}% of the target is already reached.`,
          { progress, riskyStakePercent }
        );
      }
      return {
        kind: PHASES.RISKY,
        stake: this.normalizeStake(this.balance * riskyStakePercent, riskyStakePercent),
        riskyStakePercent
      };
    }

    if (this.phase === PHASES.MARTINGALE) {
      return {
        kind: PHASES.MARTINGALE,
        stake: this.normalizeStake(this.recoveryStake())
      };
    }

    if (this.phase === PHASES.REBUILD) {
      return {
        kind: PHASES.REBUILD,
        stake: this.normalizeStake(this.options.minStake)
      };
    }

    return null;
  }

  normalizeStake(rawStake, capPercent = this.options.martingaleCapPercent) {
    const stake = roundMoney(Math.max(this.options.minStake, rawStake));
    const stakeableBalance = Math.min(this.balance, this.effectiveGrowthBalance());
    const maxStake = Math.max(this.options.minStake, stakeableBalance * capPercent);
    return roundMoney(clamp(stake, this.options.minStake, maxStake));
  }

  async placeTrade(condition, plan) {
    this.tradeInFlight = true;
    this.emitAnalysis(
      'placing_trade',
      `Submitting ${condition.label} with a ${plan.kind} stake of ${plan.stake.toFixed(2)}.`,
      { condition, plan }
    );
    const stake = plan.stake;

    const proposal = await this.send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: condition.contractType,
      currency: this.options.currency,
      duration: this.options.duration,
      duration_unit: this.options.durationUnit,
      underlying_symbol: this.options.symbol,
      barrier: condition.barrier
    });

    const proposalId = proposal.proposal && proposal.proposal.id;
    if (!proposalId) throw new Error('Deriv did not return a proposal id.');

    const proposalAskPrice = roundMoney(toNumber(proposal.proposal && proposal.proposal.ask_price, stake));
    const proposalPayout = roundMoney(toNumber(proposal.proposal && proposal.proposal.payout, proposalAskPrice));
    if (proposalAskPrice > 0 && proposalPayout > proposalAskPrice) {
      this.lastProposalProfitRatio = (proposalPayout - proposalAskPrice) / proposalAskPrice;
    }
    const buyPrice = roundMoney(Math.max(stake, proposalAskPrice + 0.01));
    this.emitAnalysis(
      'proposal_ready',
      `Proposal ready for ${condition.label}. Ask price ${proposalAskPrice.toFixed(2)}, payout ${proposalPayout.toFixed(2)}. Buying at ${buyPrice.toFixed(2)}.`,
      { condition, plan }
    );
    const buy = await this.send({ buy: proposalId, price: buyPrice });
    const contractId = buy.buy && buy.buy.contract_id;
    if (!contractId) throw new Error('Deriv did not return a contract id.');

    const result = await this.waitForContract(contractId, condition, stake);
    this.applyTradeResult(result);
  }

  async waitForContract(contractId, condition, stake) {
    const first = await this.send({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1
    });

    const contract = first.proposal_open_contract;
    if (contract && contract.is_sold) {
      return this.contractToResult(contract, condition, stake);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.contractWatchers.delete(contractId);
        reject(new Error(`Timed out waiting for contract ${contractId}.`));
      }, 30000);

      this.contractWatchers.set(contractId, {
        resolve,
        reject,
        timeout,
        condition,
        stake,
        subscriptionId: first.subscription && first.subscription.id
      });
    });
  }

  applyTradeResult(result) {
    const plan = this.currentPlan || { kind: this.phase };
    this.currentPlan = null;
    this.tradeInFlight = false;

    this.totalTrades += 1;
    if (result.won) this.wins += 1;
    else this.losses += 1;
    this.recentResults.push(result.won ? 'win' : 'loss');
    if (this.recentResults.length > 20) this.recentResults = this.recentResults.slice(-20);

    if (plan.kind === PHASES.BLIND_SNIPER) {
      this.blindSniperUses += 1;
      this.tradesSinceBlindSniper = 0;
      this.sniperOverlayNet = roundMoney(this.sniperOverlayNet + result.profit);
    } else {
      this.tradesSinceBlindSniper += 1;
    }

    if (plan.kind === 'initial_stake') {
      this.initialStakeUsed = true;
    }

    if (result.condition && result.condition.strategyMode === DIGIT_STRATEGY_MODES.MATCH_SNIPER) {
      this.matchSniperCooldownUntilTrade = this.totalTrades + this.options.matchSniperCooldownTrades;
    }

    if (result.won && result.stake > 0 && Number.isFinite(result.profit) && result.profit > 0) {
      this.lastWinProfitRatio = result.profit / result.stake;
    }

    this.balance = roundMoney(this.balance + result.profit);
    this.updateAutoCycleTracking();
    if (plan.kind === 'bold_target' || this.boldTargetSizingEnabled()) {
      this.recoveryDebt = 0;
      this.riskFloor = roundMoney(this.balance);
      this.growthAnchorBalance = this.riskFloor;
    }
    this.updateLossPressureStairs(plan, result);
    const confidenceGate = this.confidenceGateState();
    const sniperState = this.blindSniperState(confidenceGate);
    const profitPushState = this.profitPushState(confidenceGate);
    const calibration = this.goalCalibration();

    const tradeEvent = {
      time: result.timestamp,
      digit: result.digit,
      condition: result.condition.label,
      conditionId: result.condition.id,
      stake: result.stake,
      result: result.won ? 'Win' : 'Loss',
      profit: result.profit,
      balance: this.balance,
      effectiveGrowthBalance: this.effectiveGrowthBalance(),
      sniperOverlayNet: this.sniperOverlayNet,
      accountBalance: this.accountBalance,
      phase: this.phase,
      plan: plan.kind,
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.targetSizingMode(),
      invertDigitSignal: this.options.invertDigitSignal,
      autoModeEnabled: this.options.autoModeEnabled,
      autoCycleMode: this.autoCycleModeEnabled(),
      autoCycleProfit: this.autoCycleProfitTarget(),
      autoCycleStake: this.autoCycleStakeFloor(),
      autoCycleBankedProfit: this.autoCycleBankedProfit,
      autoCycleCompleted: this.autoCycleCompleted,
      autoCycleRecycled: this.autoCycleRecycled,
      autoCyclePartialLocked: this.autoCyclePartialLocked,
      autoCycleHardRecovery: this.autoCycleHardRecovery,
      autoCycleStartTrade: this.autoCycleStartTrade,
      autoCycleTrades: this.autoCycleTrades(),
      autoCycleMinBalance: this.autoCycleMinBalance,
      autoCycleStruggled: this.autoCycleStruggled,
      autoCyclePartialExitTradeThreshold: this.options.autoCyclePartialExitTradeThreshold,
      autoCyclePartialExitProfitRatio: this.options.autoCyclePartialExitProfitRatio,
      autoCycleRecycleTradeThreshold: this.options.autoCycleRecycleTradeThreshold,
      strategyTarget: this.strategyTarget(),
      overallProgressRatio: this.overallProgressRatio(),
      autoRiskProfile: this.options.autoRiskProfile,
      autoState: this.autoState,
      autoReason: this.autoReason,
      autoDecision: this.autoLastDecision,
      contractId: result.contractId,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      winRate: this.winRate(),
      riskFloor: this.riskFloor,
      recoveryDebt: this.currentRecoveryDebt(),
      gateStep: this.profitGateStep(),
      goalMode: calibration.label,
      boldTargetStake: calibration.boldStake,
      goalGap: calibration.gap,
      goalGapRatio: calibration.gapRatio,
      profitAggression: this.options.profitAggression,
      profitPushArmed: profitPushState.armed,
      profitPushReason: profitPushState.reason,
      profitPushStake: profitPushState.stake,
      profitPushStartRatio: profitPushState.startRatio,
      profitPushCapPercent: profitPushState.capPercent,
      estimatedWinProfitRatio: calibration.estimatedWinProfitRatio,
      lastProposalProfitRatio: this.lastProposalProfitRatio,
      matchSniperCooldownUntilTrade: this.matchSniperCooldownUntilTrade,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount,
      growthStairMode: this.growthStairMode(),
      growthStairsEnabled: this.growthStairsEnabled(),
      growthLossStairTier: this.growthLossStairTier,
      growthLossWinStreak: this.growthLossWinStreak,
      lossStairMaxTier: this.options.lossStairMaxTier,
      lossStairWinResetCount: this.options.lossStairWinResetCount,
      lossStairDebtCapPercent: this.options.lossStairDebtCapPercent,
      initialStake: this.options.initialStake,
      initialStakeUsed: this.initialStakeUsed,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: Math.max(0, this.options.blindSniperMaxUses - this.blindSniperUses),
      blindSniperTradesSinceLastShot: this.tradesSinceBlindSniper,
      blindSniperTradesUntilShot: Math.max(0, calibration.sniperCadenceTrades - this.tradesSinceBlindSniper),
      blindSniperProgress: this.sessionProgressRatio(),
      blindSniperArmed: sniperState.armed,
      blindSniperMilestones: sniperState.milestones,
      blindSniperNextMilestone: sniperState.nextMilestone,
      blindSniperStake: sniperState.stake,
      blindSniperStakeRaw: sniperState.rawStake,
      blindSniperStakeCapped: sniperState.stakeCapped,
      blindSniperRemainingGap: sniperState.remainingGap,
      blindSniperProfitAboveFloor: sniperState.profitAboveFloor,
      blindSniperGapCap: sniperState.gapCap,
      blindSniperProfitCap: sniperState.profitCap,
      blindSniperProgressTaper: sniperState.progressTaper,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperReason: sniperState.reason,
      martingaleLossStreak: this.martingaleLossStreak,
      martingaleRetryLimit: calibration.martingaleRetryLimit,
      splitRecoveryArmed: this.splitRecoveryArmed,
      splitRecoveryReadyAtTrade: this.splitRecoveryReadyAtTrade,
      splitRecoveryPiecesRemaining: this.splitRecoveryPiecesRemaining,
      splitRecoveryCooldownTrades: this.options.splitRecoveryCooldownTrades,
      splitRecoveryPieces: this.options.splitRecoveryPieces,
      splitRecoveryCapPercent: calibration.splitRecoveryCapPercent,
      progressRatio: this.progressRatio(),
      confidenceGateLocked: confidenceGate.locked,
      confidenceGateWinRate: confidenceGate.winRate,
      confidenceGateTriggerWinRate: confidenceGate.triggerWinRate,
      confidenceGateReleaseWinRate: confidenceGate.releaseWinRate,
      riskyStakePercent: plan.kind === PHASES.RISKY
        ? (plan.riskyStakePercent ?? this.riskyStakePercent())
        : null
    };

    console.log(
      `${tradeEvent.time} digit=${tradeEvent.digit} condition="${tradeEvent.condition}" ` +
      `stake=${tradeEvent.stake.toFixed(2)} result=${tradeEvent.result} ` +
      `profit=${tradeEvent.profit.toFixed(2)} balance=${tradeEvent.balance.toFixed(2)} ` +
      `phase=${tradeEvent.phase} plan=${tradeEvent.plan} tier=${tradeEvent.growthTier} ` +
      `session_balance=${tradeEvent.effectiveGrowthBalance.toFixed(2)} overlay=${tradeEvent.sniperOverlayNet.toFixed(2)} ` +
      `growth_floor=${tradeEvent.growthFloor.toFixed(2)} floor=${this.riskFloor.toFixed(2)} debt=${this.currentRecoveryDebt().toFixed(2)} ` +
      `symbol=${tradeEvent.symbol} digit_strategy=${tradeEvent.digitStrategyMode} goal_mode=${tradeEvent.goalMode} ` +
      `auto=${tradeEvent.autoModeEnabled ? `${tradeEvent.autoState}/${tradeEvent.autoRiskProfile}` : 'off'} ` +
      `payout_ratio=${tradeEvent.estimatedWinProfitRatio.toFixed(2)} ` +
      `stair_mode=${tradeEvent.growthStairMode} loss_tier=${tradeEvent.growthLossStairTier}/${tradeEvent.lossStairMaxTier} ` +
      `aggression=${tradeEvent.profitAggression}/5 ` +
      `confidence_gate=${tradeEvent.confidenceGateLocked ? 'on' : 'off'} ` +
      `profit_push=${tradeEvent.profitPushArmed ? 'armed' : tradeEvent.profitPushReason} ` +
      `risky_pct=${tradeEvent.riskyStakePercent ? (tradeEvent.riskyStakePercent * 100).toFixed(1) : 'n/a'} ` +
      `martingale_streak=${this.martingaleLossStreak} ` +
      `split_recovery=${this.splitRecoveryArmed ? 'on' : 'off'} ` +
      `split_wait=${Math.max(0, this.splitRecoveryReadyAtTrade - this.totalTrades)} ` +
      `sniper_stake=${tradeEvent.blindSniperStake.toFixed(2)} ` +
      `sniper_capped=${tradeEvent.blindSniperStakeCapped ? 'on' : 'off'} ` +
      `sniper_uses=${tradeEvent.blindSniperUses}/${this.options.blindSniperMaxUses} ` +
      `sniper_wait=${tradeEvent.blindSniperTradesUntilShot}`
    );

    this.emit('trade', tradeEvent);
    this.afterTrade(plan, result);

    const confidenceGateAfter = this.confidenceGateState();
    const throttle = this.confidenceThrottleState(confidenceGateAfter);
    if (
      throttle.active &&
      !this.stopped &&
      (plan.kind === PHASES.GROWTH || plan.kind === 'initial_stake')
    ) {
      this.setTradeCooldown(throttle.cooldownMs, throttle.reason, throttle.detail);
      this.emitAnalysis(
        'trade_cooldown',
        throttle.detail,
        { plan, condition: result.condition }
      );
    }

    this.emitBalance();

    if (this.paused && !this.stopped) {
      this.emitStatus('paused');
    }
  }

  afterTrade(plan, result) {
    if (
      this.autoCycleModeEnabled()
        ? this.autoCycleBankedProfit >= this.autoCycleOverallProfitTarget()
        : this.balance >= this.options.target
    ) {
      this.stop('take_profit');
      return;
    }

    if (this.autoCycleModeEnabled()) {
      const cycleExitReason = this.autoCycleExitReason();
      if (cycleExitReason) {
        this.resetAutoCycle(cycleExitReason);
        return;
      }
    }

    const calibration = this.goalCalibration();

    if (plan.kind === 'bold_target' || this.boldTargetSizingEnabled()) {
      this.recoveryDebt = 0;
      this.riskFloor = roundMoney(this.balance);
      this.growthAnchorBalance = this.riskFloor;
      this.martingaleLossStreak = 0;
      this.emergencyAllInUsed = false;
      this.clearSplitRecovery(null);
      this.resetGrowthLossStairs();

      if (this.balance < this.options.minStake) {
        this.stop('insufficient_session_balance');
        return;
      }
      if (!result.won && this.stopLossTriggered()) {
        this.stop('stop_loss');
        return;
      }
      if (this.phase !== PHASES.GROWTH) {
        this.changePhase(PHASES.GROWTH, result.won ? 'bold_target_continues' : 'bold_target_loss_continue');
      }
      return;
    }

    if (result.won) {
      this.martingaleLossStreak = 0;
      this.emergencyAllInUsed = false;
      const remainingDebt = this.currentRecoveryDebt();

      if (this.lossPressureStairsEnabled() && this.isLossPressurePlan(plan)) {
        if (remainingDebt <= 0) {
          this.resetGrowthLossStairs();
        } else {
          const lossPressure = this.lossPressureState(plan);
          this.emitAnalysis(
            'loss_pressure_stairs',
            `Loss-pressure stairs won but $${remainingDebt.toFixed(2)} recovery debt remains. The bot keeps the rally small at tier ${lossPressure.tier}/${lossPressure.maxTier}.`,
            { plan, condition: result.condition, lossPressure }
          );
          if (this.phase !== PHASES.GROWTH) {
            this.changePhase(PHASES.GROWTH, 'loss_pressure_recovery_continues');
          }
          return;
        }
      }

      if (plan.kind === PHASES.RISKY) {
        if (remainingDebt <= 0) {
          const lockedFloor = this.lockedProfitFloor();
          this.riskFloor = lockedFloor;
          this.growthAnchorBalance = lockedFloor;
          this.resetGrowthLossStairs();
          this.clearSplitRecovery(null);
          this.changePhase(PHASES.GROWTH, 'risky_jump_won_floor_locked');
        } else {
          if (this.phase !== PHASES.MARTINGALE) {
            this.changePhase(PHASES.MARTINGALE, 'recovery_debt_still_open');
          }
          this.emitAnalysis(
            'waiting_condition',
            `Risky jump won, but $${remainingDebt.toFixed(2)} of recovery debt remains. The bot stays in recovery.`,
            { plan, condition: result.condition }
          );
        }
        return;
      }

      if (plan.kind === PHASES.MARTINGALE || plan.kind === 'split_recovery') {
        if (remainingDebt <= 0) {
          const lockedFloor = this.lockedProfitFloor();
          this.riskFloor = lockedFloor;
          this.growthAnchorBalance = lockedFloor;
          this.resetGrowthLossStairs();
          this.clearSplitRecovery(null);
          this.changePhase(
            PHASES.GROWTH,
            plan.kind === PHASES.MARTINGALE ? 'martingale_recovered_to_growth' : 'split_recovery_complete'
          );
          return;
        }

        if (plan.kind === 'split_recovery' && this.splitRecoveryArmed && this.splitRecoveryPiecesRemaining > 0) {
          this.splitRecoveryReadyAtTrade = this.totalTrades + this.options.splitRecoveryCooldownTrades;
        }
        if (this.phase !== PHASES.MARTINGALE) {
          this.changePhase(PHASES.MARTINGALE, 'recovery_debt_still_open');
        }
        this.emitAnalysis(
          'waiting_condition',
          `Recovery win reduced the debt to $${remainingDebt.toFixed(2)}. The bot stays in recovery until the ledger clears.`,
          { plan, condition: result.condition }
        );
        return;
      }

      if (plan.kind === 'all_in') {
        if (remainingDebt <= 0) {
          const lockedFloor = this.lockedProfitFloor();
          this.riskFloor = lockedFloor;
          this.growthAnchorBalance = lockedFloor;
          this.resetGrowthLossStairs();
          this.clearSplitRecovery(null);
          this.changePhase(PHASES.GROWTH, 'all_in_recovered_to_growth');
          return;
        }

        this.emitAnalysis(
          'waiting_condition',
          `Emergency recovery shot won. Recovery debt is still open, so the bot will only stay in martingale until it clears.`,
          { plan, condition: result.condition }
        );
      }

      if (remainingDebt > 0 && this.phase !== PHASES.MARTINGALE && this.phase !== PHASES.REBUILD) {
        const throttle = this.confidenceThrottleState();
        if (throttle.active && plan.kind !== 'all_in') {
          this.emitAnalysis(
            'waiting_condition',
            `Recovery debt remains, but the confidence delay is keeping the bot on small trades for now.`,
            { plan, condition: result.condition }
          );
          return;
        }
        this.changePhase(PHASES.MARTINGALE, 'open_recovery_debt_after_win');
      }
      return;
    }

    this.recoveryDebt = this.currentRecoveryDebt();
    this.martingaleLossStreak += 1;

    if (this.stopLossTriggered()) {
      this.stop('stop_loss');
      return;
    }

    const lossPressure = this.lossPressureState(plan);
    if (lossPressure.canAbsorb) {
      this.emitAnalysis(
        'loss_pressure_stairs',
        `Loss-pressure stairs absorbed a growth loss. Tier ${lossPressure.tier}/${lossPressure.maxTier}; recovery debt ${lossPressure.debt.toFixed(2)} stays under the ${lossPressure.debtCap.toFixed(2)} small-rally cap.`,
        { plan, condition: result.condition, lossPressure }
      );
      this.changePhase(PHASES.GROWTH, 'loss_pressure_stair_climbed');
      return;
    }

    if (plan.kind === PHASES.MARTINGALE) {
      if (this.martingaleLossStreak >= calibration.martingaleRetryLimit) {
        this.armSplitRecovery('martingale_retry_limit_reached');
        this.emitAnalysis(
          'waiting_condition',
          `Martingale failed ${calibration.martingaleRetryLimit} time(s). Recovery is now split into ${this.options.splitRecoveryPieces} smaller strike(s) after ${this.options.splitRecoveryCooldownTrades} normal trade(s).`,
          { plan, condition: result.condition }
        );
      } else {
        this.emitAnalysis(
          'waiting_condition',
          `Martingale retry ${this.martingaleLossStreak}/${calibration.martingaleRetryLimit}. The bot will try once more before switching to split recovery.`,
          { plan, condition: result.condition }
        );
      }
      return;
    }

    if (plan.kind === 'split_recovery') {
      this.splitRecoveryPiecesRemaining = Math.max(0, this.splitRecoveryPiecesRemaining - 1);
      if (this.currentRecoveryDebt() > 0 && this.splitRecoveryPiecesRemaining > 0) {
        this.splitRecoveryReadyAtTrade = this.totalTrades + this.options.splitRecoveryCooldownTrades;
        this.emitAnalysis(
          'waiting_condition',
          `Split recovery missed. ${this.splitRecoveryPiecesRemaining} staged strike(s) remain; the next one is queued after ${this.options.splitRecoveryCooldownTrades} normal trade(s).`,
          { plan, condition: result.condition }
        );
      } else {
        this.clearSplitRecovery('split_recovery_exhausted');
      }
      return;
    }

    if (plan.kind === 'all_in') {
      this.emergencyAllInUsed = true;
      this.emitAnalysis(
        'waiting_condition',
        `Emergency recovery shot missed. Recovery stays open and the bot will fall back to martingale only if debt is still present.`,
        { plan, condition: result.condition }
      );
      if (this.balance >= this.options.minStake) {
        this.changePhase(PHASES.MARTINGALE, 'all_in_failed_recovery_debt_open');
      } else {
        this.changePhase(PHASES.REBUILD, 'all_in_failed_rebuild');
      }
      return;
    }

    if (this.balance >= this.options.minStake) {
      if (this.lossPressureStairsEnabled()) this.resetGrowthLossStairs();
      this.changePhase(PHASES.MARTINGALE, 'loss_triggered_realized_profit_recovery');
    } else {
      if (this.lossPressureStairsEnabled()) this.resetGrowthLossStairs();
      this.changePhase(PHASES.REBUILD, 'loss_triggered_rebuild');
    }
  }

  changePhase(nextPhase, reason) {
    if (this.phase === nextPhase || this.stopped) return;
    const previous = this.phase;
    this.phase = nextPhase;
    if (this.autoCycleModeEnabled() && [PHASES.MARTINGALE, PHASES.REBUILD].includes(nextPhase)) {
      this.autoCycleHardRecovery = true;
    }
    const payload = this.phasePayload(previous, nextPhase, reason);
    console.log(
      `${new Date().toISOString()} phase_change ${previous} -> ${nextPhase} ` +
      `reason=${reason} balance=${this.balance.toFixed(2)} session_balance=${this.effectiveGrowthBalance().toFixed(2)} tier=${this.growthTier()} ` +
      `floor=${this.riskFloor.toFixed(2)} debt=${this.currentRecoveryDebt().toFixed(2)}`
    );
    this.emit('phase_change', payload);
    this.emitBalance();
  }

  phasePayload(previous, nextPhase, reason) {
    const sniperState = this.blindSniperState();
    const profitPushState = this.profitPushState();
    const calibration = this.goalCalibration();
    return {
      time: new Date().toISOString(),
      from: previous,
      to: nextPhase,
      reason,
      balance: this.balance,
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.targetSizingMode(),
      invertDigitSignal: this.options.invertDigitSignal,
      ...this.autoTelemetry(),
      riskFloor: this.riskFloor,
      recoveryDebt: this.currentRecoveryDebt(),
      effectiveGrowthBalance: this.effectiveGrowthBalance(),
      sniperOverlayNet: this.sniperOverlayNet,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      gateStep: this.profitGateStep(),
      growthStairMode: this.growthStairMode(),
      growthStairsEnabled: this.growthStairsEnabled(),
      growthLossStairTier: this.growthLossStairTier,
      growthLossWinStreak: this.growthLossWinStreak,
      lossStairMaxTier: this.options.lossStairMaxTier,
      lossStairWinResetCount: this.options.lossStairWinResetCount,
      lossStairDebtCapPercent: this.options.lossStairDebtCapPercent,
      initialStake: this.options.initialStake,
      initialStakeUsed: this.initialStakeUsed,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: sniperState.usesRemaining,
      blindSniperTradesSinceLastShot: sniperState.tradesSinceLastShot,
      blindSniperTradesUntilShot: sniperState.tradesUntilShot,
      blindSniperCadenceTrades: sniperState.cadenceTrades,
      blindSniperMaxUses: sniperState.maxUses,
      blindSniperStartRatio: sniperState.startRatio,
      blindSniperMilestones: sniperState.milestones,
      blindSniperStakeFraction: sniperState.stakeFraction,
      blindSniperProgress: this.sessionProgressRatio(),
      blindSniperArmed: sniperState.armed,
      blindSniperNextMilestone: sniperState.nextMilestone,
      blindSniperReason: sniperState.reason,
      blindSniperStake: sniperState.stake,
      blindSniperStakeRaw: sniperState.rawStake,
      blindSniperStakeCapped: sniperState.stakeCapped,
      blindSniperRemainingGap: sniperState.remainingGap,
      blindSniperProfitAboveFloor: sniperState.profitAboveFloor,
      blindSniperGapCap: sniperState.gapCap,
      blindSniperProfitCap: sniperState.profitCap,
      blindSniperProgressTaper: sniperState.progressTaper,
      martingaleLossStreak: this.martingaleLossStreak,
      martingaleRetryLimit: calibration.martingaleRetryLimit,
      splitRecoveryArmed: this.splitRecoveryArmed,
      splitRecoveryReadyAtTrade: this.splitRecoveryReadyAtTrade,
      splitRecoveryPiecesRemaining: this.splitRecoveryPiecesRemaining,
      splitRecoveryCooldownTrades: this.options.splitRecoveryCooldownTrades,
      splitRecoveryPieces: this.options.splitRecoveryPieces,
      splitRecoveryCapPercent: calibration.splitRecoveryCapPercent,
      goalMode: calibration.label,
      boldTargetStake: calibration.boldStake,
      goalGap: calibration.gap,
      goalGapRatio: calibration.gapRatio,
      profitAggression: this.options.profitAggression,
      profitPushArmed: profitPushState.armed,
      profitPushReason: profitPushState.reason,
      profitPushStake: profitPushState.stake,
      profitPushStartRatio: profitPushState.startRatio,
      profitPushCapPercent: profitPushState.capPercent,
      estimatedWinProfitRatio: calibration.estimatedWinProfitRatio,
      lastProposalProfitRatio: this.lastProposalProfitRatio,
      matchSniperCooldownUntilTrade: this.matchSniperCooldownUntilTrade,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount,
      seed: this.options.seed,
      target: this.options.target
    };
  }

  emitBalance() {
    const sniperState = this.blindSniperState();
    const profitPushState = this.profitPushState();
    const calibration = this.goalCalibration();
    this.emit('balance_update', {
      balance: this.balance,
      accountBalance: this.accountBalance,
      phase: this.phase,
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.targetSizingMode(),
      invertDigitSignal: this.options.invertDigitSignal,
      ...this.autoTelemetry(),
      seed: this.options.seed,
      target: this.options.target,
      profitLoss: this.sessionProfitLoss(),
      netProfitLoss: this.sessionNetProfitLoss(),
      openCycleProfitLoss: this.autoCycleModeEnabled()
        ? roundMoney(this.balance - this.options.seed)
        : 0,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: this.winRate(),
      riskFloor: this.riskFloor,
      recoveryDebt: this.currentRecoveryDebt(),
      effectiveGrowthBalance: this.effectiveGrowthBalance(),
      sniperOverlayNet: this.sniperOverlayNet,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      gateStep: this.profitGateStep(),
      growthStairMode: this.growthStairMode(),
      growthStairsEnabled: this.growthStairsEnabled(),
      growthLossStairTier: this.growthLossStairTier,
      growthLossWinStreak: this.growthLossWinStreak,
      lossStairMaxTier: this.options.lossStairMaxTier,
      lossStairWinResetCount: this.options.lossStairWinResetCount,
      lossStairDebtCapPercent: this.options.lossStairDebtCapPercent,
      initialStake: this.options.initialStake,
      initialStakeUsed: this.initialStakeUsed,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: sniperState.usesRemaining,
      blindSniperMaxUses: sniperState.maxUses,
      blindSniperTradesSinceLastShot: sniperState.tradesSinceLastShot,
      blindSniperTradesUntilShot: sniperState.tradesUntilShot,
      blindSniperCadenceTrades: sniperState.cadenceTrades,
      blindSniperStartRatio: sniperState.startRatio,
      blindSniperMilestones: sniperState.milestones,
      blindSniperStakeFraction: sniperState.stakeFraction,
      blindSniperProgress: this.sessionProgressRatio(),
      blindSniperArmed: sniperState.armed,
      blindSniperNextMilestone: sniperState.nextMilestone,
      blindSniperReason: sniperState.reason,
      blindSniperStake: sniperState.stake,
      blindSniperStakeRaw: sniperState.rawStake,
      blindSniperStakeCapped: sniperState.stakeCapped,
      blindSniperRemainingGap: sniperState.remainingGap,
      blindSniperProfitAboveFloor: sniperState.profitAboveFloor,
      blindSniperGapCap: sniperState.gapCap,
      blindSniperProfitCap: sniperState.profitCap,
      blindSniperProgressTaper: sniperState.progressTaper,
      martingaleLossStreak: this.martingaleLossStreak,
      martingaleRetryLimit: calibration.martingaleRetryLimit,
      splitRecoveryArmed: this.splitRecoveryArmed,
      splitRecoveryReadyAtTrade: this.splitRecoveryReadyAtTrade,
      splitRecoveryPiecesRemaining: this.splitRecoveryPiecesRemaining,
      splitRecoveryCooldownTrades: this.options.splitRecoveryCooldownTrades,
      splitRecoveryPieces: this.options.splitRecoveryPieces,
      splitRecoveryCapPercent: calibration.splitRecoveryCapPercent,
      goalMode: calibration.label,
      boldTargetStake: calibration.boldStake,
      goalGap: calibration.gap,
      goalGapRatio: calibration.gapRatio,
      profitAggression: this.options.profitAggression,
      profitPushArmed: profitPushState.armed,
      profitPushReason: profitPushState.reason,
      profitPushStake: profitPushState.stake,
      profitPushStartRatio: profitPushState.startRatio,
      profitPushCapPercent: profitPushState.capPercent,
      estimatedWinProfitRatio: calibration.estimatedWinProfitRatio,
      lastProposalProfitRatio: this.lastProposalProfitRatio,
      matchSniperCooldownUntilTrade: this.matchSniperCooldownUntilTrade,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount,
      tradeCooldownUntil: this.tradeCooldownUntil,
      tradeCooldownReason: this.tradeCooldownReason,
      tradeCooldownDetail: this.tradeCooldownDetail
    });
  }

  emitStatus(status) {
    const confidenceGate = this.confidenceGateState();
    const sniperState = this.blindSniperState(confidenceGate);
    const calibration = this.goalCalibration();
    this.emit('status', {
      status,
      paused: this.paused,
      pauseReason: this.pauseReason,
      pausedAt: this.paused ? new Date().toISOString() : null,
      mode: this.options.mode,
      accountId: this.options.accountId || null,
      accountKind: this.accountKind,
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.targetSizingMode(),
      invertDigitSignal: this.options.invertDigitSignal,
      ...this.autoTelemetry(),
      phase: this.phase,
      seed: this.options.seed,
      target: this.options.target,
      riskFloor: this.riskFloor,
      recoveryDebt: this.currentRecoveryDebt(),
      effectiveGrowthBalance: this.effectiveGrowthBalance(),
      sniperOverlayNet: this.sniperOverlayNet,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      balance: this.balance,
      growthStairMode: this.growthStairMode(),
      growthStairsEnabled: this.growthStairsEnabled(),
      growthLossStairTier: this.growthLossStairTier,
      growthLossWinStreak: this.growthLossWinStreak,
      lossStairMaxTier: this.options.lossStairMaxTier,
      lossStairWinResetCount: this.options.lossStairWinResetCount,
      lossStairDebtCapPercent: this.options.lossStairDebtCapPercent,
      initialStake: this.options.initialStake,
      initialStakeUsed: this.initialStakeUsed,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: sniperState.usesRemaining,
      blindSniperMaxUses: sniperState.maxUses,
      blindSniperTradesSinceLastShot: sniperState.tradesSinceLastShot,
      blindSniperTradesUntilShot: sniperState.tradesUntilShot,
      blindSniperCadenceTrades: sniperState.cadenceTrades,
      blindSniperStartRatio: sniperState.startRatio,
      blindSniperMilestones: sniperState.milestones,
      blindSniperStakeFraction: sniperState.stakeFraction,
      blindSniperProgress: this.sessionProgressRatio(),
      blindSniperArmed: sniperState.armed,
      blindSniperNextMilestone: sniperState.nextMilestone,
      blindSniperReason: sniperState.reason,
      martingaleLossStreak: this.martingaleLossStreak,
      martingaleRetryLimit: calibration.martingaleRetryLimit,
      splitRecoveryArmed: this.splitRecoveryArmed,
      splitRecoveryReadyAtTrade: this.splitRecoveryReadyAtTrade,
      splitRecoveryPiecesRemaining: this.splitRecoveryPiecesRemaining,
      splitRecoveryCooldownTrades: this.options.splitRecoveryCooldownTrades,
      splitRecoveryPieces: this.options.splitRecoveryPieces,
      splitRecoveryCapPercent: calibration.splitRecoveryCapPercent,
      goalMode: calibration.label,
      boldTargetStake: calibration.boldStake,
      goalGap: calibration.gap,
      goalGapRatio: calibration.gapRatio,
      tradeCooldownUntil: this.tradeCooldownUntil,
      tradeCooldownReason: this.tradeCooldownReason,
      tradeCooldownDetail: this.tradeCooldownDetail,
      confidenceGateLocked: confidenceGate.locked,
      confidenceGateWinRate: confidenceGate.winRate,
      confidenceGateTriggerWinRate: confidenceGate.triggerWinRate,
      confidenceGateReleaseWinRate: confidenceGate.releaseWinRate
    });
  }

  snapshot() {
    const sniperState = this.blindSniperState();
    const profitPushState = this.profitPushState();
    const calibration = this.goalCalibration();
    return {
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      paused: this.paused,
      pauseReason: this.pauseReason,
      stopped: this.stopped,
      balance: this.balance,
      accountBalance: this.accountBalance,
      accountKind: this.accountKind,
      phase: this.phase,
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.targetSizingMode(),
      invertDigitSignal: this.options.invertDigitSignal,
      ...this.autoTelemetry(),
      riskFloor: this.riskFloor,
      recoveryDebt: this.currentRecoveryDebt(),
      effectiveGrowthBalance: this.effectiveGrowthBalance(),
      sniperOverlayNet: this.sniperOverlayNet,
      lastWinProfitRatio: this.lastWinProfitRatio,
      lastProposalProfitRatio: this.lastProposalProfitRatio,
      lastPipSize: this.lastPipSize,
      growthAnchorBalance: this.growthAnchorBalance,
      growthStairMode: this.growthStairMode(),
      growthStairsEnabled: this.growthStairsEnabled(),
      growthLossStairTier: this.growthLossStairTier,
      growthLossWinStreak: this.growthLossWinStreak,
      lossStairMaxTier: this.options.lossStairMaxTier,
      lossStairWinResetCount: this.options.lossStairWinResetCount,
      lossStairDebtCapPercent: this.options.lossStairDebtCapPercent,
      initialStake: this.options.initialStake,
      initialStakeUsed: this.initialStakeUsed,
      martingaleLossStreak: this.martingaleLossStreak,
      martingaleRetryLimit: calibration.martingaleRetryLimit,
      emergencyAllInUsed: this.emergencyAllInUsed,
      splitRecoveryArmed: this.splitRecoveryArmed,
      splitRecoveryReadyAtTrade: this.splitRecoveryReadyAtTrade,
      splitRecoveryPiecesRemaining: this.splitRecoveryPiecesRemaining,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperCadenceTrades: calibration.sniperCadenceTrades,
      blindSniperMaxUses: this.options.blindSniperMaxUses,
      blindSniperStartRatio: this.options.blindSniperStartRatio,
      blindSniperMilestones: this.options.blindSniperMilestones,
      blindSniperStakeFraction: this.options.blindSniperStakeFraction,
      blindSniperUses: this.blindSniperUses,
      blindSniperTradesSinceLastShot: this.tradesSinceBlindSniper,
      blindSniperStake: sniperState.stake,
      blindSniperStakeRaw: sniperState.rawStake,
      blindSniperStakeCapped: sniperState.stakeCapped,
      blindSniperRemainingGap: sniperState.remainingGap,
      blindSniperProfitAboveFloor: sniperState.profitAboveFloor,
      blindSniperGapCap: sniperState.gapCap,
      blindSniperProfitCap: sniperState.profitCap,
      blindSniperProgressTaper: sniperState.progressTaper,
      splitRecoveryCooldownTrades: this.options.splitRecoveryCooldownTrades,
      splitRecoveryPieces: this.options.splitRecoveryPieces,
      splitRecoveryCapPercent: calibration.splitRecoveryCapPercent,
      goalMode: calibration.label,
      boldTargetStake: calibration.boldStake,
      goalGap: calibration.gap,
      goalGapRatio: calibration.gapRatio,
      profitAggression: this.options.profitAggression,
      profitPushArmed: profitPushState.armed,
      profitPushReason: profitPushState.reason,
      profitPushStake: profitPushState.stake,
      profitPushStartRatio: profitPushState.startRatio,
      profitPushCapPercent: profitPushState.capPercent,
      estimatedWinProfitRatio: calibration.estimatedWinProfitRatio,
      lastProposalProfitRatio: this.lastProposalProfitRatio,
      matchSniperCooldownUntilTrade: this.matchSniperCooldownUntilTrade,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount,
      tradeCooldownUntil: this.tradeCooldownUntil,
      tradeCooldownReason: this.tradeCooldownReason,
      tradeCooldownDetail: this.tradeCooldownDetail,
      confidenceGateLocked: this.confidenceGateLocked,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      tradeInFlight: this.tradeInFlight,
      digits: this.digits.slice(-this.options.windowSize * 3),
      currentPlan: this.currentPlan ? { ...this.currentPlan } : null,
      analysisState: { ...this.analysisState }
    };
  }

  restoreState(snapshot = {}) {
    const digits = Array.isArray(snapshot.digits)
      ? snapshot.digits
        .map((digit) => Number(digit))
        .filter((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9)
      : [];

    if (snapshot.startedAt) {
      const startedAt = new Date(snapshot.startedAt);
      if (!Number.isNaN(startedAt.getTime())) {
        this.startedAt = startedAt;
      }
    }

    this.balance = roundMoney(toNumber(snapshot.balance, this.balance));
    this.accountBalance = snapshot.accountBalance === null || snapshot.accountBalance === undefined
      ? this.accountBalance
      : roundMoney(toNumber(snapshot.accountBalance, this.accountBalance ?? this.balance));
    this.accountKind = snapshot.accountKind || this.accountKind;
    this.phase = snapshot.phase || this.phase;
    this.options.symbol = normalizeSymbol(snapshot.symbol, this.options.symbol);
    this.options.digitStrategyMode = normalizeDigitStrategyMode(snapshot.digitStrategyMode ?? this.options.digitStrategyMode);
    this.options.targetSizingMode = normalizeTargetSizingMode(snapshot.targetSizingMode ?? this.options.targetSizingMode);
    this.options.invertDigitSignal = Boolean(snapshot.invertDigitSignal ?? this.options.invertDigitSignal);
    this.options.autoModeEnabled = Boolean(snapshot.autoModeEnabled ?? this.options.autoModeEnabled);
    this.options.autoCycleMode = Boolean(snapshot.autoCycleMode ?? this.options.autoCycleMode);
    this.options.autoCycleProfit = toOptionalNumber(snapshot.autoCycleProfit, this.options.autoCycleProfit);
    this.options.autoCycleStake = toOptionalNumber(snapshot.autoCycleStake, this.options.autoCycleStake);
    this.options.autoCyclePartialExitTradeThreshold = Math.max(
      1,
      Math.floor(toNumber(snapshot.autoCyclePartialExitTradeThreshold, this.options.autoCyclePartialExitTradeThreshold))
    );
    this.options.autoCyclePartialExitProfitRatio = clamp(
      toNumber(snapshot.autoCyclePartialExitProfitRatio, this.options.autoCyclePartialExitProfitRatio),
      0.1,
      1
    );
    this.options.autoCycleRecycleTradeThreshold = Math.max(
      1,
      Math.floor(toNumber(snapshot.autoCycleRecycleTradeThreshold, this.options.autoCycleRecycleTradeThreshold))
    );
    this.autoCycleBankedProfit = roundMoney(toNumber(snapshot.autoCycleBankedProfit, this.autoCycleBankedProfit));
    this.autoCycleCompleted = Math.max(0, Math.floor(toNumber(snapshot.autoCycleCompleted, this.autoCycleCompleted)));
    this.autoCycleRecycled = Math.max(0, Math.floor(toNumber(snapshot.autoCycleRecycled, this.autoCycleRecycled)));
    this.autoCyclePartialLocked = Math.max(0, Math.floor(toNumber(snapshot.autoCyclePartialLocked, this.autoCyclePartialLocked)));
    this.autoCycleHardRecovery = Boolean(snapshot.autoCycleHardRecovery ?? this.autoCycleHardRecovery);
    this.autoCycleStartTrade = Math.max(0, Math.floor(toNumber(snapshot.autoCycleStartTrade, this.autoCycleStartTrade)));
    this.autoCycleMinBalance = roundMoney(toNumber(snapshot.autoCycleMinBalance, this.autoCycleMinBalance));
    this.autoCycleStruggled = Boolean(snapshot.autoCycleStruggled ?? this.autoCycleStruggled);
    this.options.autoRiskProfile = normalizeAutoRiskProfile(snapshot.autoRiskProfile ?? this.options.autoRiskProfile);
    this.options.autoReviewIntervalTrades = Math.max(1, Math.floor(toNumber(snapshot.autoReviewIntervalTrades, this.options.autoReviewIntervalTrades)));
    this.autoState = this.options.autoModeEnabled
      ? String(snapshot.autoState || this.autoState || AUTO_STATES.SCOUT)
      : AUTO_STATES.MANUAL;
    this.autoReason = String(snapshot.autoReason || this.autoReason || '');
    this.autoLastDecision = snapshot.autoDecision && typeof snapshot.autoDecision === 'object'
      ? snapshot.autoDecision
      : this.autoLastDecision;
    this.autoLastReviewTrade = Math.floor(toNumber(snapshot.autoLastReviewTrade, this.autoLastReviewTrade));
    this.riskFloor = roundMoney(toNumber(snapshot.riskFloor, this.riskFloor));
    this.recoveryDebt = roundMoney(toNumber(snapshot.recoveryDebt, this.recoveryDebt));
    this.sniperOverlayNet = roundMoney(toNumber(snapshot.sniperOverlayNet, this.sniperOverlayNet));
    this.lastWinProfitRatio = toNumber(snapshot.lastWinProfitRatio, this.lastWinProfitRatio);
    this.lastProposalProfitRatio = toNumber(snapshot.lastProposalProfitRatio, this.lastProposalProfitRatio);
    this.lastPipSize = toNumber(snapshot.lastPipSize, this.lastPipSize);
    this.growthAnchorBalance = roundMoney(toNumber(snapshot.growthAnchorBalance, this.growthAnchorBalance));
    this.options.profitAggression = clamp(toNumber(snapshot.profitAggression, this.options.profitAggression), 1, 5);
    this.options.growthStairMode = normalizeGrowthStairMode(
      snapshot.growthStairMode,
      Boolean(snapshot.growthStairsEnabled ?? this.options.growthStairsEnabled)
    );
    this.options.growthStairsEnabled = this.growthStairsEnabled();
    this.growthLossStairTier = Math.max(0, Math.floor(toNumber(snapshot.growthLossStairTier, this.growthLossStairTier)));
    this.growthLossWinStreak = Math.max(0, Math.floor(toNumber(snapshot.growthLossWinStreak, this.growthLossWinStreak)));
    this.options.lossStairMaxTier = Math.max(1, Math.floor(toNumber(snapshot.lossStairMaxTier, this.options.lossStairMaxTier)));
    this.options.lossStairWinResetCount = Math.max(1, Math.floor(toNumber(snapshot.lossStairWinResetCount, this.options.lossStairWinResetCount)));
    this.options.lossStairDebtCapPercent = clamp(toNumber(snapshot.lossStairDebtCapPercent, this.options.lossStairDebtCapPercent), 0.02, 1);
    this.options.initialStake = toOptionalNumber(snapshot.initialStake, this.options.initialStake);
    this.initialStakeUsed = Boolean(snapshot.initialStakeUsed ?? this.initialStakeUsed);
    this.martingaleLossStreak = Math.max(0, Math.floor(toNumber(snapshot.martingaleLossStreak, this.martingaleLossStreak)));
    this.matchSniperCooldownUntilTrade = Math.max(0, Math.floor(toNumber(snapshot.matchSniperCooldownUntilTrade, this.matchSniperCooldownUntilTrade)));
    this.options.matchSniperCooldownTrades = Math.max(1, Math.floor(toNumber(snapshot.matchSniperCooldownTrades, this.options.matchSniperCooldownTrades)));
    this.options.matchSniperMaxCount = Math.max(0, Math.floor(toNumber(snapshot.matchSniperMaxCount, this.options.matchSniperMaxCount)));
    this.emergencyAllInUsed = Boolean(snapshot.emergencyAllInUsed ?? this.emergencyAllInUsed);
    this.splitRecoveryArmed = Boolean(snapshot.splitRecoveryArmed ?? this.splitRecoveryArmed);
    this.splitRecoveryReadyAtTrade = Math.max(0, Math.floor(toNumber(snapshot.splitRecoveryReadyAtTrade, this.splitRecoveryReadyAtTrade)));
    this.splitRecoveryPiecesRemaining = Math.max(0, Math.floor(toNumber(snapshot.splitRecoveryPiecesRemaining, this.splitRecoveryPiecesRemaining)));
    this.confidenceGateLocked = Boolean(snapshot.confidenceGateLocked ?? this.confidenceGateLocked);
    this.options.blindSniperMilestones = normalizeMilestoneList(
      snapshot.blindSniperMilestones,
      this.options.blindSniperMilestones
    );
    this.options.blindSniperStartRatio =
      this.options.blindSniperMilestones[this.options.blindSniperMilestones.length - 1] ??
      this.options.blindSniperStartRatio;
    this.blindSniperUses = Math.max(0, Math.floor(toNumber(snapshot.blindSniperUses, this.blindSniperUses)));
    this.tradesSinceBlindSniper = Math.max(
      0,
      Math.floor(toNumber(snapshot.blindSniperTradesSinceLastShot, this.tradesSinceBlindSniper))
    );
    this.totalTrades = Math.max(0, Math.floor(toNumber(snapshot.totalTrades, this.totalTrades)));
    this.wins = Math.max(0, Math.floor(toNumber(snapshot.wins, this.wins)));
    this.losses = Math.max(0, Math.floor(toNumber(snapshot.losses, this.losses)));
    this.recentResults = Array.isArray(snapshot.recentResults)
      ? snapshot.recentResults.filter((value) => value === 'win' || value === 'loss').slice(-20)
      : this.recentResults;
    this.paused = Boolean(snapshot.paused);
    this.pauseRequested = false;
    this.pauseReason = snapshot.pauseReason || 'manual';
    this.stopped = Boolean(snapshot.stopped);
    this.tradeInFlight = false;
    this.tradeCooldownUntil = Math.max(0, Math.floor(toNumber(snapshot.tradeCooldownUntil, 0)));
    this.tradeCooldownReason = String(snapshot.tradeCooldownReason || '');
    this.tradeCooldownDetail = String(snapshot.tradeCooldownDetail || '');
    this.currentPlan = null;
    this.analysisState = snapshot.analysisState && typeof snapshot.analysisState === 'object'
      ? { key: String(snapshot.analysisState.key || ''), emittedAt: Number(snapshot.analysisState.emittedAt || 0) }
      : { key: '', emittedAt: 0 };
    this.digits = digits.slice(-this.options.windowSize * 3);
  }

  stats() {
    const size = this.options.windowSize;
    const window = this.digits.slice(-size);
    const previous = this.digits.length >= size * 2 ? this.digits.slice(-size * 2, -size) : null;
    const counts = Array(10).fill(0);
    const previousCounts = previous ? Array(10).fill(0) : null;

    for (const digit of window) counts[digit] += 1;
    if (previousCounts) {
      for (const digit of previous) previousCounts[digit] += 1;
    }

    const percentages = counts.map((count) => (window.length ? (count / window.length) * 100 : 0));
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);
    const hotDigits = counts.map((count, digit) => (count === maxCount ? digit : null)).filter((digit) => digit !== null);
    const coldDigits = counts.map((count, digit) => (count === minCount ? digit : null)).filter((digit) => digit !== null);

    return { window, counts, previousCounts, percentages, hotDigits, coldDigits };
  }

  winRate() {
    return this.totalTrades ? roundMoney((this.wins / this.totalTrades) * 100) : 0;
  }

  summary(reason) {
    const confidenceGate = this.confidenceGateState();
    const sniperState = this.blindSniperState(confidenceGate);
    const profitPushState = this.profitPushState(confidenceGate);
    const calibration = this.goalCalibration();
    return {
      reason,
      startedAt: this.startedAt && this.startedAt.toISOString(),
      stoppedAt: new Date().toISOString(),
      mode: this.options.mode,
      accountId: this.options.accountId || null,
      accountKind: this.accountKind,
      symbol: this.options.symbol,
      digitStrategyMode: this.options.digitStrategyMode,
      targetSizingMode: this.targetSizingMode(),
      invertDigitSignal: this.options.invertDigitSignal,
      ...this.autoTelemetry(),
      riskFloor: this.riskFloor,
      recoveryDebt: this.currentRecoveryDebt(),
      effectiveGrowthBalance: this.effectiveGrowthBalance(),
      sniperOverlayNet: this.sniperOverlayNet,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      gateStep: this.profitGateStep(),
      growthStairMode: this.growthStairMode(),
      growthStairsEnabled: this.growthStairsEnabled(),
      growthLossStairTier: this.growthLossStairTier,
      growthLossWinStreak: this.growthLossWinStreak,
      lossStairMaxTier: this.options.lossStairMaxTier,
      lossStairWinResetCount: this.options.lossStairWinResetCount,
      lossStairDebtCapPercent: this.options.lossStairDebtCapPercent,
      initialStake: this.options.initialStake,
      initialStakeUsed: this.initialStakeUsed,
      martingaleLossStreak: this.martingaleLossStreak,
      martingaleRetryLimit: calibration.martingaleRetryLimit,
      splitRecoveryArmed: this.splitRecoveryArmed,
      splitRecoveryReadyAtTrade: this.splitRecoveryReadyAtTrade,
      splitRecoveryPiecesRemaining: this.splitRecoveryPiecesRemaining,
      splitRecoveryCooldownTrades: this.options.splitRecoveryCooldownTrades,
      splitRecoveryPieces: this.options.splitRecoveryPieces,
      splitRecoveryCapPercent: calibration.splitRecoveryCapPercent,
      goalMode: calibration.label,
      boldTargetStake: calibration.boldStake,
      goalGap: calibration.gap,
      goalGapRatio: calibration.gapRatio,
      profitAggression: this.options.profitAggression,
      profitPushArmed: profitPushState.armed,
      profitPushReason: profitPushState.reason,
      profitPushStake: profitPushState.stake,
      profitPushStartRatio: profitPushState.startRatio,
      profitPushCapPercent: profitPushState.capPercent,
      estimatedWinProfitRatio: calibration.estimatedWinProfitRatio,
      lastProposalProfitRatio: this.lastProposalProfitRatio,
      matchSniperCooldownUntilTrade: this.matchSniperCooldownUntilTrade,
      matchSniperCooldownTrades: this.options.matchSniperCooldownTrades,
      matchSniperMaxCount: this.options.matchSniperMaxCount,
      tradeCooldownUntil: this.tradeCooldownUntil,
      tradeCooldownReason: this.tradeCooldownReason,
      tradeCooldownDetail: this.tradeCooldownDetail,
      confidenceGateLocked: confidenceGate.locked,
      confidenceGateWinRate: confidenceGate.winRate,
      confidenceGateTriggerWinRate: confidenceGate.triggerWinRate,
      confidenceGateReleaseWinRate: confidenceGate.releaseWinRate,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: Math.max(0, this.options.blindSniperMaxUses - this.blindSniperUses),
      blindSniperTradesSinceLastShot: this.tradesSinceBlindSniper,
      blindSniperTradesUntilShot: sniperState.tradesUntilShot,
      blindSniperCadenceTrades: sniperState.cadenceTrades,
      blindSniperMaxUses: this.options.blindSniperMaxUses,
      blindSniperStartRatio: this.options.blindSniperStartRatio,
      blindSniperMilestones: this.options.blindSniperMilestones,
      blindSniperStakeFraction: this.options.blindSniperStakeFraction,
      blindSniperProgress: this.sessionProgressRatio(),
      blindSniperNextMilestone: sniperState.nextMilestone,
      blindSniperStake: sniperState.stake,
      blindSniperStakeRaw: sniperState.rawStake,
      blindSniperStakeCapped: sniperState.stakeCapped,
      blindSniperRemainingGap: sniperState.remainingGap,
      blindSniperProfitAboveFloor: sniperState.profitAboveFloor,
      blindSniperGapCap: sniperState.gapCap,
      blindSniperProfitCap: sniperState.profitCap,
      blindSniperProgressTaper: sniperState.progressTaper,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: this.winRate(),
      startingBalance: this.options.seed,
      finalBalance: roundMoney(this.options.seed + this.sessionNetProfitLoss()),
      activeCycleBalance: this.autoCycleModeEnabled() ? this.balance : null,
      realizedProfit: this.sessionProfitLoss(),
      netProfit: this.sessionNetProfitLoss(),
      target: this.options.target,
      blindSniperMaxUses: Math.max(1, Array.isArray(this.options.blindSniperMilestones) ? this.options.blindSniperMilestones.length : 0)
    };
  }

  logSummary(reason) {
    const summary = this.summary(reason);
    console.log('===== BOT SUMMARY =====');
    console.log(`reason=${summary.reason}`);
    console.log(`trades=${summary.totalTrades} wins=${summary.wins} losses=${summary.losses} win_rate=${summary.winRate}%`);
    console.log(
      `start=${summary.startingBalance.toFixed(2)} final=${summary.finalBalance.toFixed(2)} ` +
      `net=${summary.netProfit.toFixed(2)} floor=${summary.riskFloor.toFixed(2)} debt=${summary.recoveryDebt.toFixed(2)} ` +
      `growth_tier=${summary.growthTier} growth_floor=${summary.growthFloor.toFixed(2)} ` +
      `stairs=${summary.growthStairMode || (summary.growthStairsEnabled ? 'profit' : 'off')} ` +
      `loss_stair=${summary.growthLossStairTier || 0}/${summary.lossStairMaxTier || 0} ` +
      `martingale_streak=${summary.martingaleLossStreak} ` +
      `split_recovery=${summary.splitRecoveryArmed ? 'on' : 'off'} ` +
      `split_remaining=${summary.splitRecoveryPiecesRemaining}/${summary.splitRecoveryPieces} ` +
      `sniper_stake=${summary.blindSniperStake.toFixed(2)} ` +
      `sniper_capped=${summary.blindSniperStakeCapped ? 'on' : 'off'} ` +
      `sniper_marks=${(summary.blindSniperMilestones || []).map((value) => Math.round(value * 100)).join('/') || 'none'} ` +
      `sniper_uses=${summary.blindSniperUses}/${summary.blindSniperMaxUses} ` +
      `sniper_progress=${Math.round(summary.blindSniperProgress * 100)}%`
    );
    console.log('=======================');
  }
}

module.exports = {
  DerivDigitBot,
  CONDITIONS,
  PHASES,
  roundMoney
};
