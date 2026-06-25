let MongoClient;
let ObjectId;

try {
  ({ MongoClient, ObjectId } = require('mongodb'));
} catch {
  MongoClient = null;
  ObjectId = null;
}

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapRun(doc) {
  if (!doc) return null;
  const id = doc._id && typeof doc._id.toString === 'function' ? doc._id.toString() : doc._id || doc.id || null;
  const snapshot = doc.snapshot ? clone(doc.snapshot) : null;

  return {
    id,
    _id: id,
    status: doc.status || 'unknown',
    mode: doc.mode || null,
    symbol: doc.symbol || null,
    currency: doc.currency || null,
    accountId: doc.accountId || null,
    accountKind: doc.accountKind || null,
    seed: toNumberOrNull(doc.seed),
    target: toNumberOrNull(doc.target),
    startedAt: toIso(doc.startedAt || snapshot?.startedAt),
    pausedAt: toIso(doc.pausedAt),
    endedAt: toIso(doc.endedAt),
    interruptedAt: toIso(doc.interruptedAt),
    updatedAt: toIso(doc.updatedAt),
    lastEventAt: toIso(doc.lastEventAt),
    pauseReason: doc.pauseReason || snapshot?.pauseReason || null,
    reason: doc.reason || null,
    summary: doc.summary ? clone(doc.summary) : null,
    snapshot,
    autoCycleMode: Boolean(doc.autoCycleMode ?? snapshot?.autoCycleMode ?? false),
    autoCycleProfit: toNumberOrNull(doc.autoCycleProfit ?? snapshot?.autoCycleProfit),
    autoCycleStake: toNumberOrNull(doc.autoCycleStake ?? snapshot?.autoCycleStake),
    autoCycleBankedProfit: toNumberOrNull(doc.autoCycleBankedProfit ?? snapshot?.autoCycleBankedProfit),
    autoCycleCompleted: Number(doc.autoCycleCompleted ?? snapshot?.autoCycleCompleted ?? 0),
    autoCycleRecycled: Number(doc.autoCycleRecycled ?? snapshot?.autoCycleRecycled ?? 0),
    autoCyclePartialLocked: Number(doc.autoCyclePartialLocked ?? snapshot?.autoCyclePartialLocked ?? 0),
    autoCycleHardRecovery: Boolean(doc.autoCycleHardRecovery ?? snapshot?.autoCycleHardRecovery ?? false),
    autoCycleStartTrade: Number(doc.autoCycleStartTrade ?? snapshot?.autoCycleStartTrade ?? 0),
    autoCycleTrades: Number(doc.autoCycleTrades ?? snapshot?.autoCycleTrades ?? 0),
    autoCycleMinBalance: toNumberOrNull(doc.autoCycleMinBalance ?? snapshot?.autoCycleMinBalance),
    autoCycleStruggled: Boolean(doc.autoCycleStruggled ?? snapshot?.autoCycleStruggled ?? false),
    autoCyclePartialExitTradeThreshold: Number(doc.autoCyclePartialExitTradeThreshold ?? snapshot?.autoCyclePartialExitTradeThreshold ?? 60),
    autoCyclePartialExitProfitRatio: toNumberOrNull(doc.autoCyclePartialExitProfitRatio ?? snapshot?.autoCyclePartialExitProfitRatio),
    autoCycleRecycleTradeThreshold: Number(doc.autoCycleRecycleTradeThreshold ?? snapshot?.autoCycleRecycleTradeThreshold ?? 100),
    strategyTarget: toNumberOrNull(doc.strategyTarget ?? snapshot?.strategyTarget),
    eventCount: Number(doc.eventCount || 0),
    balance: toNumberOrNull(doc.balance ?? snapshot?.balance),
    profitLoss: toNumberOrNull(
      doc.profitLoss !== undefined
        ? doc.profitLoss
        : snapshot && snapshot.balance !== undefined && snapshot.seed !== undefined
          ? Number(snapshot.balance) - Number(snapshot.seed)
          : undefined
    ),
    totalTrades: Number(doc.totalTrades ?? snapshot?.totalTrades ?? 0),
    wins: Number(doc.wins ?? snapshot?.wins ?? 0),
    losses: Number(doc.losses ?? snapshot?.losses ?? 0),
    winRate: toNumberOrNull(doc.winRate ?? snapshot?.winRate)
  };
}

function mapEvent(doc) {
  if (!doc) return null;
  const id = doc._id && typeof doc._id.toString === 'function' ? doc._id.toString() : doc._id || doc.id || null;
  const runId = doc.runId && typeof doc.runId.toString === 'function' ? doc.runId.toString() : doc.runId || null;
  return {
    id,
    _id: id,
    runId,
    type: doc.type || 'event',
    time: toIso(doc.time || doc.createdAt),
    createdAt: toIso(doc.createdAt),
    payload: doc.payload ? clone(doc.payload) : {}
  };
}

class MemoryRunStore {
  constructor() {
    this.runs = [];
    this.events = [];
    this.nextRunId = 1;
    this.nextEventId = 1;
  }

  async connect() {
    return true;
  }

  async close() {}

