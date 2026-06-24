require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { DerivDigitBot, roundMoney } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

let activeBot = null;
let lastSnapshot = null;

function boolFrom(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function numberFrom(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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
  return {
    defaultMode: process.env.DEFAULT_MODE || 'demo',
    defaultSymbol: process.env.SYMBOL || 'R_100',
    guideFilters: boolFrom(process.env.GUIDE_FILTERS, false),
    strictBarFilters: boolFrom(process.env.STRICT_BAR_FILTERS, false),
    hasEnvToken: Boolean(
      process.env.DERIV_API_TOKEN ||
      process.env.DERIV_DEMO_API_TOKEN ||
      process.env.DERIV_REAL_API_TOKEN
    )
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
    symbol: process.env.SYMBOL || 'R_100',
    currency: process.env.CURRENCY || 'USD',
    minStake: numberFrom(process.env.MIN_STAKE, 0.35),
    baseStakePercent: numberFrom(process.env.BASE_STAKE_PERCENT, 0.02),
    riskyStakePercent: numberFrom(process.env.RISKY_STAKE_PERCENT, 0.35),
    martingaleCapPercent: numberFrom(process.env.MARTINGALE_CAP_PERCENT, 0.4),
    windowSize: numberFrom(process.env.WINDOW_SIZE, 20),
    guideFilters: boolFrom(payload.guideFilters, boolFrom(process.env.GUIDE_FILTERS, false)),
    strictBarFilters: boolFrom(payload.strictBarFilters, boolFrom(process.env.STRICT_BAR_FILTERS, false))
  };
}

function bindBot(bot) {
  bot.on('status', (event) => io.emit('status', event));
  bot.on('account', (event) => io.emit('account', event));
  bot.on('digit', (event) => io.emit('digit', event));
  bot.on('trade', (event) => io.emit('trade', event));
  bot.on('phase_change', (event) => io.emit('phase_change', event));
  bot.on('balance_update', (event) => {
    lastSnapshot = event;
    io.emit('balance_update', event);
  });
  bot.on('error_event', (event) => io.emit('bot_error', event));
  bot.on('bot_stopped', (summary) => {
    io.emit('bot_stopped', summary);
    activeBot = null;
  });
}

app.use(requireBasicAuth);
app.get('/api/config', (req, res) => res.json(publicConfig()));
app.use(express.static(PUBLIC_DIR));

io.use((socket, next) => {
  if (basicAuthValid(socket.handshake.headers)) return next();
  next(new Error('Authentication required'));
});

io.on('connection', (socket) => {
  socket.emit('config', publicConfig());
  if (lastSnapshot) socket.emit('balance_update', lastSnapshot);

  socket.on('start_bot', async (payload, ack) => {
    try {
      if (activeBot) throw new Error('Bot is already running.');
      const config = sanitizeStartPayload(payload);
      activeBot = new DerivDigitBot(config);
      bindBot(activeBot);
      await activeBot.start();
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      activeBot = null;
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
      socket.emit('bot_error', { message: error.message });
    }
  });

  socket.on('stop_bot', async (payload, ack) => {
    try {
      if (!activeBot) throw new Error('No bot is running.');
      await activeBot.stop('manual');
      if (typeof ack === 'function') ack({ ok: true });
    } catch (error) {
      if (typeof ack === 'function') ack({ ok: false, error: error.message });
      socket.emit('bot_error', { message: error.message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Deriv Digit Bot dashboard listening on http://localhost:${PORT}`);
  if (!process.env.DASHBOARD_PASSWORD) {
    console.log('Warning: DASHBOARD_PASSWORD is not set. Do not expose this dashboard publicly.');
  }
});
