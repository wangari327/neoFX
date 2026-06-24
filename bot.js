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

const PHASES = {
  GROWTH: 'growth',
  RISKY: 'risky_jump',
  MARTINGALE: 'martingale',
  REBUILD: 'rebuild',
  BLIND_SNIPER: 'blind_sniper',
  STOPPED: 'stopped'
};

const DEFAULT_API_BASE_URL = 'https://api.derivws.com';

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

    this.options = {
      mode: options.mode || 'demo',
      token: options.token || '',
      apiBaseUrl: options.apiBaseUrl || DEFAULT_API_BASE_URL,
      accountId: options.accountId || '',
      appId: options.appId || '1089',
      symbol: options.symbol || 'R_100',
      currency: options.currency || 'USD',
      seed: roundMoney(toNumber(options.seed, 10)),
      target: roundMoney(toNumber(options.target, 50)),
      minStake: roundMoney(toNumber(options.minStake, 0.35)),
      baseStakePercent: toNumber(options.baseStakePercent, 0.02),
      riskyStakePercent: toNumber(options.riskyStakePercent, 0.35),
      martingaleCapPercent: toNumber(options.martingaleCapPercent, 0.4),
      growthMilestonePercent: toNumber(options.growthMilestonePercent, 0.025),
      growthStakeBumpPercent: toNumber(options.growthStakeBumpPercent, 0.15),
      growthStakeCapPercent: toNumber(options.growthStakeCapPercent, 0.12),
      profitGatePercent: toNumber(options.profitGatePercent, 0.08),
      recoveryBufferPercent: toNumber(options.recoveryBufferPercent, 0.05),
      blindSniperEnabled: options.blindSniperEnabled === true,
      blindSniperCadenceTrades: Math.max(1, Math.floor(toNumber(options.blindSniperCadenceTrades, 3))),
      blindSniperMaxUses: Math.max(0, Math.floor(toNumber(options.blindSniperMaxUses, 3))),
      blindSniperStartRatio: clamp(toNumber(options.blindSniperStartRatio, 0.75), 0, 1),
      blindSniperStakeFraction: clamp(toNumber(options.blindSniperStakeFraction, 1 / 3), 0, 1),
      windowSize: Math.max(10, Math.floor(toNumber(options.windowSize, 20))),
      guideFilters: options.guideFilters === true,
      strictBarFilters: options.strictBarFilters === true,
      duration: Math.max(1, Math.floor(toNumber(options.duration, 1))),
      durationUnit: options.durationUnit || 't'
    };

    this.balance = this.options.seed;
    this.accountBalance = null;
    this.accountKind = 'unknown';
    this.phase = PHASES.GROWTH;
    this.riskFloor = this.options.seed;
    this.recoveryDebt = 0;
    this.lastWinProfitRatio = 0.95;
    this.lastPipSize = 2;
    this.growthAnchorBalance = this.options.seed;
    this.paused = false;
    this.pauseRequested = false;
    this.pauseReason = 'manual';
    this.blindSniperUses = 0;
    this.tradesSinceBlindSniper = 0;

    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.tradeInFlight = false;
    this.stopped = false;
    this.startedAt = null;
    this.currentPlan = null;

    this.digits = [];
    this.ws = null;
    this.pending = new Map();
    this.contractWatchers = new Map();
    this.reqId = 1;
    this.pingTimer = null;
    this.analysisState = {
      key: '',
      emittedAt: 0
    };
    this.tradeCooldownUntil = 0;
  }

  async start() {
    this.startedAt = this.startedAt || new Date();
    this.stopped = false;
    this.paused = false;
    this.pauseRequested = false;
    this.pauseReason = 'manual';
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
    await this.send({ ticks: this.options.symbol, subscribe: 1 });
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

  emitAnalysis(stage, detail, extras = {}) {
    const immediate = new Set(['connecting', 'listening', 'ready', 'signal_ready', 'placing_trade']);
    const now = Date.now();
    const key = [
      stage,
      extras.currentDigit ?? '',
      extras.condition ? extras.condition.id : '',
      extras.plan ? extras.plan.kind : '',
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

    this.emit('analysis', {
      time: new Date().toISOString(),
      stage,
      detail,
      phase: this.phase,
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
      blindSniperTradesUntilShot: Math.max(0, this.options.blindSniperCadenceTrades - this.tradesSinceBlindSniper),
      blindSniperProgress: this.progressRatio(),
      blindSniperArmed: this.blindSniperState().armed
    });
  }

  growthMilestoneStep() {
    return roundMoney(Math.max(
      this.options.minStake * 0.5,
      this.options.seed * this.options.growthMilestonePercent
    ));
  }

  growthTier() {
    const step = this.growthMilestoneStep();
    if (step <= 0) return 0;
    const anchor = Number.isFinite(this.growthAnchorBalance) ? this.growthAnchorBalance : this.options.seed;
    const profitAboveAnchor = Math.max(0, this.balance - anchor);
    return Math.floor(profitAboveAnchor / step);
  }

  growthStakeFloor() {
    const tier = this.growthTier();
    return roundMoney(this.options.minStake * (1 + tier * this.options.growthStakeBumpPercent));
  }

  growthStake() {
    const rawStake = Math.max(
      this.balance * this.options.baseStakePercent,
      this.growthStakeFloor()
    );
    return this.normalizeStake(rawStake, this.options.growthStakeCapPercent);
  }

  progressRatio() {
    const span = Math.max(0.01, this.options.target - this.options.seed);
    return clamp((this.balance - this.options.seed) / span, 0, 1);
  }

  blindSniperState() {
    const enabled = this.options.blindSniperEnabled;
    const progress = this.progressRatio();
    const usesRemaining = Math.max(0, this.options.blindSniperMaxUses - this.blindSniperUses);
    const tradesUntilShot = Math.max(0, this.options.blindSniperCadenceTrades - this.tradesSinceBlindSniper);
    const phaseReady = ![PHASES.MARTINGALE, PHASES.REBUILD, PHASES.STOPPED].includes(this.phase);
    const armed =
      enabled &&
      phaseReady &&
      usesRemaining > 0 &&
      progress >= this.options.blindSniperStartRatio &&
      this.tradesSinceBlindSniper >= this.options.blindSniperCadenceTrades;

    let reason = 'disabled';
    if (!enabled) {
      reason = 'disabled';
    } else if (usesRemaining <= 0) {
      reason = 'quota_exhausted';
    } else if (!phaseReady) {
      reason = 'phase_blocked';
    } else if (progress < this.options.blindSniperStartRatio) {
      reason = 'progress_wait';
    } else if (this.tradesSinceBlindSniper < this.options.blindSniperCadenceTrades) {
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
      cadenceTrades: this.options.blindSniperCadenceTrades,
      tradesSinceLastShot: this.tradesSinceBlindSniper,
      tradesUntilShot,
      maxUses: this.options.blindSniperMaxUses,
      startRatio: this.options.blindSniperStartRatio,
      stakeFraction: this.options.blindSniperStakeFraction
    };
  }

  blindSniperStake() {
    return this.normalizeStake(
      this.balance * this.options.blindSniperStakeFraction,
      this.options.blindSniperStakeFraction
    );
  }

  profitGateStep() {
    return roundMoney(Math.max(this.options.minStake * 2, this.options.seed * this.options.profitGatePercent));
  }

  recoveryStake() {
    const debt = Math.max(0, this.recoveryDebt, this.riskFloor - this.balance);
    const targetProfit = Math.max(this.options.minStake, debt * (1 + this.options.recoveryBufferPercent));
    const winRatio = Math.max(0.01, this.lastWinProfitRatio || 0.95);
    return targetProfit / winRatio;
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
    const profit = roundMoney(toNumber(contract.profit, condition.wins(digit) ? stake * 0.2 : -stake));
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

    if (Date.now() < this.tradeCooldownUntil) {
      this.emitAnalysis(
        'trade_cooldown',
        'A recent trade attempt failed. Waiting briefly before trying again.',
        { currentDigit: tick.digit }
      );
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

    const condition = this.selectCondition(tick.digit, {
      ignoreGuideFilters: plan.kind === PHASES.BLIND_SNIPER
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
      this.tradeCooldownUntil = Date.now() + 3000;
      this.emitAnalysis(
        'trade_failed',
        `Trade failed: ${error.message}. Pausing briefly, then the bot will keep analyzing.`,
        { currentDigit: tick.digit, condition, plan }
      );
      this.emit('error_event', { message: `Trade failed: ${error.message}` });
    });
  }

  selectCondition(currentDigit, { ignoreGuideFilters = false } = {}) {
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

    if (ignoreGuideFilters || !this.options.guideFilters) return condition;
    return this.guideAllows(condition, currentDigit, stats) ? condition : null;
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
    if (this.balance < this.options.minStake) {
      this.stop('insufficient_session_balance');
      return null;
    }

    const sniperState = this.blindSniperState();
    if (sniperState.armed) {
      return {
        kind: PHASES.BLIND_SNIPER,
        stake: this.blindSniperStake(),
        sniper: sniperState
      };
    }

    if (sniperState.enabled && ![PHASES.MARTINGALE, PHASES.REBUILD, PHASES.STOPPED].includes(this.phase)) {
      const reasonText = sniperState.reason === 'quota_exhausted'
        ? 'Blind sniper quota has been used up.'
        : sniperState.reason === 'phase_blocked'
          ? 'Blind sniper waits for an offensive phase.'
          : sniperState.reason === 'progress_wait'
            ? `Blind sniper waits for ${Math.round(sniperState.startRatio * 100)}% progress to target.`
            : `Blind sniper waits for ${sniperState.tradesUntilShot} more trade(s).`;
      this.emitAnalysis('blind_sniper_waiting', reasonText, { plan: { kind: PHASES.BLIND_SNIPER } });
    }

    if (this.phase === PHASES.GROWTH && this.balance >= this.riskFloor + this.profitGateStep()) {
      this.changePhase(PHASES.RISKY, 'realized_profit_gate_hit');
    }

    if (this.phase === PHASES.GROWTH) {
      return {
        kind: PHASES.GROWTH,
        stake: this.growthStake()
      };
    }

    if (this.phase === PHASES.RISKY) {
      return {
        kind: PHASES.RISKY,
        stake: this.normalizeStake(this.balance * this.options.riskyStakePercent, this.options.riskyStakePercent)
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
    const maxStake = Math.max(this.options.minStake, this.balance * capPercent);
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
    const buyPrice = roundMoney(Math.max(stake, proposalAskPrice + 0.01));
    this.emitAnalysis(
      'proposal_ready',
      `Proposal ready for ${condition.label}. Ask price ${proposalAskPrice.toFixed(2)}. Buying at ${buyPrice.toFixed(2)}.`,
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
    const sniperState = this.blindSniperState();

    this.totalTrades += 1;
    if (result.won) this.wins += 1;
    else this.losses += 1;

    if (plan.kind === PHASES.BLIND_SNIPER) {
      this.blindSniperUses += 1;
      this.tradesSinceBlindSniper = 0;
    } else {
      this.tradesSinceBlindSniper += 1;
    }

    if (result.won && result.stake > 0 && Number.isFinite(result.profit) && result.profit > 0) {
      this.lastWinProfitRatio = result.profit / result.stake;
    }

    this.balance = roundMoney(this.balance + result.profit);

    const tradeEvent = {
      time: result.timestamp,
      digit: result.digit,
      condition: result.condition.label,
      conditionId: result.condition.id,
      stake: result.stake,
      result: result.won ? 'Win' : 'Loss',
      profit: result.profit,
      balance: this.balance,
      accountBalance: this.accountBalance,
      phase: this.phase,
      plan: plan.kind,
      contractId: result.contractId,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      winRate: this.winRate(),
      riskFloor: this.riskFloor,
      recoveryDebt: this.recoveryDebt,
      gateStep: this.profitGateStep(),
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: Math.max(0, this.options.blindSniperMaxUses - this.blindSniperUses),
      blindSniperTradesSinceLastShot: this.tradesSinceBlindSniper,
      blindSniperTradesUntilShot: Math.max(0, this.options.blindSniperCadenceTrades - this.tradesSinceBlindSniper),
      blindSniperProgress: this.progressRatio(),
      blindSniperArmed: sniperState.armed,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperReason: sniperState.reason
    };

    console.log(
      `${tradeEvent.time} digit=${tradeEvent.digit} condition="${tradeEvent.condition}" ` +
      `stake=${tradeEvent.stake.toFixed(2)} result=${tradeEvent.result} ` +
      `profit=${tradeEvent.profit.toFixed(2)} balance=${tradeEvent.balance.toFixed(2)} ` +
      `phase=${tradeEvent.phase} plan=${tradeEvent.plan} tier=${tradeEvent.growthTier} ` +
      `growth_floor=${tradeEvent.growthFloor.toFixed(2)} floor=${this.riskFloor.toFixed(2)} debt=${this.recoveryDebt.toFixed(2)} ` +
      `sniper_uses=${tradeEvent.blindSniperUses}/${this.options.blindSniperMaxUses} ` +
      `sniper_wait=${tradeEvent.blindSniperTradesUntilShot}`
    );

    this.emit('trade', tradeEvent);
    this.afterTrade(plan, result);
    this.emitBalance();

    if (this.paused && !this.stopped) {
      this.emitStatus('paused');
    }
  }

  afterTrade(plan, result) {
    if (this.balance >= this.options.target) {
      this.stop('take_profit');
      return;
    }

    if (result.won) {
      this.riskFloor = Math.max(this.riskFloor, this.balance);
      this.recoveryDebt = Math.max(0, roundMoney(this.riskFloor - this.balance));

      if (plan.kind === PHASES.RISKY) {
        this.changePhase(PHASES.GROWTH, 'risky_jump_won_floor_locked');
      } else if (plan.kind === PHASES.MARTINGALE) {
        if (this.recoveryDebt === 0) {
          this.growthAnchorBalance = this.balance;
          this.changePhase(PHASES.GROWTH, 'recovery_debt_cleared');
        } else {
          this.emitAnalysis(
            'waiting_condition',
            `Recovery win landed. ${this.recoveryDebt.toFixed(2)} still sits below the protected floor ${this.riskFloor.toFixed(2)}.`,
            { plan, condition: result.condition }
          );
        }
      }
      return;
    }

    this.recoveryDebt = Math.max(0, roundMoney(this.riskFloor - this.balance));

    if (this.balance < this.options.seed * 0.5) {
      this.stop('stop_loss');
      return;
    }

    if (this.balance >= this.options.minStake) {
      this.changePhase(PHASES.MARTINGALE, 'loss_triggered_realized_profit_recovery');
    } else {
      this.changePhase(PHASES.REBUILD, 'loss_triggered_rebuild');
    }
  }

  changePhase(nextPhase, reason) {
    if (this.phase === nextPhase || this.stopped) return;
    const previous = this.phase;
    this.phase = nextPhase;
    const payload = this.phasePayload(previous, nextPhase, reason);
    console.log(
      `${new Date().toISOString()} phase_change ${previous} -> ${nextPhase} ` +
      `reason=${reason} balance=${this.balance.toFixed(2)} tier=${this.growthTier()} ` +
      `floor=${this.riskFloor.toFixed(2)} debt=${this.recoveryDebt.toFixed(2)}`
    );
    this.emit('phase_change', payload);
    this.emitBalance();
  }

  phasePayload(previous, nextPhase, reason) {
    const sniperState = this.blindSniperState();
    return {
      time: new Date().toISOString(),
      from: previous,
      to: nextPhase,
      reason,
      balance: this.balance,
      riskFloor: this.riskFloor,
      recoveryDebt: this.recoveryDebt,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      gateStep: this.profitGateStep(),
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: sniperState.usesRemaining,
      blindSniperTradesSinceLastShot: sniperState.tradesSinceLastShot,
      blindSniperTradesUntilShot: sniperState.tradesUntilShot,
      blindSniperCadenceTrades: sniperState.cadenceTrades,
      blindSniperMaxUses: sniperState.maxUses,
      blindSniperStartRatio: sniperState.startRatio,
      blindSniperStakeFraction: sniperState.stakeFraction,
      blindSniperProgress: sniperState.progress,
      blindSniperArmed: sniperState.armed,
      blindSniperReason: sniperState.reason,
      seed: this.options.seed,
      target: this.options.target
    };
  }

  emitBalance() {
    const sniperState = this.blindSniperState();
    this.emit('balance_update', {
      balance: this.balance,
      accountBalance: this.accountBalance,
      phase: this.phase,
      seed: this.options.seed,
      target: this.options.target,
      profitLoss: roundMoney(this.balance - this.options.seed),
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: this.winRate(),
      riskFloor: this.riskFloor,
      recoveryDebt: this.recoveryDebt,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      gateStep: this.profitGateStep(),
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: sniperState.usesRemaining,
      blindSniperMaxUses: sniperState.maxUses,
      blindSniperTradesSinceLastShot: sniperState.tradesSinceLastShot,
      blindSniperTradesUntilShot: sniperState.tradesUntilShot,
      blindSniperCadenceTrades: sniperState.cadenceTrades,
      blindSniperStartRatio: sniperState.startRatio,
      blindSniperStakeFraction: sniperState.stakeFraction,
      blindSniperProgress: sniperState.progress,
      blindSniperArmed: sniperState.armed,
      blindSniperReason: sniperState.reason
    });
  }

  emitStatus(status) {
    const sniperState = this.blindSniperState();
    this.emit('status', {
      status,
      paused: this.paused,
      pauseReason: this.pauseReason,
      pausedAt: this.paused ? new Date().toISOString() : null,
      mode: this.options.mode,
      accountId: this.options.accountId || null,
      accountKind: this.accountKind,
      symbol: this.options.symbol,
      phase: this.phase,
      seed: this.options.seed,
      target: this.options.target,
      riskFloor: this.riskFloor,
      recoveryDebt: this.recoveryDebt,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      balance: this.balance,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: sniperState.usesRemaining,
      blindSniperMaxUses: sniperState.maxUses,
      blindSniperTradesSinceLastShot: sniperState.tradesSinceLastShot,
      blindSniperTradesUntilShot: sniperState.tradesUntilShot,
      blindSniperCadenceTrades: sniperState.cadenceTrades,
      blindSniperStartRatio: sniperState.startRatio,
      blindSniperStakeFraction: sniperState.stakeFraction,
      blindSniperProgress: sniperState.progress,
      blindSniperArmed: sniperState.armed,
      blindSniperReason: sniperState.reason
    });
  }

  snapshot() {
    return {
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      paused: this.paused,
      pauseReason: this.pauseReason,
      stopped: this.stopped,
      balance: this.balance,
      accountBalance: this.accountBalance,
      accountKind: this.accountKind,
      phase: this.phase,
      riskFloor: this.riskFloor,
      recoveryDebt: this.recoveryDebt,
      lastWinProfitRatio: this.lastWinProfitRatio,
      lastPipSize: this.lastPipSize,
      growthAnchorBalance: this.growthAnchorBalance,
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperCadenceTrades: this.options.blindSniperCadenceTrades,
      blindSniperMaxUses: this.options.blindSniperMaxUses,
      blindSniperStartRatio: this.options.blindSniperStartRatio,
      blindSniperStakeFraction: this.options.blindSniperStakeFraction,
      blindSniperUses: this.blindSniperUses,
      blindSniperTradesSinceLastShot: this.tradesSinceBlindSniper,
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      tradeInFlight: this.tradeInFlight,
      tradeCooldownUntil: this.tradeCooldownUntil,
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
    this.riskFloor = roundMoney(toNumber(snapshot.riskFloor, this.riskFloor));
    this.recoveryDebt = roundMoney(toNumber(snapshot.recoveryDebt, this.recoveryDebt));
    this.lastWinProfitRatio = toNumber(snapshot.lastWinProfitRatio, this.lastWinProfitRatio);
    this.lastPipSize = toNumber(snapshot.lastPipSize, this.lastPipSize);
    this.growthAnchorBalance = roundMoney(toNumber(snapshot.growthAnchorBalance, this.growthAnchorBalance));
    this.blindSniperUses = Math.max(0, Math.floor(toNumber(snapshot.blindSniperUses, this.blindSniperUses)));
    this.tradesSinceBlindSniper = Math.max(
      0,
      Math.floor(toNumber(snapshot.blindSniperTradesSinceLastShot, this.tradesSinceBlindSniper))
    );
    this.totalTrades = Math.max(0, Math.floor(toNumber(snapshot.totalTrades, this.totalTrades)));
    this.wins = Math.max(0, Math.floor(toNumber(snapshot.wins, this.wins)));
    this.losses = Math.max(0, Math.floor(toNumber(snapshot.losses, this.losses)));
    this.paused = Boolean(snapshot.paused);
    this.pauseRequested = false;
    this.pauseReason = snapshot.pauseReason || 'manual';
    this.stopped = Boolean(snapshot.stopped);
    this.tradeInFlight = false;
    this.tradeCooldownUntil = Math.max(0, Math.floor(toNumber(snapshot.tradeCooldownUntil, 0)));
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
    return {
      reason,
      startedAt: this.startedAt && this.startedAt.toISOString(),
      stoppedAt: new Date().toISOString(),
      mode: this.options.mode,
      accountId: this.options.accountId || null,
      accountKind: this.accountKind,
      symbol: this.options.symbol,
      riskFloor: this.riskFloor,
      recoveryDebt: this.recoveryDebt,
      growthTier: this.growthTier(),
      growthStep: this.growthMilestoneStep(),
      growthFloor: this.growthStakeFloor(),
      gateStep: this.profitGateStep(),
      blindSniperEnabled: this.options.blindSniperEnabled,
      blindSniperUses: this.blindSniperUses,
      blindSniperUsesRemaining: Math.max(0, this.options.blindSniperMaxUses - this.blindSniperUses),
      blindSniperTradesSinceLastShot: this.tradesSinceBlindSniper,
      blindSniperTradesUntilShot: Math.max(0, this.options.blindSniperCadenceTrades - this.tradesSinceBlindSniper),
      blindSniperCadenceTrades: this.options.blindSniperCadenceTrades,
      blindSniperMaxUses: this.options.blindSniperMaxUses,
      blindSniperStartRatio: this.options.blindSniperStartRatio,
      blindSniperStakeFraction: this.options.blindSniperStakeFraction,
      blindSniperProgress: this.progressRatio(),
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: this.winRate(),
      startingBalance: this.options.seed,
      finalBalance: this.balance,
      netProfit: roundMoney(this.balance - this.options.seed),
      target: this.options.target
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
