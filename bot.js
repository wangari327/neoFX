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
      windowSize: Math.max(10, Math.floor(toNumber(options.windowSize, 20))),
      guideFilters: options.guideFilters !== false,
      strictBarFilters: options.strictBarFilters === true,
      duration: Math.max(1, Math.floor(toNumber(options.duration, 1))),
      durationUnit: options.durationUnit || 't'
    };

    this.balance = this.options.seed;
    this.accountBalance = null;
    this.accountKind = 'unknown';
    this.phase = PHASES.GROWTH;
    this.riskFloor = this.options.seed;
    this.failedRiskyStake = 0;
    this.lastPipSize = 2;

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
  }

  async start() {
    this.startedAt = new Date();
    this.stopped = false;
    this.emitStatus('starting');

    if (!this.options.token) {
      throw new Error('A Deriv API token is required for demo or real trading.');
    }

    await this.connectDeriv();
    this.emitStatus('running');
  }

  async stop(reason = 'manual') {
    if (this.stopped) return;
    this.stopped = true;

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
    this.balance = roundMoney(toNumber(account.balance, this.balance));
    this.emit('account', {
      accountId: account.account_id,
      loginid: account.loginid || account.account_id,
      currency: account.currency,
      balance: this.accountBalance,
      accountKind: this.accountKind
    });

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

    if (this.tradeInFlight || this.digits.length < this.options.windowSize) return;

    const condition = this.selectCondition(tick.digit);
    if (!condition) return;

    const plan = this.nextTradePlan();
    if (!plan) return;

    this.currentPlan = plan;
    this.placeTrade(condition, plan).catch((error) => {
      this.tradeInFlight = false;
      this.emit('error_event', { message: error.message });
      this.stop('trade_error');
    });
  }

  selectCondition(currentDigit) {
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

    if (!this.options.guideFilters) return condition;
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

    if (this.phase === PHASES.GROWTH && this.balance >= this.riskFloor * 2) {
      this.changePhase(PHASES.RISKY, 'seed_or_floor_doubled');
    }

    if (this.phase === PHASES.GROWTH) {
      return {
        kind: PHASES.GROWTH,
        stake: this.normalizeStake(this.balance * this.options.baseStakePercent)
      };
    }

    if (this.phase === PHASES.RISKY) {
      return {
        kind: PHASES.RISKY,
        stake: this.normalizeStake(this.balance * this.options.riskyStakePercent)
      };
    }

    if (this.phase === PHASES.MARTINGALE) {
      const cappedStake = Math.min(
        this.failedRiskyStake * 2,
        this.balance * this.options.martingaleCapPercent
      );
      return {
        kind: PHASES.MARTINGALE,
        stake: this.normalizeStake(cappedStake)
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

  normalizeStake(rawStake) {
    const stake = roundMoney(Math.max(this.options.minStake, rawStake));
    return roundMoney(clamp(stake, this.options.minStake, Math.max(this.options.minStake, this.balance)));
  }

  async placeTrade(condition, plan) {
    this.tradeInFlight = true;
    const stake = plan.stake;

    const proposal = await this.send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: condition.contractType,
      currency: this.options.currency,
      duration: this.options.duration,
      duration_unit: this.options.durationUnit,
      symbol: this.options.symbol,
      barrier: condition.barrier
    });

    const proposalId = proposal.proposal && proposal.proposal.id;
    if (!proposalId) throw new Error('Deriv did not return a proposal id.');

    const buy = await this.send({ buy: proposalId, price: stake });
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
      winRate: this.winRate()
    };

    console.log(
      `${tradeEvent.time} digit=${tradeEvent.digit} condition="${tradeEvent.condition}" ` +
      `stake=${tradeEvent.stake.toFixed(2)} result=${tradeEvent.result} ` +
      `profit=${tradeEvent.profit.toFixed(2)} balance=${tradeEvent.balance.toFixed(2)} phase=${tradeEvent.phase}`
    );

    this.emit('trade', tradeEvent);
    this.emitBalance();
    this.afterTrade(plan, result);
  }

  afterTrade(plan, result) {
    if (this.balance >= this.options.target) {
      this.stop('take_profit');
      return;
    }

    if (plan.kind === PHASES.RISKY) {
      if (result.won) {
        this.riskFloor = this.balance;
        this.changePhase(PHASES.GROWTH, 'risky_jump_won_floor_logged');
      } else {
        this.failedRiskyStake = result.stake;
        const baseStake = this.normalizeStake(this.balance * this.options.baseStakePercent);
        if (this.balance >= baseStake * 4) {
          this.changePhase(PHASES.MARTINGALE, 'risky_jump_lost_one_recovery_allowed');
        } else {
          this.changePhase(PHASES.REBUILD, 'risky_jump_lost_rebuild');
        }
      }
    } else if (plan.kind === PHASES.MARTINGALE) {
      if (result.won) {
        if (this.balance > this.riskFloor) this.riskFloor = this.balance;
        this.failedRiskyStake = 0;
        this.changePhase(PHASES.GROWTH, 'martingale_won');
      } else {
        this.failedRiskyStake = 0;
        this.changePhase(PHASES.REBUILD, 'martingale_lost');
      }
    } else if (plan.kind === PHASES.REBUILD && this.balance >= this.options.seed) {
      this.riskFloor = this.options.seed;
      this.changePhase(PHASES.GROWTH, 'seed_recovered');
    }

    if (this.phase === PHASES.REBUILD && this.balance < this.options.seed * 0.5) {
      this.stop('stop_loss');
    }
  }

  changePhase(nextPhase, reason) {
    if (this.phase === nextPhase || this.stopped) return;
    const previous = this.phase;
    this.phase = nextPhase;
    const payload = this.phasePayload(previous, nextPhase, reason);
    console.log(
      `${new Date().toISOString()} phase_change ${previous} -> ${nextPhase} ` +
      `reason=${reason} balance=${this.balance.toFixed(2)} floor=${this.riskFloor.toFixed(2)}`
    );
    this.emit('phase_change', payload);
    this.emitBalance();
  }

  phasePayload(previous, nextPhase, reason) {
    return {
      time: new Date().toISOString(),
      from: previous,
      to: nextPhase,
      reason,
      balance: this.balance,
      riskFloor: this.riskFloor,
      seed: this.options.seed,
      target: this.options.target
    };
  }

  emitBalance() {
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
      riskFloor: this.riskFloor
    });
  }

  emitStatus(status) {
    this.emit('status', {
      status,
      mode: this.options.mode,
      accountId: this.options.accountId || null,
      accountKind: this.accountKind,
      symbol: this.options.symbol,
      phase: this.phase,
      seed: this.options.seed,
      target: this.options.target,
      balance: this.balance
    });
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
    console.log(`start=${summary.startingBalance.toFixed(2)} final=${summary.finalBalance.toFixed(2)} net=${summary.netProfit.toFixed(2)}`);
    console.log('=======================');
  }
}

module.exports = {
  DerivDigitBot,
  CONDITIONS,
  PHASES,
  roundMoney
};