  async createRun(doc = {}) {
    const createdAt = new Date();
    const run = {
      _id: `memory-${this.nextRunId++}`,
      createdAt,
      updatedAt: createdAt,
      eventCount: 0,
      ...clone(doc)
    };
    this.runs.unshift(run);
    return mapRun(run);
  }

  async updateRun(runId, patch = {}) {
    const run = this.runs.find((item) => item._id === runId);
    if (!run) return null;
    Object.assign(run, clone(patch), { updatedAt: new Date() });
    return mapRun(run);
  }

  async appendEvent(runId, event = {}) {
    const now = new Date();
    const record = {
      _id: `memory-event-${this.nextEventId++}`,
      runId,
      type: event.type || 'event',
      time: event.time ? new Date(event.time) : now,
      createdAt: now,
      payload: clone(event.payload || {})
    };
    this.events.push(record);
    const run = this.runs.find((item) => item._id === runId);
    if (run) {
      run.eventCount = Number(run.eventCount || 0) + 1;
      run.lastEventAt = record.time;
      run.updatedAt = now;
    }
    return mapEvent(record);
  }

  async listRuns(limit = 20) {
    return this.runs.slice(0, limit).map(mapRun);
  }

  async getRun(runId) {
    return mapRun(this.runs.find((item) => item._id === runId));
  }

  async getRunEvents(runId, limit = 200) {
    return this.events
      .filter((event) => event.runId === runId)
      .slice(-limit)
      .map(mapEvent);
  }

  async getLatestActiveRun() {
    return mapRun(this.runs.find((run) => ['running', 'paused', 'starting'].includes(run.status)));
  }
}

class MongoRunStore {
  constructor({ uri, dbName = 'deriv_digit_bot' } = {}) {
    if (!MongoClient || !ObjectId) {
      throw new Error('The mongodb package is not installed.');
    }

    this.uri = uri;
    this.dbName = dbName;
    this.client = null;
    this.db = null;
    this.runs = null;
    this.events = null;
    this.ready = false;
  }

  parseId(id) {
    if (!id) return null;
    if (id instanceof ObjectId) return id;
    if (ObjectId.isValid(id)) return new ObjectId(id);
    return null;
  }

  async connect() {
    if (this.ready) return true;
    if (!this.uri) {
      throw new Error('MONGODB_URL is not configured.');
    }

    this.client = new MongoClient(this.uri, {
      maxPoolSize: 5
    });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.runs = this.db.collection('runs');
    this.events = this.db.collection('run_events');

    await Promise.all([
      this.runs.createIndex({ createdAt: -1 }),
      this.runs.createIndex({ status: 1, updatedAt: -1 }),
      this.events.createIndex({ runId: 1, createdAt: 1 }),
      this.events.createIndex({ runId: 1, time: 1 })
    ]);

    this.ready = true;
    return true;
  }

  async close() {
    if (this.client) {
      await this.client.close();
    }
    this.ready = false;
  }

  async createRun(doc = {}) {
    await this.connect();
    const createdAt = new Date();
    const runDoc = {
      createdAt,
      updatedAt: createdAt,
      eventCount: 0,
      ...clone(doc)
    };
    const result = await this.runs.insertOne(runDoc);
    return mapRun({ ...runDoc, _id: result.insertedId });
  }

  async updateRun(runId, patch = {}) {
    await this.connect();
    const objectId = this.parseId(runId);
    if (!objectId) return null;

    const updatedAt = new Date();
    await this.runs.updateOne(
      { _id: objectId },
      { $set: { ...clone(patch), updatedAt } }
    );
    return this.getRun(runId);
  }

  async appendEvent(runId, event = {}) {
    await this.connect();
    const objectId = this.parseId(runId);
    if (!objectId) return null;

    const now = new Date();
    const record = {
      runId: objectId,
      type: event.type || 'event',
      time: event.time ? new Date(event.time) : now,
      createdAt: now,
      payload: clone(event.payload || {})
    };

    const result = await this.events.insertOne(record);
    await this.runs.updateOne(
      { _id: objectId },
      {
        $set: {
          updatedAt: now,
          lastEventAt: record.time
        },
        $inc: { eventCount: 1 }
      }
    );

    return mapEvent({ ...record, _id: result.insertedId });
  }

  async listRuns(limit = 20) {
    await this.connect();
    const docs = await this.runs
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(mapRun);
  }

  async getRun(runId) {
    await this.connect();
    const objectId = this.parseId(runId);
    if (!objectId) return null;
    return mapRun(await this.runs.findOne({ _id: objectId }));
  }

  async getRunEvents(runId, limit = 200) {
    await this.connect();
    const objectId = this.parseId(runId);
    if (!objectId) return [];

    const docs = await this.events
      .find({ runId: objectId })
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
    return docs.map(mapEvent);
  }

  async getLatestActiveRun() {
    await this.connect();
    return mapRun(await this.runs.findOne({
      status: { $in: ['starting', 'running', 'paused'] }
    }, {
      sort: { updatedAt: -1, createdAt: -1 }
    }));
  }
}

function createRunStore({ mongoUrl, dbName } = {}) {
  if (mongoUrl) {
    return new MongoRunStore({ uri: mongoUrl, dbName });
  }
  return new MemoryRunStore();
}

module.exports = {
  createRunStore,
  MongoRunStore,
  MemoryRunStore
};
