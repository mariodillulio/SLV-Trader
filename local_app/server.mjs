import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMetalPriceSilver, invalidSilver } from '../providers/metalPriceProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(__dirname, 'public');
const defaultStatePath = path.join(__dirname, 'data', 'state.json');
const localStatePath = path.join(__dirname, 'data', 'state.local.json');

await loadLocalEnv(path.join(root, '.env'));

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const sseClients = new Set();
const live = {
  connected: false,
  connecting: false,
  mode: 'manual',
  status: 'Manual/local app ready',
  lastError: null,
  lastMessageType: null,
  lastEventAt: null,
  requestedSymbols: [],
  streamerUrl: null,
  token: null,
  spotProvider: {
    price: null,
    source: 'manual fallback',
    status: 'Not requested',
    updatedAt: null,
    nextRefreshAt: 0,
    error: null
  },
  symbols: {},
  session: {
    slvVwapDollars: 0,
    slvVwapShares: 0,
    slvOpeningRangeHigh: null,
    slvOpeningRangeLow: null
  },
  dxlink: null,
  keepalive: null
};

await ensureLocalState();

const server = http.createServer(async (req, res) => {
  try {
    applyCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') return await sendFile(res, path.join(publicDir, 'index.html'), 'text/html');
    if (req.method === 'GET' && url.pathname === '/auth/tastytrade/url') return sendJson(res, await buildOAuthUrl());
    if (req.method === 'GET' && url.pathname === '/auth/tastytrade/start') return await startOAuth(req, res, url);
    if (req.method === 'GET' && url.pathname === '/auth/tastytrade/callback') return await finishOAuth(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/events') return eventStream(req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const assetPath = path.normalize(path.join(publicDir, url.pathname.replace('/assets/', '')));
      if (!assetPath.startsWith(publicDir)) return sendJson(res, { error: 'Invalid path' }, 400);
      return await sendFile(res, assetPath, contentType(assetPath));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, await terminalPayload());
    if (req.method === 'GET' && url.pathname === '/api/silver') return await silverPayload(req, res);
    if (req.method === 'GET' && url.pathname === '/api/setup/status') return sendJson(res, setupStatus());
    if (req.method === 'GET' && url.pathname === '/api/auth/status') return sendJson(res, await authStatus());
    if (req.method === 'POST' && url.pathname === '/api/inputs') return await updateInputs(req, res);
    if (req.method === 'POST' && url.pathname === '/api/log') return await logSnapshot(req, res);
    if (req.method === 'POST' && url.pathname === '/api/reset') return await resetDaily(req, res);
    if (req.method === 'POST' && url.pathname === '/api/live/start') return await startLiveData(req, res);
    if (req.method === 'POST' && url.pathname === '/api/live/stop') return await stopLiveData(req, res);
    if (req.method === 'GET' && url.pathname === '/api/options/chain') return await optionChainPayload(req, res);
    if (req.method === 'POST' && url.pathname === '/api/options/refresh') return await refreshOptionChain(req, res);
    if (req.method === 'POST' && url.pathname === '/api/options/select') return await selectOption(req, res);
    if (req.method === 'POST' && url.pathname === '/api/tastytrade/connect-grant') return await connectTastytradeGrant(req, res);
    if (req.method === 'POST' && url.pathname === '/api/tastytrade/connect-session') return await connectTastytradeSession(req, res);
    if (req.method === 'POST' && url.pathname === '/api/tastytrade/connect-oauth-client') return await connectOAuthClientCredentials(req, res);
    if (req.method === 'POST' && url.pathname === '/api/tastytrade/test') return await testTastytrade(req, res);
    if (req.method === 'POST' && url.pathname === '/api/tastytrade/positions') return await tastytradePositions(req, res);
    if (req.method === 'POST' && url.pathname === '/api/tastytrade/positions/select') return await selectTastytradePosition(req, res);
    return sendJson(res, { error: 'Not found' }, 404);
  } catch (error) {
    await recordRuntimeError(error);
    sendJson(res, { error: error.message }, 500);
  }
});

if (process.env.SLV_TERMINAL_NO_SERVER === '1') {
  const payload = await terminalPayload();
  console.log(JSON.stringify({
    action: payload.calculated.action,
    activeSetup: payload.calculated.activeSetup,
    tradeScore: payload.calculated.tradeScore,
    bullishCallScore: payload.calculated.bullishCallScore,
    bearishPutScore: payload.calculated.bearishPutScore,
    noTradeScore: payload.calculated.noTradeScore,
    bestContract: payload.calculated.contractRecommendation?.recommended?.label,
    contractDecision: payload.calculated.contractRecommendation?.finalDecision,
    contractScore: payload.calculated.contractRecommendation?.contractQuality?.score,
    entryTiming: payload.calculated.contractRecommendation?.entryTiming?.score,
    silverSource: payload.calculated.silver?.source,
    silverPrice: payload.calculated.silver?.price,
    silverValid: payload.calculated.silver?.valid,
    silverTimestamp: payload.calculated.silver?.timestamp,
    silverError: payload.calculated.silver?.error,
    bullTrigger: payload.calculated.bullTrigger,
    bearTrigger: payload.calculated.bearTrigger,
    marketStatus: payload.marketStatus
  }, null, 2));
} else {
  server.on('error', error => {
    console.error(`Unable to start Silver / SLV Play Finder on http://${host}:${port}`);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Close the other copy or run with PORT=8788.`);
    } else if (error.code === 'EPERM' || error.code === 'EACCES') {
      console.error('Permission was denied opening the local server port.');
      console.error('Run this from your normal Mac Terminal, not from the Codex sandbox. You can also try PORT=8788.');
    } else {
      console.error(error.message || error);
    }
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Silver / SLV Play Finder running at http://${host}:${port}`);
  });
}

async function ensureLocalState() {
  await mkdir(path.dirname(localStatePath), { recursive: true });
  if (!existsSync(localStatePath)) {
    const defaults = await readFile(defaultStatePath, 'utf8');
    await writeFile(localStatePath, defaults);
  }
}

async function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = await readFile(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function readState() {
  return normalizeState(JSON.parse(await readFile(localStatePath, 'utf8')));
}

async function writeState(state) {
  const body = JSON.stringify(state, null, 2);
  const tempPath = `${localStatePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, body);
  await rename(tempPath, localStatePath);
}

function normalizeState(state) {
  state.inputs ||= {};
  state.config ||= {};
  state.log ||= [];
  state.signalSnapshots = Array.isArray(state.signalSnapshots) ? state.signalSnapshots : [];
  state.actionTimeline = Array.isArray(state.actionTimeline) ? state.actionTimeline : [];
  state.optionChain ||= emptyOptionChain();
  state.positionsState ||= emptyPositionsState();
  state.tastytradePositions = Array.isArray(state.tastytradePositions) ? state.tastytradePositions : [];
  state.inputs.contracts = state.inputs.contracts || 1;
  state.inputs.optionType = state.inputs.optionType || 'C';
  state.inputs.timeValueFactor = state.inputs.timeValueFactor || 0.35;
  state.config.expectedSilverMin = numberOrNull(state.config.expectedSilverMin) ?? numberOrNull(process.env.EXPECTED_SILVER_MIN) ?? 45;
  state.config.expectedSilverMax = numberOrNull(state.config.expectedSilverMax) ?? numberOrNull(process.env.EXPECTED_SILVER_MAX) ?? 75;
  state.config.optionChainRefreshSeconds = numberOrNull(state.config.optionChainRefreshSeconds) ?? 300;
  state.config.positionRefreshSeconds = numberOrNull(state.config.positionRefreshSeconds) ?? 60;
  state.config.symbols = Array.isArray(state.config.symbols) ? state.config.symbols.filter(symbol => !isSilverProviderSymbol(symbol)) : ['SLV'];
  return state;
}

async function terminalPayload() {
  const state = await readState();
  applyLiveQuotesToInputs(state);
  await refreshExternalSilverIfNeeded(state.config, false, numberOrNull(state.inputs.slvPrice));
  const chainBefore = `${state.optionChain?.fetchedAt || ''}|${state.optionChain?.status || ''}|${state.optionChain?.error || ''}`;
  const positionsBefore = `${state.positionsState?.fetchedAt || ''}|${state.positionsState?.status || ''}|${state.positionsState?.error || ''}`;
  await refreshOptionChainIfNeeded(state);
  await refreshPositionsIfNeeded(state);
  const chainAfter = `${state.optionChain?.fetchedAt || ''}|${state.optionChain?.status || ''}|${state.optionChain?.error || ''}`;
  const positionsAfter = `${state.positionsState?.fetchedAt || ''}|${state.positionsState?.status || ''}|${state.positionsState?.error || ''}`;
  if (chainAfter !== chainBefore || positionsAfter !== positionsBefore) await writeState(state);
  const calculated = calculate(state.inputs, state);
  const signalLogged = recordSignalSnapshotIfNeeded(state, calculated);
  if (signalLogged) await writeState(state);
  const optionChain = enrichOptionChainWithLive(state.optionChain, numberOrNull(calculated.market?.slv?.price), state.inputs);
  const positions = calculatePositions(state, calculated);
  return {
    ...state,
    optionChain,
    calculated: { ...calculated, positions, actionTimeline: state.actionTimeline || [], signalSnapshots: state.signalSnapshots || [] },
    live: liveSnapshot(),
    auth: await authStatus(),
    marketStatus: marketStatus(),
    marketDataSources: marketDataSources(state),
    apiStatus: state.apiStatus || 'Manual/local app ready',
    timestamp: state.timestamp || new Date().toISOString(),
    nextScheduledUpdate: nextScheduledUpdate(),
    chart: buildChart(state.log, calculated)
  };
}

async function updateInputs(req, res) {
  const body = await readBody(req);
  const state = await readState();
  state.inputs = { ...state.inputs, ...body.inputs };
  state.config = { ...state.config, ...body.config };
  state.timestamp = new Date().toISOString();
  if (body.autoLog) appendLog(state, 'Manual/local update');
  await writeState(state);
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, payload);
}

async function logSnapshot(req, res) {
  const state = await readState();
  appendLog(state, 'Logged from local dashboard');
  await writeState(state);
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, payload);
}

async function resetDaily(req, res) {
  const state = await readState();
  Object.assign(state.inputs, {
    slvPremarket: '',
    slvVolume: '',
    vwap: '',
    openingRangeHigh: '',
    openingRangeLow: '',
    dayHigh: '',
    dayLow: ''
  });
  state.timestamp = new Date().toISOString();
  appendLog(state, 'Daily data reset');
  await writeState(state);
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, payload);
}

async function testTastytrade(req, res) {
  const state = await readState();
  const client = tastytradeClient(state.config);
  const accounts = await client.accounts();
  const quoteToken = await client.quoteToken();
  state.apiStatus = `Tastytrade OK | accounts: ${accounts.length} | quote token: ${quoteToken ? 'available' : 'missing'}`;
  state.timestamp = new Date().toISOString();
  await writeState(state);
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, { ok: true, auth: await authStatus(), accounts: accounts.length, quoteToken: Boolean(quoteToken), payload });
}

async function connectTastytradeGrant(req, res) {
  const state = await readState();
  const refreshToken = process.env.TASTYTRADE_REFRESH_TOKEN || state.tastytradeTokens?.refreshToken || '';
  if (!refreshToken) throw new Error('Set TASTYTRADE_REFRESH_TOKEN in .env before connecting the Tastytrade grant.');
  state.tastytradeTokens = {
    accessToken: null,
    refreshToken,
    tokenType: 'Bearer',
    expiresAt: new Date(0).toISOString(),
    grantType: 'personal_grant'
  };
  state.tastytradeSessionToken = null;
  state.oauth = null;
  const refreshed = await refreshOAuthTokenIfNeeded(state, true);
  state.config.provider = 'TASTYTRADE_LIVE';
  state.apiStatus = `Tastytrade grant connected; token expires ${refreshed.expiresAt || 'unknown'}`;
  state.timestamp = new Date().toISOString();
  appendLog(state, 'Tastytrade grant connected');
  await writeState(state);
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, { ok: true, auth: await authStatus(), payload });
}

async function connectTastytradeSession(req, res) {
  const state = await readState();
  const client = tastytradeClient(state.config);
  const token = await client.session(true);
  state.tastytradeSessionToken = token;
  state.tastytradeTokens = null;
  state.oauth = null;
  state.config.provider = 'TASTYTRADE_LIVE';
  state.apiStatus = 'Tastytrade session connected';
  state.timestamp = new Date().toISOString();
  appendLog(state, 'Tastytrade session connected');
  await writeState(state);
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, { ok: true, auth: await authStatus(), payload });
}

async function connectOAuthClientCredentials(req, res) {
  const state = await readState();
  const tokens = await fetchOAuthClientCredentialsToken(state.config);
  state.tastytradeTokens = tokens;
  state.oauth = null;
  state.config.provider = 'TASTYTRADE_LIVE';
  state.apiStatus = 'Tastytrade OAuth client connected';
  state.timestamp = new Date().toISOString();
  appendLog(state, 'Tastytrade OAuth client connected');
  await writeState(state);
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, { ok: true, auth: await authStatus(), payload });
}

async function tastytradePositions(req, res) {
  const state = await readState();
  await refreshPositionsIfNeeded(state, true);
  const positions = state.tastytradePositions || [];
  state.apiStatus = `Tastytrade positions refreshed: ${positions.length}`;
  state.timestamp = new Date().toISOString();
  appendLog(state, state.apiStatus);
  await writeState(state);
  if (live.connected || live.connecting) {
    const symbols = liveSubscriptionSymbols(state, state.config.symbols || ['SLV']);
    state.config.symbols = symbols;
    await writeState(state);
    closeDxLink('Reconnecting for positions');
    connectDxLink(state.config, symbols).catch(recordRuntimeError);
  }
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, { ok: true, accountNumber: state.positionsState?.accountNumber, positions, payload });
}

async function selectTastytradePosition(req, res) {
  const body = await readBody(req);
  const state = await readState();
  if (body.clear) {
    delete state.inputs.selectedPositionKey;
    delete state.inputs.selectedPositionSymbol;
    state.timestamp = new Date().toISOString();
    appendLog(state, 'Managed position reset to largest open SLV position');
    await writeState(state);
    const payload = await terminalPayload();
    broadcast(payload);
    return sendJson(res, { ok: true, selectedPositionKey: null, payload });
  }
  const key = compactPositionSymbol(body.positionKey || body.symbol || body.streamerSymbol || body.occSymbol);
  if (!key) throw new Error('Position selection requires a symbol or position key.');
  state.inputs.selectedPositionKey = key;
  state.inputs.selectedPositionSymbol = body.symbol || body.streamerSymbol || body.occSymbol || key;
  state.timestamp = new Date().toISOString();
  appendLog(state, `Selected managed position ${state.inputs.selectedPositionSymbol}`);
  await writeState(state);
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, { ok: true, selectedPositionKey: key, payload });
}

async function startLiveData(req, res) {
  const state = await readState();
  const body = await readBody(req);
  await refreshOptionChainIfNeeded(state, true);
  const symbols = liveSubscriptionSymbols(state, body.symbols || state.config.symbols || ['SLV']);
  state.config.symbols = symbols;
  state.config.provider = 'TASTYTRADE_LIVE';
  await writeState(state);
  await connectDxLink(state.config, symbols);
  sendJson(res, { ok: true, live: liveSnapshot(), payload: await terminalPayload() });
}

async function stopLiveData(req, res) {
  closeDxLink('Stopped by user');
  sendJson(res, { ok: true, live: liveSnapshot(), payload: await terminalPayload() });
}

async function silverPayload(req, res) {
  const state = await readState();
  applyLiveQuotesToInputs(state);
  await refreshExternalSilverIfNeeded(state.config, true, numberOrNull(state.inputs.slvPrice));
  const silver = normalizedSilverFromProvider(state.config, numberOrNull(state.inputs.slvPrice));
  sendJson(res, {
    silver,
    source: silver.source,
    valid: Boolean(silver.valid)
  });
}

function setupStatus() {
  return {
    providers: {
      metalPriceApi: {
        configured: Boolean(process.env.METALPRICE_API_KEY),
        required: true,
        status: process.env.METALPRICE_API_KEY ? 'Configured' : 'Missing METALPRICE_API_KEY'
      },
      tastytrade: {
        configured: Boolean(process.env.TASTYTRADE_REFRESH_TOKEN || process.env.TASTYTRADE_SESSION_TOKEN || (process.env.TASTYTRADE_USERNAME && process.env.TASTYTRADE_PASSWORD)),
        required: true,
        status: process.env.TASTYTRADE_REFRESH_TOKEN || process.env.TASTYTRADE_SESSION_TOKEN || (process.env.TASTYTRADE_USERNAME && process.env.TASTYTRADE_PASSWORD)
          ? 'Configured'
          : 'Missing Tastytrade credentials'
      }
    }
  };
}

async function refreshPositionsIfNeeded(state, force = false) {
  state.positionsState ||= emptyPositionsState();
  state.tastytradePositions = Array.isArray(state.tastytradePositions) ? state.tastytradePositions : [];
  const ttlMs = Math.max(15, Number(process.env.POSITION_REFRESH_SECONDS || state.config.positionRefreshSeconds || 60)) * 1000;
  const fetchedAt = Date.parse(state.positionsState.fetchedAt || '');
  if (!force && Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttlMs) return state.tastytradePositions;
  if (!hasTastytradeAuth(state)) {
    state.positionsState = { ...state.positionsState, status: 'No Tastytrade auth available for positions.', fetchedAt: new Date().toISOString(), error: null, count: state.tastytradePositions.length };
    return state.tastytradePositions;
  }
  try {
    const client = tastytradeClient(state.config);
    const accountNumber = state.config.tastytradeAccountNumber || await client.firstAccountNumber();
    const positions = await client.positions(accountNumber);
    state.tastytradePositions = positions;
    state.positionsState = { status: `Loaded ${positions.length} tastytrade positions`, fetchedAt: new Date().toISOString(), accountNumber, error: null, count: positions.length };
  } catch (error) {
    state.positionsState = { ...state.positionsState, status: 'Positions unavailable', fetchedAt: new Date().toISOString(), error: error.message, count: state.tastytradePositions.length };
  }
  return state.tastytradePositions;
}

async function optionChainPayload(req, res) {
  const state = await readState();
  await refreshOptionChainIfNeeded(state);
  await writeState(state);
  sendJson(res, { ok: true, optionChain: enrichOptionChainWithLive(state.optionChain, numberOrNull(state.inputs.slvPrice), state.inputs), selectedOption: getSelectedOption(state, { slvPrice: numberOrNull(state.inputs.slvPrice) }) });
}

async function refreshOptionChain(req, res) {
  const state = await readState();
  await refreshOptionChainIfNeeded(state, true);
  await writeState(state);
  if (live.connected || live.connecting) {
    const symbols = liveSubscriptionSymbols(state, state.config.symbols || ['SLV']);
    state.config.symbols = symbols;
    await writeState(state);
    closeDxLink('Reconnecting for refreshed option-chain quotes');
    connectDxLink(state.config, symbols).catch(recordRuntimeError);
  }
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, { ok: true, optionChain: state.optionChain, payload });
}

async function selectOption(req, res) {
  const body = await readBody(req);
  const state = await readState();
  const symbol = body.symbol || body.streamerSymbol || '';
  if (!symbol) throw new Error('Option selection requires symbol or streamerSymbol.');
  state.config.selectedOptionSymbol = symbol;
  state.inputs.optionSymbol = symbol;
  const selected = getSelectedOption(state, { slvPrice: numberOrNull(state.inputs.slvPrice) });
  if (selected) {
    state.inputs.optionStrike = selected.strike;
    state.inputs.optionExpiration = selected.expiration;
    state.inputs.optionType = selected.type;
    state.inputs.optionBid = selected.bid ?? state.inputs.optionBid;
    state.inputs.optionAsk = selected.ask ?? state.inputs.optionAsk;
  }
  state.timestamp = new Date().toISOString();
  await writeState(state);
  if (live.connected || live.connecting) {
    const symbols = liveSubscriptionSymbols(state, state.config.symbols || ['SLV']);
    state.config.symbols = symbols;
    await writeState(state);
    closeDxLink('Reconnecting for selected option');
    connectDxLink(state.config, symbols).catch(recordRuntimeError);
  }
  const payload = await terminalPayload();
  broadcast(payload);
  sendJson(res, { ok: true, selectedOption: selected, payload });
}

async function refreshOptionChainIfNeeded(state, force = false) {
  state.optionChain ||= emptyOptionChain();
  const ttlMs = Math.max(60, Number(process.env.OPTION_CHAIN_REFRESH_SECONDS || state.config.optionChainRefreshSeconds || 300)) * 1000;
  const now = Date.now();
  if (!force && state.optionChain.fetchedAt && state.optionChain.options?.length && now - Date.parse(state.optionChain.fetchedAt) < ttlMs) return state.optionChain;
  if (!hasTastytradeAuth(state)) {
    state.optionChain.status = 'No Tastytrade auth available for option chain.';
    return state.optionChain;
  }
  try {
    const client = tastytradeClient(state.config);
    const raw = await client.optionChain('SLV');
    state.optionChain = normalizeOptionChain(raw.payload, {
      endpoint: raw.endpoint,
      source: 'tastytrade option chain',
      underlying: 'SLV',
      currentSlv: numberOrNull(state.inputs.slvPrice)
    });
    state.optionChain.status = `Loaded ${state.optionChain.options.length} SLV options`;
    state.optionChain.error = null;
  } catch (error) {
    state.optionChain.status = 'Option chain unavailable';
    state.optionChain.error = error.message;
    state.optionChain.fetchedAt = new Date().toISOString();
  }
  return state.optionChain;
}

function hasTastytradeAuth(state = {}) {
  return Boolean(state.tastytradeTokens?.refreshToken || state.tastytradeTokens?.accessToken || process.env.TASTYTRADE_REFRESH_TOKEN || state.tastytradeSessionToken || process.env.TASTYTRADE_SESSION_TOKEN || (process.env.TASTYTRADE_USERNAME && process.env.TASTYTRADE_PASSWORD));
}

function emptyOptionChain() {
  return { underlying: 'SLV', source: 'not loaded', endpoint: null, fetchedAt: null, status: 'Not loaded', error: null, expirations: [], options: [] };
}

function emptyPositionsState() {
  return { status: 'Not loaded', fetchedAt: null, accountNumber: null, error: null, count: 0 };
}

function normalizeOptionChain(raw, meta = {}) {
  const options = [];
  const data = raw?.data || raw || {};
  const expirations = data.expirations || data.items || data['option-chains'] || data['option-chain'] || data;
  if (Array.isArray(expirations)) {
    for (const expirationNode of expirations) collectOptionsFromNode(expirationNode, options, {});
  } else {
    collectOptionsFromNode(expirations, options, {});
  }
  const unique = new Map();
  for (const option of options.map(normalizeOptionRecord)) {
    const key = option.streamerSymbol || option.symbol || `${option.expiration}-${option.type}-${option.strike}`;
    if (!key) continue;
    unique.set(key, { ...unique.get(key), ...option });
  }
  const normalized = [...unique.values()].filter(row => row.strike !== null && row.expiration);
  return {
    underlying: meta.underlying || 'SLV',
    source: meta.source || 'tastytrade option chain',
    endpoint: meta.endpoint || null,
    fetchedAt: new Date().toISOString(),
    status: `Loaded ${normalized.length} options`,
    error: null,
    rawShape: Array.isArray(expirations) ? 'array' : typeof expirations,
    options: normalized,
    expirations: summarizeExpirations(normalized, meta.currentSlv)
  };
}

function collectOptionsFromNode(node, output, inherited = {}) {
  if (!node || typeof node !== 'object') return;
  const inheritedNext = {
    ...inherited,
    expiration: node.expiration || node['expiration-date'] || node.expirationDate || inherited.expiration,
    dte: node.dte ?? node['days-to-expiration'] ?? node.daysToExpiration ?? inherited.dte
  };
  const call = node.call || node.Call || node.CALL;
  const put = node.put || node.Put || node.PUT;
  if (call) output.push(optionLegFromNestedValue(call, inheritedNext, node, 'C'));
  if (put) output.push(optionLegFromNestedValue(put, inheritedNext, node, 'P'));
  const symbol = node.symbol || node['option-symbol'] || node.optionSymbol || node['streamer-symbol'] || node.streamerSymbol;
  const optionType = node.type || node['option-type'] || node.optionType;
  if (symbol && (optionType || node.strike || node['strike-price'])) output.push({ ...inheritedNext, ...node });
  for (const key of ['strikes', 'options', 'items', 'expirations', 'option-chain', 'option-chains']) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach(item => collectOptionsFromNode(item, output, inheritedNext));
    else if (child && typeof child === 'object') collectOptionsFromNode(child, output, inheritedNext);
  }
}

function optionLegFromNestedValue(value, inherited, strikeNode, type) {
  const strike = numberOrNull(value?.strike ?? value?.['strike-price'] ?? strikeNode.strike ?? strikeNode['strike-price']);
  if (typeof value === 'string') {
    const parsed = parseOptionSymbol(value);
    return {
      ...inherited,
      symbol: value,
      occSymbol: value,
      streamerSymbol: parsed?.streamerSymbol || optionStreamerSymbolFromParts('SLV', inherited.expiration || parsed?.expiration, type, strike ?? parsed?.strike),
      displaySymbol: value,
      strike: strike ?? parsed?.strike,
      expiration: inherited.expiration || parsed?.expiration,
      type
    };
  }
  return {
    ...inherited,
    ...value,
    strike,
    expiration: value?.expiration || value?.['expiration-date'] || value?.expirationDate || inherited.expiration,
    type
  };
}

function parseOptionSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return null;
  const compact = raw.replace(/^\./, '').replace(/\s+/g, '').toUpperCase();
  const occ = compact.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (occ) {
    const [, underlying, yymmdd, type, strikeRaw] = occ;
    const strike = Number(strikeRaw) / 1000;
    return {
      underlying,
      expiration: expirationFromYYMMDD(yymmdd),
      type,
      strike,
      streamerSymbol: `.${underlying}${yymmdd}${type}${trimTrailingZeros(strike)}`
    };
  }
  const dx = compact.match(/^([A-Z]+)(\d{6})([CP])([0-9]+(?:\.[0-9]+)?)$/);
  if (!dx) return null;
  const [, underlying, yymmdd, type, strikeText] = dx;
  const strike = Number(strikeText);
  if (!Number.isFinite(strike)) return null;
  return {
    underlying,
    expiration: expirationFromYYMMDD(yymmdd),
    type,
    strike,
    streamerSymbol: `.${underlying}${yymmdd}${type}${trimTrailingZeros(strike)}`
  };
}

function expirationFromYYMMDD(yymmdd) {
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  if (!Number.isFinite(yy) || !mm || !dd) return null;
  return `${2000 + yy}-${mm}-${dd}`;
}

function calculate(input, state = {}) {
  const market = calculateMarketState(input, state);
  const silverValidation = validateSilverPrice(market.silver, market.slv.price, state.config);
  const dynamicRatio = calculateDynamicRatio(market, silverValidation, state);
  const impliedSLV = calculateImpliedSLV(silverValidation, dynamicRatio);
  const openingRange = calculateOpeningRange(input, state);
  const vwap = calculateVWAP(input, state, market);
  const atr = calculateATR(input, state, market);
  const triggers = calculateTriggers({ input, market, impliedSLV, openingRange, vwap, atr });
  const volume = calculateVolumePace(input, market, triggers);
  const selectedOption = getSelectedOption(state, market);
  const optionsLiquidityScore = calculateOptionsLiquidityScore(selectedOption);
  const tracking = calculateTrackingStatus(market.slv.price, impliedSLV, silverValidation);
  const trendScore = calculateTrendScore(market, triggers, vwap);
  const momentumScore = calculateMomentumScore(market, triggers, vwap, silverValidation, state, selectedOption);
  const volumeScore = calculateVolumeScore(volume.timeAdjustedPace);
  const institutionalFlow = calculateInstitutionalFlow(trendScore, volumeScore);
  const optionProjection = calculateOptionProjection({ market, selectedOption, contracts: market.contracts, triggers, vwap, atr });
  const targetOdds = calculateTargetOdds({ market, selectedOption, triggers, atr, optionProjection });
  const tradePlan = calculateTradePlan({ market, selectedOption, triggers, vwap, atr, optionProjection, targetOdds });
  const tradeScore = calculateTradeScore({ market, triggers, vwap, openingRange, silverValidation, tracking, volume, volumeScore, trendScore, selectedOption, optionsLiquidityScore, tradePlan });
  const dataQuality = calculateDataQuality({ market, selectedOption, silverValidation, optionsLiquidityScore });
  const strategyContext = {
    input,
    state,
    market,
    triggers,
    vwap,
    openingRange,
    silverValidation,
    tracking,
    volume,
    volumeScore,
    trendScore,
    momentumScore,
    selectedOption,
    optionsLiquidityScore,
    optionProjection,
    targetOdds,
    tradePlan,
    tradeScore,
    dataQuality,
    atr
  };
  const strategyScores = calculateAllStrategies(strategyContext);
  const positionManagement = strategyScores.positionManagement?.management || buildInactivePositionManagement(strategyContext);
  const bestSetup = selectBestActiveSetup(strategyScores, strategyContext);
  const signal = generateActionFromBestSetup(bestSetup, strategyContext);
  const contractRecommendation = calculateContractRecommendation({ ...strategyContext, strategyScores, bestSetup, signal });
  const why = generateStrategyWhyList(bestSetup, strategyContext);
  const bullishCallScore = Math.round(Math.max(strategyScores.bullishCallMomentum.score, strategyScores.vwapBounce.score));
  const bearishPutScore = Math.round(Math.max(strategyScores.bearishPutSpread.score, strategyScores.bearishBreakdown.score));
  const noTradeScore = Math.round(strategyScores.noTrade.score);
  const positionScore = Math.round(strategyScores.positionManagement.score);
  const confidencePercent = signal.confidencePercent;
  const confidence = confidenceFromPercent(confidencePercent, dataQuality);
  const tradeMap = calculateTradeMap({ market, triggers, vwap, tradePlan });
  const missionControl = calculateMissionControl({ market, selectedOption, optionProjection, targetOdds, tradePlan, signal, tradeScore, positionManagement, contractRecommendation });
  const aiTradeBrainText = generateAITradeBrainText({ market, silverValidation, tracking, triggers, vwap, volume, volumeScore, selectedOption, optionsLiquidityScore, signal, tradeScore, bestSetup, strategyScores, contractRecommendation, positionManagement });

  return {
    market,
    silver: silverValidation,
    dynamicRatio,
    slvImplied: impliedSLV,
    impliedSLV,
    bullTrigger: triggers.bullTrigger,
    bearTrigger: triggers.bearTrigger,
    neutralZone: triggers.neutralZoneLabel,
    expectedRangeHigh: triggers.expectedHigh,
    expectedRangeLow: triggers.expectedLow,
    openingRange,
    vwap,
    atr,
    volumePace: volume.timeAdjustedPace,
    volumePaceRaw: volume.rawPace,
    volumeScore,
    volumeConfirmation: volume.confirmation,
    volumeNote: volume.note,
    trend: trendScore >= 7 ? 'Bullish' : trendScore <= 3 ? 'Bearish' : 'Neutral',
    trendScore,
    momentumScore,
    optionsLiquidityScore,
    institutionalFlow,
    tracking,
    bullishCallScore,
    bearishPutScore,
    noTradeScore,
    positionScore,
    activeSetup: bestSetup.name,
    bestPlay: bestSetup.name,
    bestSetup,
    strategyScores,
    confidence,
    confidencePercent,
    tradeScore: tradeScore.value,
    tradeScoreBreakdown: tradeScore.breakdown,
    tradeScoreInterpretation: tradeScore.interpretation,
    action: signal.action,
    reasonSummary: signal.reason,
    dataQuality,
    why,
    tradePlan,
    tradeMap,
    positionManagement,
    contractRecommendation,
    targetOdds,
    missionControl,
    aiTradeBrainText,
    backtestReport: buildBacktestReportPlaceholder(state),
    selectedOption,
    options: optionProjection,
    watchlist: buildWatchlist(state, market),
    diagnosticsSummary: {
      optionChainStatus: state.optionChain?.status || 'not loaded',
      optionChainEndpoint: state.optionChain?.endpoint || null,
      silverSource: silverValidation.source,
      silverStatus: silverValidation.status,
      dxlink: live.status
    }
  };
}

function calculateMarketState(input, state = {}) {
  const slv = live.symbols.SLV || {};
  const slvBid = numberOrNull(slv.bid);
  const slvAsk = numberOrNull(slv.ask);
  const slvMid = slvBid !== null && slvAsk !== null ? round2((slvBid + slvAsk) / 2) : null;
  const slvLast = numberOrNull(slv.last) ?? numberOrNull(input.slvPrice) ?? slvMid;
  const priorClose = numberOrNull(slv.prevClose) ?? numberOrNull(input.priorSlvClose);
  const slvChange = slvLast !== null && priorClose !== null ? round2(slvLast - priorClose) : null;
  const slvChangePct = slvChange !== null && priorClose ? slvChange / priorClose : null;
  const selectedOption = getSelectedOption(state, { slvPrice: slvLast });
  const silver = normalizedSilverFromProvider(state.config, slvLast);
  const slvNormalized = {
    source: 'Tastytrade',
    symbol: 'SLV',
    price: slvLast,
    bid: slvBid,
    ask: slvAsk,
    mark: slvMid ?? slvLast,
    priorClose,
    open: numberOrNull(slv.open) ?? numberOrNull(input.slvOpen),
    high: numberOrNull(slv.high) ?? numberOrNull(input.dayHigh),
    low: numberOrNull(slv.low) ?? numberOrNull(input.dayLow),
    volume: numberOrNull(slv.volume) ?? numberOrNull(input.slvVolume),
    averageVolume: numberOrNull(input.avgSlvVolume),
    vwap: Number.isFinite(live.session.slvVwapShares) && live.session.slvVwapShares > 0
      ? round2(live.session.slvVwapDollars / live.session.slvVwapShares)
      : numberOrNull(input.vwap),
    change: slvChange,
    changePct: slvChangePct,
    timestamp: slv.updatedAt || new Date().toISOString()
  };
  const options = {
    source: 'Tastytrade',
    selectedContract: selectedOption,
    chainStatus: state.optionChain?.status || 'Not loaded',
    chainFetchedAt: state.optionChain?.fetchedAt || null
  };
  return {
    silver,
    slv: slvNormalized,
    options,
    timestamp: new Date().toISOString(),
    marketStatus: marketStatus(),
    slvPrice: slvLast,
    slvBid,
    slvAsk,
    slvMark: slvMid ?? slvLast,
    priorClose,
    slvOpen: numberOrNull(slv.open) ?? numberOrNull(input.slvOpen),
    dayHigh: numberOrNull(slv.high) ?? numberOrNull(input.dayHigh),
    dayLow: numberOrNull(slv.low) ?? numberOrNull(input.dayLow),
    slvVolume: numberOrNull(slv.volume) ?? numberOrNull(input.slvVolume),
    avgSlvVolume: numberOrNull(input.avgSlvVolume),
    slvChange,
    slvChangePct,
    premarketHigh: numberOrNull(input.premarketHigh) ?? numberOrNull(input.slvPremarket),
    premarketLow: numberOrNull(input.premarketLow) ?? numberOrNull(input.slvPremarket),
    silverRawPrice: silver,
    silverPriorClose: numberOrNull(silver.priorClose),
    silverChangePct: numberOrNull(silver.changePct),
    contracts: Math.max(1, numberOrNull(input.contracts) ?? 1),
    entryOverride: numberOrNull(input.optionEntryOverride) ?? numberOrNull(input.optionEntry),
    selectedOption
  };
}

function normalizedSilverFromProvider(config = {}, slvPrice = null) {
  const min = numberOrNull(config.expectedSilverMin) ?? numberOrNull(process.env.EXPECTED_SILVER_MIN) ?? 45;
  const max = numberOrNull(config.expectedSilverMax) ?? numberOrNull(process.env.EXPECTED_SILVER_MAX) ?? 75;
  const provider = live.spotProvider || {};
  if (provider.source === 'MetalPriceAPI' || provider.provider === 'MetalPriceAPI') {
    return {
      ...provider,
      timestamp: provider.timestamp || provider.updatedAt || null,
      updatedAt: provider.updatedAt || provider.timestamp || null,
      expectedRange: provider.expectedRange || { min, max }
    };
  }
  return invalidSilver({
    error: provider.error || null,
    reason: process.env.METALPRICE_API_KEY ? 'MetalPriceAPI has not returned silver yet' : 'MetalPriceAPI key is not configured',
    expectedMin: min,
    expectedMax: max
  });
}

function validateSilverPrice(rawSilver, slvPrice, config = {}) {
  const price = numberOrNull(rawSilver?.price);
  const min = numberOrNull(config.expectedSilverMin) ?? numberOrNull(process.env.EXPECTED_SILVER_MIN) ?? 45;
  const max = numberOrNull(config.expectedSilverMax) ?? numberOrNull(process.env.EXPECTED_SILVER_MAX) ?? 75;
  const result = {
    price,
    valid: Boolean(rawSilver?.valid) && price !== null,
    status: 'Silver feed invalid',
    reason: rawSilver?.reason || 'No silver quote',
    source: rawSilver?.source || 'MetalPriceAPI',
    provider: rawSilver?.provider || rawSilver?.source || 'MetalPriceAPI',
    symbol: rawSilver?.symbol || null,
    timestamp: rawSilver?.timestamp || rawSilver?.updatedAt || null,
    updatedAt: rawSilver?.updatedAt || rawSilver?.timestamp || null,
    change: numberOrNull(rawSilver?.change),
    changePct: numberOrNull(rawSilver?.changePct),
    priorClose: numberOrNull(rawSilver?.priorClose),
    high: numberOrNull(rawSilver?.high),
    low: numberOrNull(rawSilver?.low),
    error: rawSilver?.error || null,
    expectedRange: { min, max }
  };
  if (price === null) return result;
  if (price < min || price > max) {
    result.reason = `Silver ${price} outside expected ${min}-${max}`;
    return result;
  }
  if (price < 40 && slvPrice !== null && slvPrice > 45) {
    result.reason = 'Silver below 40 while SLV is above 45';
    return result;
  }
  result.valid = true;
  result.status = 'Silver valid';
  result.reason = rawSilver?.reason || 'Validated inside expected range';
  return result;
}

function calculateDynamicRatio(market, silverValidation, state = {}) {
  if (!silverValidation.valid || market.slv.price === null) {
    return { value: null, source: 'silver invalid', observations: [] };
  }
  const observations = [];
  const priorSilver = numberOrNull(market.silver.priorClose);
  if (market.slv.priorClose !== null && priorSilver !== null && priorSilver > 0) observations.push(market.slv.priorClose / priorSilver);
  if (observations.length === 0 && silverValidation.price > 0) observations.push(market.slv.price / silverValidation.price);
  for (const row of (state.log || []).slice(-25).reverse()) {
    const slv = numberOrNull(row.slvPrice);
    const silver = numberOrNull(row.silverPrice);
    if (slv !== null && silver !== null && silver >= silverValidation.expectedRange.min && silver <= silverValidation.expectedRange.max) observations.push(slv / silver);
    if (observations.length >= 5) break;
  }
  if (observations.length === 0) observations.push(numberOrNull(state.inputs?.silverToSlvRatio) ?? 0.905);
  const smoothed = observations.slice(0, 5).reduce((a, b) => a + b, 0) / Math.min(5, observations.length);
  return { value: round4(clamp(smoothed, 0.82, 1.02)), source: observations.length > 1 ? '5-observation smoothed' : 'current/prior observation', observations: observations.slice(0, 5).map(round4) };
}

function calculateImpliedSLV(silverValidation, ratio) {
  if (!silverValidation.valid || !Number.isFinite(ratio?.value)) return null;
  return round2(silverValidation.price * ratio.value);
}

function calculateOpeningRange(input, state = {}) {
  const minutes = easternMinutes();
  const high = numberOrNull(input.openingRangeHigh) ?? live.session.slvOpeningRangeHigh ?? numberOrNull(input.dayHigh);
  const low = numberOrNull(input.openingRangeLow) ?? live.session.slvOpeningRangeLow ?? numberOrNull(input.dayLow);
  return {
    high,
    low,
    status: minutes < 585 ? 'preliminary' : high !== null && low !== null ? 'confirmed' : 'unavailable'
  };
}

function calculateVWAP(input, state = {}, market = {}) {
  if (Number.isFinite(live.session.slvVwapShares) && live.session.slvVwapShares > 0) {
    return { value: round2(live.session.slvVwapDollars / live.session.slvVwapShares), status: 'live estimated from ticks' };
  }
  const manual = numberOrNull(input.vwap);
  if (manual !== null) return { value: manual, status: 'manual/provider value' };
  return { value: market.slv.mark ?? market.slv.price, status: 'estimated from current mark' };
}

function calculateATR(input, state = {}, market = {}) {
  const manual = numberOrNull(input.atr);
  if (manual !== null && manual > 0) return { value: manual, status: 'stored/manual ATR' };
  const high = numberOrNull(market.slv.high);
  const low = numberOrNull(market.slv.low);
  const prior = numberOrNull(market.slv.priorClose);
  const ranges = [];
  if (high !== null && low !== null) ranges.push(high - low);
  if (high !== null && prior !== null) ranges.push(Math.abs(high - prior));
  if (low !== null && prior !== null) ranges.push(Math.abs(low - prior));
  if (ranges.length) return { value: round2(Math.max(...ranges)), status: 'true-range estimate' };
  return { value: market.slv.price !== null ? round2(market.slv.price * 0.018) : null, status: '1.8% fallback' };
}

function calculateTriggers({ input, market, impliedSLV, openingRange, vwap, atr }) {
  const atrValue = atr.value ?? 0;
  const bullCandidates = [
    openingRange.high,
    vwap.value !== null ? vwap.value + Math.max(0.10, atrValue * 0.12) : null,
    market.slv.priorClose !== null ? market.slv.priorClose + Math.max(0.25, atrValue * 0.35) : null,
    impliedSLV !== null ? impliedSLV + 0.20 : null,
    numberOrNull(input.premarketHigh) ?? numberOrNull(input.slvPremarket)
  ].filter(Number.isFinite);
  const bearCandidates = [
    openingRange.low,
    vwap.value !== null ? vwap.value - Math.max(0.15, atrValue * 0.18) : null,
    market.slv.priorClose !== null ? market.slv.priorClose - Math.max(0.30, atrValue * 0.45) : null,
    impliedSLV !== null ? impliedSLV - 0.25 : null,
    numberOrNull(input.premarketLow) ?? numberOrNull(input.slvPremarket)
  ].filter(Number.isFinite);
  const fallback = market.slv.price ?? market.slv.priorClose ?? 0;
  const bullTrigger = roundNickel(bullCandidates.length ? Math.max(...bullCandidates) : fallback);
  const bearTrigger = roundNickel(bearCandidates.length ? Math.min(...bearCandidates) : fallback);
  return {
    bullTrigger,
    bearTrigger,
    neutralZone: { low: bearTrigger, high: bullTrigger },
    neutralZoneLabel: `$${bearTrigger.toFixed(2)} to $${bullTrigger.toFixed(2)}`,
    expectedHigh: market.slv.priorClose !== null && atr.value !== null ? round2(market.slv.priorClose + atr.value) : null,
    expectedLow: market.slv.priorClose !== null && atr.value !== null ? round2(market.slv.priorClose - atr.value) : null,
    bullCandidates,
    bearCandidates
  };
}

function calculateVolumePace(input, market, triggers) {
  const currentVolume = market.slv.volume;
  const averageVolume = market.slv.averageVolume;
  const rawPace = currentVolume !== null && averageVolume ? currentVolume / averageVolume : null;
  const curve = intradayVolumeCurve(marketMinutesElapsed());
  const expectedVolumeByNow = averageVolume ? averageVolume * curve : null;
  const timeAdjustedPace = currentVolume !== null && expectedVolumeByNow ? currentVolume / expectedVolumeByNow : rawPace;
  const volumeScore = calculateVolumeScore(timeAdjustedPace);
  const confirmation = timeAdjustedPace === null ? 'Missing volume'
    : market.slv.price !== null && market.slv.price > triggers.bullTrigger && timeAdjustedPace > 1.10 ? 'Bullish confirmed'
    : market.slv.price !== null && market.slv.price < triggers.bearTrigger && timeAdjustedPace > 1.10 ? 'Bearish confirmed'
    : timeAdjustedPace < 0.70 ? 'Head-fake risk'
    : 'Neutral';
  return {
    rawPace,
    timeAdjustedPace,
    expectedVolumeByNow,
    intradayCurve: curve,
    confirmation,
    score: volumeScore,
    note: timeAdjustedPace === null ? 'Awaiting live volume' : timeAdjustedPace < 0.7 ? 'Light tape: head-fake risk' : timeAdjustedPace > 1.1 ? 'Volume above confirmation threshold' : 'Volume neutral'
  };
}

function intradayVolumeCurve(minutesElapsed) {
  const points = [[0, 0.03], [15, 0.18], [30, 0.25], [90, 0.40], [150, 0.50], [210, 0.60], [270, 0.72], [330, 0.88], [375, 0.97], [390, 1.00]];
  const m = clamp(minutesElapsed, 0, 390);
  for (let i = 1; i < points.length; i++) {
    const [m1, v1] = points[i - 1];
    const [m2, v2] = points[i];
    if (m <= m2) return v1 + ((m - m1) / Math.max(1, m2 - m1)) * (v2 - v1);
  }
  return 1;
}

function marketMinutesElapsed() {
  return clamp(easternMinutes() - 570, 0, 390);
}

function calculateVolumeScore(pace) {
  if (pace === null || !Number.isFinite(pace)) return 0;
  return pace < 0.50 ? 2 : pace < 0.70 ? 3 : pace < 0.90 ? 5 : pace < 1.10 ? 6 : pace < 1.30 ? 8 : 10;
}

function calculateTrendScore(market, triggers, vwap) {
  return round2(clamp(5
    + (market.slv.price !== null && vwap.value !== null ? (market.slv.price > vwap.value ? 2 : -2) : 0)
    + (market.slv.price !== null ? (market.slv.price > triggers.bullTrigger ? 2 : market.slv.price < triggers.bearTrigger ? -2 : 0) : 0)
    + (market.slv.price !== null && market.slv.priorClose !== null ? (market.slv.price > market.slv.priorClose ? 1 : -1) : 0), 0, 10));
}

function calculateMomentumScore(market, triggers, vwap, silverValidation, state, selectedOption) {
  const history = recentSlvPrices(state);
  const higherHighs = history.length >= 3 && history.at(-1) > Math.max(...history.slice(0, -1));
  const lowerLows = history.length >= 3 && history.at(-1) < Math.min(...history.slice(0, -1));
  const optionBidRising = selectedOption?.bidTrend === 'rising';
  const optionBidFalling = selectedOption?.bidTrend === 'falling';
  return round2(clamp(5
    + (market.slv.price !== null && market.slv.priorClose !== null && market.slv.price > market.slv.priorClose ? 1.5 : 0)
    + (market.slv.price !== null && vwap.value !== null && market.slv.price > vwap.value ? 1.5 : 0)
    + (higherHighs ? 1.5 : 0)
    + (silverValidation.valid && (market.silver.changePct ?? 0) > 0 ? 1 : 0)
    + (optionBidRising ? 1 : 0)
    - (market.slv.price !== null && vwap.value !== null && market.slv.price < vwap.value ? 1.5 : 0)
    - (lowerLows ? 1.5 : 0)
    - (silverValidation.valid && (market.silver.changePct ?? 0) < 0 ? 1 : 0)
    - (optionBidFalling ? 1 : 0), 0, 10));
}

function calculateOptionsLiquidityScore(option) {
  if (!option) return 0;
  const bid = numberOrNull(option.bid);
  const ask = numberOrNull(option.ask);
  const mid = numberOrNull(option.mid) ?? (bid !== null && ask !== null ? (bid + ask) / 2 : null);
  if (bid === null || ask === null || !mid) return 0;
  const spreadPct = (ask - bid) / mid;
  let score = spreadPct < 0.05 ? 10 : spreadPct < 0.08 ? 8 : spreadPct < 0.12 ? 6 : spreadPct < 0.20 ? 4 : 2;
  if ((numberOrNull(option.volume) ?? 0) > 500) score += 1;
  if ((numberOrNull(option.openInterest) ?? 0) > 1000) score += 1;
  return clamp(score, 0, 10);
}

function calculateTrackingStatus(slvPrice, impliedSLV, silverValidation) {
  if (!silverValidation.valid) return 'Silver feed invalid';
  if (slvPrice === null || impliedSLV === null) return 'Missing data';
  const difference = round2(slvPrice - impliedSLV);
  if (Math.abs(difference) <= 0.25) return 'In line';
  return difference > 0.25 ? 'SLV leading' : 'SLV lagging';
}

function calculateInstitutionalFlow(trendScore, volumeScore) {
  return trendScore >= 7 && volumeScore >= 7 ? 'Buying' : trendScore <= 3 && volumeScore >= 7 ? 'Selling' : 'Neutral';
}

function calculateAllStrategies(ctx) {
  const bullishCallMomentum = calculateBullishCallMomentumScore(ctx);
  const vwapBounce = calculateVWAPBounceScore(ctx);
  const bearishPutSpread = calculateBearishPutSpreadScore(ctx);
  const bearishBreakdown = calculateBearishBreakdownScore(ctx);
  const noTrade = calculateNoTradeScore(ctx, { bullishCallMomentum, vwapBounce, bearishPutSpread, bearishBreakdown });
  const directionalContext = { ...ctx, strategyScores: { bullishCallMomentum, vwapBounce, bearishPutSpread, bearishBreakdown, noTrade } };
  const positionManagement = calculatePositionManagementScore(directionalContext);
  return { bullishCallMomentum, vwapBounce, bearishPutSpread, bearishBreakdown, noTrade, positionManagement };
}

function calculateBullishCallMomentumScore(ctx) {
  const { market, triggers, vwap, openingRange, silverValidation, tracking, volumeScore, selectedOption, optionsLiquidityScore, dataQuality } = ctx;
  let score = 50;
  const why = [];
  const slv = market.slv.price;
  const aboveBull = slv !== null && slv > triggers.bullTrigger;
  const aboveVwap = slv !== null && vwap.value !== null && slv > vwap.value;
  const abovePrior = slv !== null && market.slv.priorClose !== null && slv > market.slv.priorClose;
  const aboveOrHigh = slv !== null && openingRange.high !== null && slv > openingRange.high;
  const volumeOk = volumeScore >= 6;
  const volumeStrong = volumeScore >= 7;
  const silverSupport = silverValidation.valid && (market.silver.changePct ?? 0) >= 0;
  const delta = Math.abs(numberOrNull(selectedOption?.delta) ?? 0);
  const spread = numberOrNull(selectedOption?.spreadPct);
  if (aboveBull) score += 20; else score -= 6;
  if (aboveVwap) score += 10; else score -= 8;
  if (abovePrior) score += 5;
  if (aboveOrHigh) score += 5;
  if (volumeStrong) score += 10; else if (volumeOk) score += 5; else if (volumeScore <= 3) score -= 10;
  if (silverSupport) score += 10;
  if (silverValidation.valid && tracking === 'SLV lagging') score += 5;
  if (!silverValidation.valid) score -= 10;
  if (silverValidation.valid && (market.silver.changePct ?? 0) < 0) score -= 8;
  if (optionsLiquidityScore >= 7) score += 10; else if (optionsLiquidityScore <= 4) score -= 6;
  if (delta >= 0.35 && delta <= 0.65) score += 5;
  if (spread !== null && spread < 0.12) score += 5;
  if (spread !== null && spread > 0.20) score -= 10;
  if (slv !== null && slv < triggers.bearTrigger) score -= 18;

  why.push(strategyWhy('Bull trigger', aboveBull ? `${moneyText(slv)} is above ${moneyText(triggers.bullTrigger)}` : `${moneyText(triggers.bullTrigger - slv)} to clear`, aboveBull ? 'Bullish' : 'Waiting', aboveBull));
  why.push(strategyWhy('VWAP', aboveVwap ? `${moneyText(slv - vwap.value)} above VWAP` : `${moneyText(vwap.value - slv)} below VWAP`, aboveVwap ? 'Bullish' : 'Caution', aboveVwap));
  why.push(strategyWhy('Volume', `Score ${volumeScore}/10`, volumeOk ? 'Tradable' : 'Needs confirmation', volumeOk));
  why.push(strategyWhy('Silver confirmation', silverSupport ? 'Silver is supportive' : silverValidation.valid ? 'Silver is not supportive' : 'Silver feed invalid', silverSupport ? 'Bullish' : 'Warning', silverSupport));
  why.push(strategyWhy('Call liquidity', `Score ${optionsLiquidityScore}/10${spread !== null ? `, spread ${pctText(spread)}` : ''}`, optionsLiquidityScore >= 5 ? 'Acceptable' : 'Weak', optionsLiquidityScore >= 5));

  return strategyResult({
    id: 'bullishCallMomentum',
    name: 'Bullish Call Momentum',
    score,
    action: score >= 75 && aboveBull && volumeOk ? 'ENTER CALLS' : score >= 55 ? 'WAIT' : 'AVOID',
    reason: aboveBull && aboveVwap && volumeOk
      ? 'SLV is breaking the bull trigger with VWAP and enough volume support.'
      : 'Momentum call setup needs bull trigger, VWAP, and volume confirmation.',
    whyList: why,
    requiredConfirmation: 'SLV over bull trigger, above VWAP, volume score 6+',
    invalidationLevel: round2(Math.max(triggers.bearTrigger, (vwap.value ?? triggers.bearTrigger) - 0.15)),
    suggestedContractType: 'Calls',
    suggestedDteRange: '3-14 DTE',
    suggestedDeltaRange: '0.35-0.65 delta',
    riskNotes: 'Avoid chasing if SLV leads silver too far or the selected spread widens above 20%.'
  });
}

function calculateVWAPBounceScore(ctx) {
  const { market, triggers, vwap, openingRange, silverValidation, tracking, volumeScore, selectedOption, optionsLiquidityScore, atr } = ctx;
  let score = 50;
  const why = [];
  const slv = market.slv.price;
  const history = recentSlvPrices(ctx.state);
  const prev = history.length >= 2 ? history.at(-2) : null;
  const rising = history.length >= 3 ? history.at(-1) > history.at(-3) : false;
  const nearVwap = slv !== null && vwap.value !== null && Math.abs(slv - vwap.value) <= Math.max(0.15, (atr.value ?? 0.7) * 0.18);
  const aboveVwap = slv !== null && vwap.value !== null && slv > vwap.value;
  const reclaimedVwap = aboveVwap && prev !== null && prev <= vwap.value;
  const insideNeutralRising = slv !== null && slv >= triggers.bearTrigger && slv <= triggers.bullTrigger && rising;
  const orLowHeld = slv !== null && openingRange.low !== null && slv > openingRange.low;
  const silverStable = silverValidation.valid && (market.silver.changePct ?? 0) > -0.003;
  const callLiquidity = selectedOption?.type !== 'P' && optionsLiquidityScore >= 5;
  if (aboveVwap) score += 15;
  if (nearVwap) score += 10;
  if (reclaimedVwap) score += 12;
  if (insideNeutralRising) score += 8;
  if (orLowHeld) score += 7;
  if (volumeScore >= 6) score += 8; else if (volumeScore <= 3) score -= 10;
  if (silverStable) score += 8; else if (!silverValidation.valid) score -= 8;
  if (tracking === 'SLV lagging') score += 5;
  if (callLiquidity) score += 7; else if (optionsLiquidityScore <= 3) score -= 8;
  if (slv !== null && slv < triggers.bearTrigger) score -= 20;
  if (vwap.value !== null && slv !== null && slv < vwap.value - 0.20) score -= 12;

  why.push(strategyWhy('VWAP reclaim/hold', reclaimedVwap ? 'VWAP reclaimed' : aboveVwap ? 'Holding above VWAP' : 'Below VWAP', aboveVwap ? 'Constructive' : 'Waiting', aboveVwap));
  why.push(strategyWhy('Neutral zone behavior', insideNeutralRising ? 'Rising from inside the zone' : 'No clean reclaim sequence yet', insideNeutralRising ? 'Bullish' : 'Neutral', insideNeutralRising));
  why.push(strategyWhy('Opening range low', orLowHeld ? `${moneyText(openingRange.low)} held` : 'Opening range low not confirmed', orLowHeld ? 'Support held' : 'Caution', orLowHeld));
  why.push(strategyWhy('Volume improvement', `Score ${volumeScore}/10`, volumeScore >= 6 ? 'Improving' : 'Light tape', volumeScore >= 6));
  why.push(strategyWhy('Silver stability', silverStable ? 'Silver is stable/supportive' : 'Silver is weak or invalid', silverStable ? 'Supportive' : 'Warning', silverStable));

  return strategyResult({
    id: 'vwapBounce',
    name: 'VWAP Bounce / Reclaim',
    score,
    action: score >= 75 && aboveVwap && volumeScore >= 5 ? 'ENTER CALLS' : score >= 55 ? 'WAIT' : 'AVOID',
    reason: aboveVwap && volumeScore >= 5
      ? 'SLV is holding or reclaiming VWAP with improving tape.'
      : 'VWAP bounce setup needs a cleaner reclaim and improving volume.',
    whyList: why,
    requiredConfirmation: 'Hold above VWAP, opening range low defended, volume improving',
    invalidationLevel: round2((vwap.value ?? triggers.bearTrigger) - 0.15),
    suggestedContractType: 'Calls',
    suggestedDteRange: '3-10 DTE',
    suggestedDeltaRange: '0.40-0.65 delta',
    riskNotes: 'Invalid if the reclaim fails and SLV loses VWAP by more than 20 cents.'
  });
}

function calculateBearishPutSpreadScore(ctx) {
  const { market, triggers, vwap, openingRange, silverValidation, tracking, volumeScore, selectedOption, optionsLiquidityScore } = ctx;
  let score = 50;
  const why = [];
  const slv = market.slv.price;
  const belowBear = slv !== null && slv < triggers.bearTrigger;
  const belowVwap = slv !== null && vwap.value !== null && slv < vwap.value;
  const belowPrior = slv !== null && market.slv.priorClose !== null && slv < market.slv.priorClose;
  const belowOrLow = slv !== null && openingRange.low !== null && slv < openingRange.low;
  const silverWeak = silverValidation.valid && (market.silver.changePct ?? 0) < 0;
  const spread = numberOrNull(selectedOption?.spreadPct);
  const putDelta = selectedOption?.type === 'P' ? Math.abs(numberOrNull(selectedOption.delta) ?? 0) : 0;
  if (belowBear) score += 20; else score -= 5;
  if (belowVwap) score += 10; else score -= 7;
  if (belowPrior) score += 5;
  if (belowOrLow) score += 5;
  if (volumeScore >= 7) score += 10; else if (volumeScore <= 3) score -= 10;
  if (silverWeak) score += 10;
  if (silverValidation.valid && tracking === 'SLV leading' && (market.silver.changePct ?? 0) <= 0) score += 5;
  if (!silverValidation.valid) score -= 6;
  if (silverValidation.valid && (market.silver.changePct ?? 0) > 0.004) score -= 8;
  if (optionsLiquidityScore >= 7) score += 10; else if (optionsLiquidityScore <= 4) score -= 6;
  if (putDelta >= 0.20 && putDelta <= 0.55) score += 5;
  if (spread !== null && spread < 0.12) score += 5;
  if (spread !== null && spread > 0.20) score -= 10;

  why.push(strategyWhy('Bear trigger', belowBear ? `${moneyText(slv)} is below ${moneyText(triggers.bearTrigger)}` : `${moneyText(slv - triggers.bearTrigger)} above bear trigger`, belowBear ? 'Bearish' : 'Waiting', belowBear));
  why.push(strategyWhy('VWAP', belowVwap ? `${moneyText(vwap.value - slv)} below VWAP` : 'Above VWAP', belowVwap ? 'Bearish' : 'Caution', belowVwap));
  why.push(strategyWhy('Volume', `Score ${volumeScore}/10`, volumeScore >= 6 ? 'Tradable' : 'Light', volumeScore >= 6));
  why.push(strategyWhy('Silver confirmation', silverWeak ? 'Silver is negative' : silverValidation.valid ? 'Silver is not bearish' : 'Silver invalid', silverWeak ? 'Bearish' : 'Mixed', silverWeak));
  why.push(strategyWhy('Put spread liquidity', `Score ${optionsLiquidityScore}/10${spread !== null ? `, spread ${pctText(spread)}` : ''}`, optionsLiquidityScore >= 5 ? 'Acceptable' : 'Weak', optionsLiquidityScore >= 5));

  return strategyResult({
    id: 'bearishPutSpread',
    name: 'Bearish Put Spread',
    score,
    action: score >= 75 && belowBear && belowVwap ? 'ENTER PUT SPREAD' : score >= 55 ? 'WAIT' : 'AVOID',
    reason: belowBear && belowVwap
      ? 'SLV is below the bear trigger and VWAP with bearish structure.'
      : 'Bearish put spread needs a bear trigger break and VWAP rejection.',
    whyList: why,
    requiredConfirmation: 'SLV below bear trigger and VWAP with volume score 6+',
    invalidationLevel: round2(Math.min(triggers.bullTrigger, (vwap.value ?? triggers.bullTrigger) + 0.15)),
    suggestedContractType: 'Put spreads',
    suggestedDteRange: '3-14 DTE',
    suggestedDeltaRange: 'Short risk-defined, long put 0.25-0.50 delta',
    riskNotes: 'Prefer spreads when IV is elevated or put premium is wide.'
  });
}

function calculateBearishBreakdownScore(ctx) {
  const { market, triggers, vwap, openingRange, silverValidation, volumeScore, selectedOption, optionsLiquidityScore } = ctx;
  let score = 50;
  const why = [];
  const slv = market.slv.price;
  const history = recentSlvPrices(ctx.state);
  const lowerLows = history.length >= 3 && history.at(-1) < Math.min(...history.slice(0, -1));
  const belowBear = slv !== null && slv < triggers.bearTrigger;
  const belowVwap = slv !== null && vwap.value !== null && slv < vwap.value;
  const silverBreaks = silverValidation.valid && (market.silver.changePct ?? 0) <= -0.004;
  const putBidRising = selectedOption?.type === 'P' && selectedOption?.bidTrend === 'rising';
  if (belowBear && volumeScore >= 6) score += 20;
  if (belowVwap) score += 10;
  if (openingRange.low !== null && slv !== null && slv < openingRange.low) score += 8;
  if (silverBreaks) score += 12;
  if (volumeScore >= 8) score += 10; else if (volumeScore <= 3) score -= 10;
  if (lowerLows) score += 10;
  if (putBidRising) score += 5;
  if (optionsLiquidityScore >= 6) score += 6; else if (optionsLiquidityScore <= 3) score -= 8;
  if (!belowBear) score -= 12;
  if (!belowVwap) score -= 8;

  why.push(strategyWhy('Breakdown level', belowBear ? 'Bear trigger broken' : 'Bear trigger still holding', belowBear ? 'Bearish' : 'Waiting', belowBear));
  why.push(strategyWhy('Tape speed', `Volume score ${volumeScore}/10`, volumeScore >= 8 ? 'Heavy' : volumeScore >= 6 ? 'Enough' : 'Light', volumeScore >= 6));
  why.push(strategyWhy('Lower lows', lowerLows ? 'Snapshot history is making lower lows' : 'No clear lower-low sequence', lowerLows ? 'Bearish' : 'Neutral', lowerLows));
  why.push(strategyWhy('Silver support break', silverBreaks ? 'Silver trend is breaking lower' : 'Silver is not confirming a break', silverBreaks ? 'Bearish' : 'Mixed', silverBreaks));
  why.push(strategyWhy('Put bid pressure', putBidRising ? 'Put bid is rising' : 'Put bid trend not confirmed', putBidRising ? 'Bearish' : 'Neutral', putBidRising));

  return strategyResult({
    id: 'bearishBreakdown',
    name: 'Bearish Breakdown',
    score,
    action: score >= 80 && belowBear && belowVwap ? 'ENTER PUTS / PUT SPREAD' : score >= 60 ? 'WAIT' : 'AVOID',
    reason: belowBear && belowVwap && volumeScore >= 6
      ? 'SLV is breaking down through the bear trigger and VWAP with pressure.'
      : 'Breakdown setup needs more confirmation before a short-dated bearish trade.',
    whyList: why,
    requiredConfirmation: 'Bear trigger break, lower lows, heavy volume, silver weakness',
    invalidationLevel: round2((vwap.value ?? triggers.bearTrigger) + 0.20),
    suggestedContractType: 'Puts or put spreads',
    suggestedDteRange: '2-10 DTE',
    suggestedDeltaRange: '0.30-0.55 delta',
    riskNotes: 'Breakdown trades can snap back quickly if SLV reclaims VWAP.'
  });
}

function calculateNoTradeScore(ctx, directional = {}) {
  const { market, triggers, vwap, silverValidation, tracking, volumeScore, trendScore, selectedOption, optionsLiquidityScore, dataQuality } = ctx;
  let score = 50;
  const why = [];
  const slv = market.slv.price;
  const inNeutral = slv !== null && slv >= triggers.bearTrigger && slv <= triggers.bullTrigger;
  const directionlessVwap = slv !== null && vwap.value !== null && Math.abs(slv - vwap.value) <= 0.10;
  const mixedTrend = trendScore >= 4 && trendScore <= 6;
  const wideSpread = (numberOrNull(selectedOption?.spreadPct) ?? 0) > 0.20 || optionsLiquidityScore <= 3;
  const directionalHigh = Math.max(
    directional.bullishCallMomentum?.score ?? 0,
    directional.vwapBounce?.score ?? 0,
    directional.bearishPutSpread?.score ?? 0,
    directional.bearishBreakdown?.score ?? 0
  );
  if (inNeutral) score += 18;
  if (directionlessVwap) score += 10;
  if (volumeScore <= 3) score += 12;
  if (!silverValidation.valid) score += 8;
  if (silverValidation.valid && tracking === 'SLV leading' && Math.abs(market.silver.changePct ?? 0) < 0.002) score += 6;
  if (wideSpread) score += 12;
  if (mixedTrend) score += 8;
  if (dataQuality.status === 'BAD') score += 25;
  if (directionalHigh >= 75) score -= 24;
  else if (directionalHigh >= 65) score -= 12;

  why.push(strategyWhy('Battlefield zone', inNeutral ? 'SLV is inside the neutral zone' : 'SLV is outside the neutral zone', inNeutral ? 'Chop risk' : 'Directional', !inNeutral));
  why.push(strategyWhy('VWAP distance', directionlessVwap ? 'Price is pinned near VWAP' : 'Price has separated from VWAP', directionlessVwap ? 'Chop risk' : 'Cleaner', !directionlessVwap));
  why.push(strategyWhy('Volume quality', `Score ${volumeScore}/10`, volumeScore <= 3 ? 'Too light' : 'Usable', volumeScore > 3));
  why.push(strategyWhy('Data quality', dataQuality.status, dataQuality.status === 'BAD' ? 'No trade' : 'Usable', dataQuality.status !== 'BAD'));
  why.push(strategyWhy('Option spread', wideSpread ? 'Spread/liquidity is poor' : 'Spread/liquidity is usable', wideSpread ? 'Avoid' : 'Usable', !wideSpread));

  return strategyResult({
    id: 'noTrade',
    name: score >= 65 ? 'No Edge / Chop Zone' : 'No Trade Watch',
    score,
    action: dataQuality.status === 'BAD' || wideSpread || volumeScore <= 3 ? 'AVOID' : 'WAIT',
    reason: score >= 65
      ? 'The market is too mixed or execution quality is too weak for a clean entry.'
      : 'No-trade risk is present but not dominant.',
    whyList: why,
    requiredConfirmation: 'Wait for one directional setup above 70 with clean data',
    invalidationLevel: null,
    suggestedContractType: 'None',
    suggestedDteRange: 'None',
    suggestedDeltaRange: 'None',
    riskNotes: 'Preserving buying power is the play when the edge is unclear.'
  });
}

function calculatePositionManagementScore(ctx) {
  const management = buildPositionManagement(ctx);
  if (!management.active) {
    return strategyResult({
      id: 'positionManagement',
      name: 'Position Management Mode',
      score: 0,
      action: 'WAIT',
      reason: 'No open or tracked SLV option position is active.',
      whyList: [strategyWhy('Position mode', 'No open/tracked position detected', 'Inactive', false)],
      requiredConfirmation: 'Open tastytrade position or enable trade tracking.',
      invalidationLevel: ctx.tradePlan?.stopSLV ?? null,
      suggestedContractType: ctx.selectedOption?.type === 'P' ? 'Puts' : 'Calls',
      suggestedDteRange: 'Use existing position',
      suggestedDeltaRange: 'Use existing position',
      riskNotes: 'Position mode activates when a live or tracked position exists.',
      active: false,
      management
    });
  }

  return strategyResult({
    id: 'positionManagement',
    name: 'POSITION MODE',
    score: management.score,
    action: management.signal,
    reason: management.reason,
    whyList: management.reasons,
    requiredConfirmation: management.requiredConfirmation,
    invalidationLevel: management.levels?.stopSLV ?? null,
    suggestedContractType: management.position?.type === 'P' ? 'Puts' : 'Calls',
    suggestedDteRange: 'Use existing position',
    suggestedDeltaRange: 'Use existing position',
    riskNotes: 'Position management overrides fresh-entry signals.',
    active: true,
    management
  });
}

function selectBestActiveSetup(strategyScores, ctx) {
  const position = strategyScores.positionManagement;
  const directional = [
    strategyScores.bullishCallMomentum,
    strategyScores.vwapBounce,
    strategyScores.bearishPutSpread,
    strategyScores.bearishBreakdown
  ].sort((a, b) => b.score - a.score);
  const bestDirectional = directional[0];
  const noTrade = strategyScores.noTrade;
  if (position.active) return { ...position, secondarySetup: bestDirectional };
  if (ctx.dataQuality.status === 'BAD') {
    return { ...noTrade, name: 'No Edge / Data Bad', action: 'AVOID', score: Math.max(noTrade.score, 85), secondarySetup: bestDirectional };
  }
  if (!bestDirectional || bestDirectional.score < 60 || noTrade.score >= bestDirectional.score) {
    return { ...noTrade, name: noTrade.score >= 65 ? 'No Edge / Chop Zone' : 'No Edge', secondarySetup: bestDirectional };
  }
  return { ...bestDirectional, secondarySetup: noTrade };
}

function generateActionFromBestSetup(bestSetup, ctx) {
  if (bestSetup?.id === 'positionManagement') {
    return {
      action: bestSetup.action || 'HOLD',
      reason: bestSetup.reason || 'Position mode is active.',
      confidencePercent: Math.round(clamp(bestSetup.score - (ctx.dataQuality.status === 'BAD' ? 5 : 0), 0, 100))
    };
  }
  if (ctx.dataQuality.status === 'BAD') {
    return {
      action: 'AVOID',
      reason: 'Data quality is bad, so the Play Finder will not allow a fresh entry.',
      confidencePercent: Math.round(clamp(Math.max(bestSetup.score, 45), 0, 100))
    };
  }
  let action = bestSetup.action || 'WAIT';
  if (action.startsWith('ENTER') && bestSetup.score < 75) action = 'WAIT';
  if (action.startsWith('ENTER') && ctx.market.marketStatus === 'PREMARKET' && ctx.volumeScore < 7) action = 'WAIT';
  const confidencePercent = Math.round(clamp(bestSetup.score - (ctx.dataQuality.status === 'WARNING' ? 7 : 0), 0, 100));
  return {
    action,
    reason: bestSetup.reason || `${bestSetup.name} is the best current setup.`,
    confidencePercent
  };
}

function generateStrategyWhyList(bestSetup, ctx) {
  const rows = Array.isArray(bestSetup.whyList) ? [...bestSetup.whyList] : [];
  rows.unshift(strategyWhy('Active setup', `${bestSetup.name} scored ${Math.round(bestSetup.score)}/100`, bestSetup.action || 'WAIT', bestSetup.score >= 60));
  if (bestSetup.secondarySetup) {
    rows.push(strategyWhy('Secondary read', `${bestSetup.secondarySetup.name} scored ${Math.round(bestSetup.secondarySetup.score)}/100`, 'Context', true));
  }
  rows.push(strategyWhy('Required confirmation', bestSetup.requiredConfirmation || 'Wait for confirmation', bestSetup.score >= 75 ? 'Confirmed' : 'Waiting', bestSetup.score >= 75));
  return rows.slice(0, 9);
}

function strategyResult({ id, name, score, action, reason, whyList, requiredConfirmation, invalidationLevel, suggestedContractType, suggestedDteRange, suggestedDeltaRange, riskNotes, active = true, ...rest }) {
  const value = Math.round(clamp(score, 0, 100));
  return {
    id,
    name,
    score: value,
    action,
    confidence: value,
    whyList,
    reason,
    requiredConfirmation,
    invalidationLevel,
    suggestedContractType,
    suggestedDteRange,
    suggestedDeltaRange,
    riskNotes,
    active,
    ...rest
  };
}

function strategyWhy(label, detail, status, passed) {
  return { label, detail, status, passed: Boolean(passed) };
}

function buildInactivePositionManagement(ctx = {}) {
  return {
    active: false,
    mode: 'PLANNING',
    signal: 'WAIT',
    score: 0,
    reason: 'No open or tracked SLV option position is active.',
    requiredConfirmation: 'Select a contract for planning, or open/track a position to activate position mode.',
    position: null,
    levels: {
      stopSLV: ctx.tradePlan?.stopSLV ?? null,
      trim1SLV: ctx.tradePlan?.trim1SLV ?? null,
      trim2SLV: ctx.tradePlan?.trim2SLV ?? null,
      runnerSLV: ctx.tradePlan?.runnerSLV ?? null
    },
    reasons: [strategyWhy('Position mode', 'No open/tracked position detected', 'Inactive', false)]
  };
}

function buildPositionManagement(ctx = {}) {
  const position = primaryManagedPosition(ctx);
  if (!position) return buildInactivePositionManagement(ctx);
  const direction = positionDirection(position);
  const bullish = direction === 'bullish';
  const slv = numberOrNull(ctx.market?.slv?.price);
  const vwapValue = numberOrNull(ctx.vwap?.value);
  const bull = numberOrNull(ctx.triggers?.bullTrigger);
  const bear = numberOrNull(ctx.triggers?.bearTrigger);
  const levels = positionManagementLevels(ctx, position, direction);
  const activeBullishScore = Math.max(ctx.strategyScores?.bullishCallMomentum?.score ?? 0, ctx.strategyScores?.vwapBounce?.score ?? 0);
  const activeBearishScore = Math.max(ctx.strategyScores?.bearishPutSpread?.score ?? 0, ctx.strategyScores?.bearishBreakdown?.score ?? 0);
  const activeSetupScore = bullish ? activeBullishScore : activeBearishScore;
  const returnPct = numberOrNull(position.returnPct);
  const dte = numberOrNull(position.dte);
  const currentMid = numberOrNull(position.currentMid);
  const theta = numberOrNull(position.theta);
  const spreadPct = numberOrNull(position.spreadPct);
  const confirmsVwap = slv !== null && vwapValue !== null && (bullish ? slv > vwapValue : slv < vwapValue);
  const losesVwap = slv !== null && vwapValue !== null && (bullish ? slv < vwapValue : slv > vwapValue);
  const breaksTrigger = slv !== null && (bullish ? (bear !== null && slv < bear) : (bull !== null && slv > bull));
  const stopHit = slv !== null && levels.stopSLV !== null && (bullish ? slv <= levels.stopSLV : slv >= levels.stopSLV);
  const trim1SlvHit = slv !== null && levels.trim1SLV !== null && (bullish ? slv >= levels.trim1SLV : slv <= levels.trim1SLV);
  const trim2SlvHit = slv !== null && levels.trim2SLV !== null && (bullish ? slv >= levels.trim2SLV : slv <= levels.trim2SLV);
  const runnerHit = slv !== null && levels.runnerSLV !== null && (bullish ? slv >= levels.runnerSLV : slv <= levels.runnerSLV);
  const trim1OptionHit = currentMid !== null && levels.trim1Option !== null && currentMid >= levels.trim1Option;
  const trim2OptionHit = currentMid !== null && levels.trim2Option !== null && currentMid >= levels.trim2Option;
  const loss35LowDte = returnPct !== null && returnPct <= -0.35 && dte !== null && dte <= 3;
  const loss50 = returnPct !== null && returnPct <= -0.50;
  const profit40 = returnPct !== null && returnPct >= 0.40;
  const profit80 = returnPct !== null && returnPct >= 0.80;
  const thetaDrag = currentMid ? (theta !== null ? Math.abs(theta) / currentMid : null) : null;
  const spreadWide = spreadPct !== null && spreadPct > 0.25;
  const dataBad = ctx.dataQuality?.status === 'BAD';
  const thesisValid = confirmsVwap && activeSetupScore >= 60 && !breaksTrigger;
  const addOk = bullish
    ? activeSetupScore >= 85 && (ctx.tradeScore?.value ?? 0) >= 85 && slv !== null && bull !== null && slv > bull && ctx.volumeScore >= 7 && !(returnPct !== null && returnPct <= -0.20)
    : activeSetupScore >= 85 && (ctx.tradeScore?.value ?? 0) >= 85 && slv !== null && bear !== null && slv < bear && ctx.volumeScore >= 7 && !(returnPct !== null && returnPct <= -0.20);

  let signal = 'WAIT';
  const triggers = [];
  if (dataBad) {
    signal = 'EXIT';
    triggers.push(`Data quality is BAD: ${ctx.dataQuality?.reason || 'quotes are not reliable'}`);
  } else if (spreadWide) {
    signal = 'EXIT';
    triggers.push(`Option spread is ${pctText(spreadPct)}, above the 25% max`);
  } else if (loss50) {
    signal = 'EXIT';
    triggers.push(`Option is down ${pctText(Math.abs(returnPct))}, beyond the 50% max-loss rule`);
  } else if (loss35LowDte) {
    signal = 'EXIT';
    triggers.push(`Option is down ${pctText(Math.abs(returnPct))} with ${dte} DTE, beyond the low-DTE loss rule`);
  } else if (breaksTrigger || stopHit) {
    signal = 'EXIT';
    triggers.push(bullish ? `SLV broke the bear/stop zone near ${moneyText(levels.stopSLV)}` : `SLV reclaimed the bull/stop zone near ${moneyText(levels.stopSLV)}`);
  } else if (losesVwap && activeSetupScore < 55) {
    signal = 'EXIT';
    triggers.push(`SLV lost VWAP and the active setup score is only ${Math.round(activeSetupScore)}/100`);
  } else if (profit80 || trim2SlvHit || trim2OptionHit || runnerHit) {
    signal = 'TRIM MORE';
    triggers.push(profit80 ? `Position return is ${pctText(returnPct)}` : `Trim 2/runner level is active`);
  } else if (profit40 || trim1SlvHit || trim1OptionHit) {
    signal = 'TRIM';
    triggers.push(profit40 ? `Position return is ${pctText(returnPct)}` : `Trim 1 level is active`);
  } else if (thesisValid && (dte !== null && dte <= 1 || thetaDrag !== null && thetaDrag > 0.15)) {
    signal = 'ROLL';
    triggers.push(`Thesis is intact, but ${dte ?? '-'} DTE / theta drag ${pctText(thetaDrag)} argues for rolling`);
  } else if (addOk) {
    signal = 'ADD';
    triggers.push(`Setup score ${Math.round(activeSetupScore)}/100, trade score ${ctx.tradeScore?.value ?? '-'}/100, and volume score ${ctx.volumeScore}/10 allow an add`);
  } else if (thesisValid) {
    signal = 'HOLD';
    triggers.push(`SLV is on the right side of VWAP and active setup score is ${Math.round(activeSetupScore)}/100`);
  } else {
    signal = 'WAIT';
    triggers.push(`Position is open, but reclaim/confirmation is not strong enough to add or hold aggressively`);
  }

  const score = signal === 'EXIT' ? 92
    : signal === 'TRIM MORE' ? 90
    : signal === 'TRIM' ? 82
    : signal === 'ADD' ? 88
    : signal === 'ROLL' ? 78
    : signal === 'HOLD' ? Math.max(62, activeSetupScore)
    : 55;
  const reason = `${signal} because ${triggers.join('; ')}.`;
  const reasons = [
    strategyWhy('Position mode', `${position.label || position.symbol} | ${position.contracts} contract${position.contracts === 1 ? '' : 's'}`, signal, true),
    strategyWhy('Position P/L', `${moneyText(position.pnl)} / ${pctText(returnPct)} on ${moneyText(position.value)} value`, returnPct !== null && returnPct >= 0.40 ? 'Trim zone' : returnPct !== null && returnPct <= -0.35 ? 'Loss rule' : 'Manage', !(returnPct !== null && returnPct <= -0.50)),
    strategyWhy('VWAP control', vwapValue === null || slv === null ? 'VWAP or SLV unavailable' : `${moneyText(slv)} vs VWAP ${moneyText(vwapValue)}`, confirmsVwap ? 'Holding' : losesVwap ? 'Risk' : 'Watch', confirmsVwap),
    strategyWhy('Trigger stop', levels.stopSLV === null ? 'Stop unavailable' : `${moneyText(levels.stopSLV)} ${stopHit ? 'hit' : 'not hit'}`, stopHit || breaksTrigger ? 'Exit rule' : 'Protected', !(stopHit || breaksTrigger)),
    strategyWhy('Trim targets', `${moneyText(levels.trim1SLV)} / ${moneyText(levels.trim2SLV)} | option ${moneyText(levels.trim1Option)} / ${moneyText(levels.trim2Option)}`, trim2SlvHit || trim2OptionHit ? 'Trim more' : trim1SlvHit || trim1OptionHit ? 'Trim' : 'Waiting', trim1SlvHit || trim1OptionHit),
    strategyWhy('Theta / DTE', `${dte ?? '-'} DTE, theta drag ${pctText(thetaDrag)}`, thesisValid && (dte !== null && dte <= 1 || thetaDrag !== null && thetaDrag > 0.15) ? 'Roll watch' : 'Usable', !(dte !== null && dte <= 1 && !thesisValid)),
    strategyWhy('Spread', spreadPct === null ? 'Spread unavailable' : `${pctText(spreadPct)} spread`, spreadWide ? 'Exit risk' : 'Usable', !spreadWide),
    strategyWhy('Active setup', `${bullish ? 'Bullish' : 'Bearish'} setup score ${Math.round(activeSetupScore)}/100`, activeSetupScore >= 85 ? 'Add quality' : activeSetupScore >= 60 ? 'Hold quality' : 'Weak', activeSetupScore >= 60),
    strategyWhy('Data quality', ctx.dataQuality?.status || 'Unknown', dataBad ? 'Protect position' : 'Usable', !dataBad)
  ];
  return {
    active: true,
    mode: 'POSITION FIRST',
    signal,
    score: Math.round(clamp(score, 0, 100)),
    reason,
    requiredConfirmation: bullish
      ? `For a stronger hold/add, SLV must stay above VWAP and reclaim ${moneyText(levels.reclaimNeededSLV)}. Invalidation is ${moneyText(levels.stopSLV)}.`
      : `For a stronger hold/add, SLV must stay below VWAP and lose ${moneyText(levels.reclaimNeededSLV)}. Invalidation is ${moneyText(levels.stopSLV)}.`,
    direction,
    position,
    levels,
    activeSetupScore,
    triggers,
    reasons
  };
}

function primaryManagedPosition(ctx = {}) {
  const rows = (ctx.state?.tastytradePositions || [])
    .map(normalizePositionRecord)
    .filter(position => Math.abs(position.quantity || 0) > 0)
    .filter(position => String(position.underlying || position.symbol || '').toUpperCase().includes('SLV') || String(position.symbol || '').toUpperCase() === 'SLV')
    .sort((a, b) => Number(b.isOption) - Number(a.isOption) || positionSortValue(b) - positionSortValue(a));
  const selectedKey = compactPositionSymbol(ctx.input?.selectedPositionKey || ctx.input?.selectedPositionSymbol);
  const selected = selectedKey ? rows.find(row => positionKeyMatches(row, selectedKey)) : null;
  if (rows.length) return managedPositionFromBase(selected || rows[0], ctx, 'tastytrade');
  const tracked = ctx.input?.trackPosition === true
    || String(ctx.input?.trackPosition || '').toUpperCase() === 'TRUE'
    || ctx.market?.entryOverride !== null && ctx.market?.entryOverride !== undefined;
  if (!tracked || !ctx.selectedOption) return null;
  return managedPositionFromSelected(ctx.selectedOption, ctx);
}

function positionSortValue(position = {}) {
  const price = numberOrNull(position.mark ?? position.averagePrice ?? position.closePrice) ?? 0;
  const multiplier = numberOrNull(position.multiplier) ?? (position.isOption ? 100 : 1);
  const value = price * Math.abs(numberOrNull(position.quantity) ?? 0) * multiplier;
  return value || Math.abs(numberOrNull(position.quantity) ?? 0);
}

function positionKeyMatches(position = {}, key = '') {
  const normalizedKey = compactPositionSymbol(key);
  if (!normalizedKey) return false;
  return positionKeys(position).includes(normalizedKey);
}

function positionKeys(position = {}) {
  return [...new Set([
    position.symbol,
    position.streamerSymbol,
    position.occSymbol,
    position.displaySymbol,
    ...optionAliases(position)
  ].map(compactPositionSymbol).filter(Boolean))];
}

function managedPositionFromSelected(option = {}, ctx = {}) {
  const normalized = normalizeOptionRecord(option);
  const contracts = Math.max(1, numberOrNull(ctx.market?.contracts) ?? 1);
  const entryPrice = numberOrNull(ctx.market?.entryOverride) ?? numberOrNull(normalized.mid) ?? numberOrNull(normalized.ask) ?? 0;
  return managedPositionFromOption(normalized, {
    quantity: contracts,
    multiplier: 100,
    averagePrice: entryPrice,
    source: 'tracked'
  }, ctx);
}

function managedPositionFromBase(base = {}, ctx = {}, source = 'tastytrade') {
  if (!base.isOption) {
    const quote = live.symbols[base.symbol] || {};
    const liveFields = equityLiveFields(quote);
    const mark = numberOrNull(liveFields.mid ?? liveFields.last ?? base.mark ?? base.closePrice ?? base.averagePrice);
    const average = numberOrNull(base.averagePrice) ?? mark ?? 0;
    const absQuantity = Math.abs(base.quantity || 0);
    const value = mark !== null ? round2(mark * absQuantity) : null;
    const costBasis = round2(average * absQuantity);
    const pnl = mark !== null ? round2((mark - average) * base.quantity) : null;
    return {
      source,
      symbol: base.symbol,
      label: base.quantity >= 0 ? `Long ${base.symbol}` : `Short ${base.symbol}`,
      isOption: false,
      type: base.quantity >= 0 ? 'C' : 'P',
      quantity: base.quantity,
      contracts: absQuantity,
      multiplier: 1,
      entryPrice: average,
      currentMid: mark,
      value,
      costBasis,
      pnl,
      returnPct: safeDiv(pnl, costBasis),
      dte: null,
      strike: null,
      expiration: null,
      bid: liveFields.bid,
      ask: liveFields.ask,
      spreadPct: null
    };
  }
  const quote = optionLiveQuote(base);
  const liveFields = liveOptionFields(quote);
  const mark = numberOrNull(liveFields.mid ?? liveFields.last ?? base.mark ?? base.closePrice ?? base.averagePrice);
  const option = normalizeOptionRecord({ ...base, ...liveFields, bid: liveFields.bid ?? base.bid, ask: liveFields.ask ?? base.ask, mid: mark, source });
  return managedPositionFromOption(option, base, ctx);
}

function managedPositionFromOption(option = {}, base = {}, ctx = {}) {
  const quantity = numberOrNull(base.quantity) ?? numberOrNull(ctx.market?.contracts) ?? 1;
  const absQuantity = Math.abs(quantity);
  const multiplier = numberOrNull(base.multiplier) ?? 100;
  const currentMid = numberOrNull(option.mid) ?? numberOrNull(option.last) ?? numberOrNull(base.mark);
  const entryPrice = numberOrNull(base.averagePrice) ?? numberOrNull(ctx.market?.entryOverride) ?? numberOrNull(option.mid) ?? 0;
  const costBasis = round2(entryPrice * absQuantity * multiplier);
  const value = currentMid !== null ? round2(currentMid * absQuantity * multiplier) : null;
  const pnl = currentMid !== null ? round2((currentMid - entryPrice) * quantity * multiplier) : null;
  return {
    source: base.source || 'tastytrade',
    symbol: option.streamerSymbol || option.symbol || base.symbol,
    occSymbol: option.occSymbol || base.occSymbol,
    label: readableContractLabel(option),
    isOption: true,
    type: option.type,
    typeLabel: option.type === 'P' ? 'Put' : 'Call',
    strike: option.strike,
    expiration: option.expiration,
    dte: option.dte,
    quantity,
    contracts: absQuantity,
    multiplier,
    entryPrice,
    currentMid,
    value,
    costBasis,
    pnl,
    returnPct: safeDiv(pnl, costBasis),
    bid: option.bid,
    ask: option.ask,
    spreadPct: option.spreadPct,
    delta: option.delta,
    gamma: option.gamma,
    theta: option.theta,
    vega: option.vega,
    iv: option.iv,
    liquidityScore: option.liquidityScore,
    updatedAt: option.updatedAt || null
  };
}

function positionDirection(position = {}) {
  if (!position.isOption) return (position.quantity ?? 0) >= 0 ? 'bullish' : 'bearish';
  if ((position.quantity ?? 0) >= 0) return position.type === 'P' ? 'bearish' : 'bullish';
  return position.type === 'P' ? 'bullish' : 'bearish';
}

function positionManagementLevels(ctx = {}, position = {}, direction = 'bullish') {
  const levels = contractTargetLevels(position, ctx, direction);
  const current = numberOrNull(ctx.market?.slv?.price) ?? numberOrNull(position.strike) ?? 0;
  const atrValue = numberOrNull(ctx.atr?.value) ?? Math.max(0.5, current * 0.018);
  const vwapValue = numberOrNull(ctx.vwap?.value);
  const bull = numberOrNull(ctx.triggers?.bullTrigger);
  const bear = numberOrNull(ctx.triggers?.bearTrigger);
  const strike = numberOrNull(position.strike) ?? current;
  const runnerSLV = direction === 'bearish'
    ? round2(Math.min(strike - 3, (bear ?? current) - atrValue * 2))
    : round2(Math.max(strike + 3, (ctx.market?.slv?.priorClose ?? bull ?? current) + atrValue * 2));
  const entry = numberOrNull(position.entryPrice) ?? numberOrNull(position.currentMid) ?? 0;
  const exitBelowOption = round2(entry * ((numberOrNull(position.dte) ?? 99) <= 3 ? 0.65 : 0.50));
  return {
    stopSLV: levels.stopSLV,
    trim1SLV: levels.trim1SLV,
    trim2SLV: levels.trim2SLV,
    runnerSLV,
    exitBelowOption,
    reclaimNeededSLV: direction === 'bearish'
      ? round2(Math.min(vwapValue ?? bull ?? current, bear ?? current))
      : round2(Math.max(vwapValue ?? bear ?? current, bull ?? current)),
    trim1Option: round2(entry * 1.5),
    trim2Option: round2(entry * 2),
    runnerOption: round2(entry * 3)
  };
}

function hasTrackedPosition(ctx) {
  if (ctx.input?.trackPosition === true || String(ctx.input?.trackPosition || '').toUpperCase() === 'TRUE') return true;
  if (ctx.market?.entryOverride !== null && ctx.market?.entryOverride !== undefined) return true;
  return (ctx.state?.tastytradePositions || []).some(row => Math.abs(normalizePositionRecord(row).quantity || 0) > 0);
}

function confidenceFromPercent(percent, dataQuality) {
  if (dataQuality.status === 'BAD') return 'D';
  if (percent >= 85) return 'A';
  if (percent >= 70) return 'B';
  if (percent >= 50) return 'C';
  return 'D';
}

function calculateTradeScore(ctx) {
  const { market, triggers, vwap, openingRange, silverValidation, tracking, volume, volumeScore, trendScore, selectedOption, optionsLiquidityScore, tradePlan } = ctx;
  let score = 50;
  let entry = 50;
  let trend = Math.round(clamp(trendScore * 10, 0, 100));
  let volumePart = Math.round(clamp(volumeScore * 10, 0, 100));
  let greeks = Math.round(clamp(optionsLiquidityScore * 10, 0, 100));
  let silver = silverValidation.valid ? 65 : 35;
  let risk = 50;
  const slv = market.slv.price;
  if (slv !== null && slv > triggers.bullTrigger) { score += 10; entry += 22; }
  if (slv !== null && vwap.value !== null && slv > vwap.value) { score += 5; entry += 12; }
  if (slv !== null && openingRange.high !== null && slv > openingRange.high) { score += 5; entry += 10; }
  if (slv !== null && slv < triggers.bearTrigger) { score -= 10; entry -= 20; }
  if (slv !== null && vwap.value !== null && slv < vwap.value) { score -= 5; entry -= 12; }
  if (trendScore >= 8) score += 10;
  else if (trendScore >= 6) score += 5;
  else if (trendScore <= 3) score -= 10;
  if (volumeScore >= 8) score += 10;
  else if (volumeScore >= 6) score += 5;
  else if (volumeScore <= 3) score -= 10;
  if (optionsLiquidityScore >= 8) score += 10;
  const delta = Math.abs(numberOrNull(selectedOption?.delta) ?? 0);
  if (delta >= 0.35 && delta <= 0.65) { score += 5; greeks += 8; }
  if ((numberOrNull(selectedOption?.spreadPct) ?? 99) < 0.10) { score += 5; greeks += 8; }
  if ((numberOrNull(selectedOption?.spreadPct) ?? 0) > 0.20) { score -= 10; greeks -= 22; }
  if (!hasUsableGreeks(selectedOption)) { score -= 5; greeks -= 12; }
  if (silverValidation.valid && (market.silver.changePct ?? 0) >= 0) { score += 10; silver += 18; }
  if (silverValidation.valid && tracking === 'SLV lagging') { score += 5; silver += 10; }
  if (!silverValidation.valid) score -= 10;
  if (silverValidation.valid && tracking === 'SLV leading' && (market.silver.changePct ?? 0) <= 0.002) { score -= 5; silver -= 12; }
  const rr = numberOrNull(tradePlan?.rr);
  if (rr !== null && rr >= 3) { score += 10; risk = 90; }
  else if (rr !== null && rr >= 2) { score += 5; risk = 75; }
  else if (rr !== null && rr < 1.2) { score -= 10; risk = 35; }
  const value = Math.round(clamp(score, 0, 100));
  return {
    value,
    breakdown: {
      entry: Math.round(clamp(entry, 0, 100)),
      trend,
      volume: volumePart,
      greeks: Math.round(clamp(greeks, 0, 100)),
      silver: Math.round(clamp(silver, 0, 100)),
      risk: Math.round(clamp(risk, 0, 100))
    },
    interpretation: value >= 85 ? 'High-quality setup' : value >= 70 ? 'Valid setup' : value >= 60 ? 'Wait/watch' : 'No trade'
  };
}

function calculateTradePlan({ market, selectedOption, triggers, vwap, atr, optionProjection, targetOdds }) {
  const entryMid = market.entryOverride ?? selectedOption?.mid ?? 0;
  const stopSLV = round2(Math.max((vwap.value ?? triggers.bearTrigger) - 0.15, triggers.bearTrigger));
  const strike = numberOrNull(selectedOption?.strike) ?? market.slv.price ?? 0;
  const atrValue = atr.value ?? Math.max(0.5, (market.slv.price ?? 50) * 0.018);
  const trim1SLV = round2(Math.max(strike + 1, triggers.bullTrigger + atrValue * 0.75));
  const trim2SLV = round2(Math.max(strike + 2, triggers.bullTrigger + atrValue * 1.25));
  const runnerSLV = round2(Math.max(strike + 3, (market.slv.priorClose ?? triggers.bullTrigger) + atrValue * 2));
  const stopValue = estimateOptionAtTarget(selectedOption, stopSLV, market.slv.price, 0);
  const trim2Value = estimateOptionAtTarget(selectedOption, trim2SLV, market.slv.price, 0);
  const riskPerContract = Math.max(0, entryMid - stopValue);
  const risk = Math.max(entryMid * 100 * market.contracts, riskPerContract * 100 * market.contracts);
  const reward = Math.max(0, trim2Value - entryMid) * 100 * market.contracts;
  return {
    selectedContract: selectedOption?.displaySymbol || selectedOption?.streamerSymbol || 'No contract selected',
    entryZone: selectedOption?.spreadPct <= 0.12 ? `${moneyText(entryMid)} to ${moneyText(selectedOption.ask ?? entryMid)}` : `${moneyText(entryMid)} mid, wait for tighter spread`,
    suggestedEntrySLV: `${moneyText(triggers.bullTrigger)} to ${moneyText(triggers.bullTrigger + 0.20)}`,
    stopSLV,
    trim1SLV,
    trim2SLV,
    runnerSLV,
    risk,
    reward,
    rr: risk ? round2(reward / risk) : null,
    odds: targetOdds?.find(row => row.target === trim2SLV)?.probability ?? null,
    maxLoss: round2(entryMid * 100 * market.contracts),
    pnlTrim1: projectedPnlAt(optionProjection, trim1SLV),
    pnlTrim2: projectedPnlAt(optionProjection, trim2SLV),
    pnlRunner: projectedPnlAt(optionProjection, runnerSLV)
  };
}

function calculateTradeMap({ market, triggers, vwap, tradePlan }) {
  const rows = [
    { label: 'Stop', value: tradePlan?.stopSLV, type: 'danger' },
    { label: 'Bear Trigger', value: triggers?.bearTrigger, type: 'danger' },
    { label: 'VWAP', value: vwap?.value, type: 'neutral' },
    { label: 'Current SLV', value: market?.slv?.price, type: 'current' },
    { label: 'Bull Trigger', value: triggers?.bullTrigger, type: 'entry' },
    { label: 'Trim 1', value: tradePlan?.trim1SLV, type: 'target' },
    { label: 'Trim 2', value: tradePlan?.trim2SLV, type: 'target' },
    { label: 'Runner', value: tradePlan?.runnerSLV, type: 'runner' }
  ].filter(row => Number.isFinite(numberOrNull(row.value)));
  const values = rows.map(row => numberOrNull(row.value)).filter(Number.isFinite);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  return rows
    .map(row => ({ ...row, value: round2(row.value), positionPct: min !== null && max !== null ? round2(((row.value - min) / Math.max(0.01, max - min)) * 100) : null }))
    .sort((a, b) => a.value - b.value);
}

function calculateMissionControl({ market, selectedOption, optionProjection, targetOdds, tradePlan, signal, tradeScore, positionManagement, contractRecommendation }) {
  if (positionManagement?.active) {
    const p = positionManagement.position || {};
    const levels = positionManagement.levels || {};
    return {
      mode: 'POSITION FIRST',
      selected: p.label || p.symbol || 'Open SLV position',
      positionSize: p.contracts ?? market.contracts,
      entryPrice: p.entryPrice ?? null,
      currentMid: p.currentMid ?? null,
      positionValue: p.value ?? null,
      costBasis: p.costBasis ?? null,
      livePnl: p.pnl ?? null,
      liveReturnPct: p.returnPct ?? null,
      delta: p.delta ?? null,
      gamma: p.gamma ?? null,
      theta: p.theta ?? null,
      vega: p.vega ?? null,
      iv: p.iv ?? null,
      dte: p.dte ?? null,
      probabilityItm: probabilityForTarget(targetOdds, p.strike),
      probabilityTrim1: probabilityForTarget(targetOdds, levels.trim1SLV),
      probabilityTrim2: probabilityForTarget(targetOdds, levels.trim2SLV),
      probabilityRunner: probabilityForTarget(targetOdds, levels.runnerSLV),
      recommendation: positionManagement.signal,
      reason: positionManagement.reason,
      levels
    };
  }
  const currentMid = numberOrNull(selectedOption?.mid) ?? numberOrNull(selectedOption?.last);
  const trim1Prob = probabilityForTarget(targetOdds, tradePlan?.trim1SLV);
  const trim2Prob = probabilityForTarget(targetOdds, tradePlan?.trim2SLV);
  const runnerProb = probabilityForTarget(targetOdds, tradePlan?.runnerSLV);
  const probabilityItm = probabilityForTarget(targetOdds, selectedOption?.strike);
  let recommendation = contractRecommendation?.finalDecision || 'WAIT';
  if (recommendation === 'BUY') recommendation = signal.action?.startsWith('ENTER PUT') ? 'ENTER PUT' : 'ENTER CALL';
  return {
    mode: 'PLANNING',
    selected: selectedOption?.displaySymbol || selectedOption?.streamerSymbol || 'No contract selected',
    currentMid,
    positionSize: market.contracts,
    entryPrice: market.entryOverride ?? selectedOption?.mid ?? null,
    positionValue: optionProjection.currentValue,
    costBasis: optionProjection.maxRisk,
    livePnl: optionProjection.pnl,
    liveReturnPct: optionProjection.returnPct,
    delta: numberOrNull(selectedOption?.delta),
    gamma: numberOrNull(selectedOption?.gamma),
    theta: numberOrNull(selectedOption?.theta),
    vega: numberOrNull(selectedOption?.vega),
    iv: numberOrNull(selectedOption?.iv),
    dte: selectedOption?.dte ?? null,
    probabilityItm,
    probabilityTrim1: trim1Prob,
    probabilityTrim2: trim2Prob,
    probabilityRunner: runnerProb,
    recommendation,
    reason: `${recommendation}: ${contractRecommendation?.reason || signal.reason} Trade score ${tradeScore.value}/100.`,
    levels: {
      stopSLV: tradePlan?.stopSLV ?? null,
      reclaimNeededSLV: signal.action?.startsWith('ENTER PUT')
        ? tradePlan?.stopSLV
        : Math.max(numberOrNull(tradePlan?.stopSLV) ?? 0, numberOrNull(market.slv?.price) ?? 0),
      trim1SLV: tradePlan?.trim1SLV ?? null,
      trim2SLV: tradePlan?.trim2SLV ?? null,
      runnerSLV: tradePlan?.runnerSLV ?? null,
      exitBelowOption: null,
      trim1Option: optionProjection.firstTrimPremium,
      trim2Option: optionProjection.secondTrimPremium
    }
  };
}

function calculateContractRecommendation(ctx) {
  const chain = enrichOptionChainWithLive(ctx.state?.optionChain || emptyOptionChain(), ctx.market.slv.price, ctx.input);
  const setup = contractSetupForRecommendation(ctx.bestSetup, ctx.strategyScores);
  const direction = contractDirectionForSetup(setup, ctx.strategyScores);
  const wantedType = direction === 'bearish' ? 'P' : 'C';
  const chainAverageIv = average(
    (chain.options || [])
      .map(option => normalizeIv(option.iv))
      .filter(Number.isFinite)
  );
  const current = numberOrNull(ctx.market.slv.price);
  const atrValue = numberOrNull(ctx.atr?.value) ?? (current ? current * 0.018 : 1);
  const maxStrikeDistance = Math.max(4, atrValue * 5);
  const candidates = (chain.options || [])
    .filter(option => option.type === wantedType)
    .filter(option => option.expiration && Number.isFinite(numberOrNull(option.strike)))
    .filter(option => option.dte !== null && option.dte >= 0 && option.dte <= 30)
    .filter(option => current === null || Math.abs(option.strike - current) <= maxStrikeDistance)
    .map(option => scoreContractCandidate(option, { ...ctx, setup, direction, chainAverageIv }))
    .sort((a, b) => b.contractScore - a.contractScore || contractDtePreference(b.dte) - contractDtePreference(a.dte) || b.liquidityScore - a.liquidityScore);

  const bestContracts = candidates
    .filter(candidate => candidate.meetsMinimumStandards && candidate.contractScore >= 60)
    .slice(0, 10)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const rejectedContracts = candidates
    .filter(candidate => !candidate.meetsMinimumStandards)
    .slice(0, 20)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const comparison = [...groupBestContractByExpiration(candidates).values()]
    .sort((a, b) => (a.dte ?? 999) - (b.dte ?? 999))
    .slice(0, 12);
  const recommended = bestContracts[0] || candidates[0] || null;
  const entryTiming = calculateEntryTimingScore(ctx, recommended, setup, direction);
  const finalDecision = finalContractDecision(recommended, entryTiming, setup, ctx);
  const reason = contractRecommendationReason(recommended, entryTiming, finalDecision, setup, ctx);

  return {
    setupId: setup?.id || null,
    setupName: setup?.name || 'No setup',
    direction,
    type: wantedType,
    recommended,
    bestContracts,
    rejectedContracts,
    comparison,
    contractQuality: {
      score: recommended?.contractScore ?? 0,
      label: recommended?.contractDecision || 'AVOID'
    },
    entryTiming,
    finalDecision,
    reason,
    entryCondition: recommended?.entryCondition || setup?.requiredConfirmation || 'Wait for setup confirmation.',
    avoidCondition: recommended?.avoidCondition || 'Avoid if data quality is bad or spread is too wide.',
    trim1: recommended?.trim1Premium ?? null,
    trim2: recommended?.trim2Premium ?? null,
    stop: recommended?.stopPremium ?? null,
    expectedMoveNeeded: recommended?.expectedMoveNeeded ?? null,
    sourceStatus: chain.status || 'Option chain not loaded',
    totalCandidates: candidates.length,
    tradableCandidates: bestContracts.length,
    rejectedCandidates: rejectedContracts.length
  };
}

function contractSetupForRecommendation(bestSetup = {}, strategyScores = {}) {
  if (bestSetup?.id === 'positionManagement' && bestSetup.secondarySetup) return bestSetup.secondarySetup;
  if (bestSetup?.id === 'noTrade' && bestSetup.secondarySetup) return bestSetup.secondarySetup;
  if (bestSetup?.id && bestSetup.id !== 'positionManagement') return bestSetup;
  const directional = [
    strategyScores.bullishCallMomentum,
    strategyScores.vwapBounce,
    strategyScores.bearishPutSpread,
    strategyScores.bearishBreakdown
  ].filter(Boolean).sort((a, b) => b.score - a.score);
  return directional[0] || bestSetup || {};
}

function contractDirectionForSetup(setup = {}, strategyScores = {}) {
  if (['bearishPutSpread', 'bearishBreakdown'].includes(setup.id)) return 'bearish';
  if (['bullishCallMomentum', 'vwapBounce'].includes(setup.id)) return 'bullish';
  const bullish = Math.max(strategyScores.bullishCallMomentum?.score ?? 0, strategyScores.vwapBounce?.score ?? 0);
  const bearish = Math.max(strategyScores.bearishPutSpread?.score ?? 0, strategyScores.bearishBreakdown?.score ?? 0);
  return bearish > bullish ? 'bearish' : 'bullish';
}

function scoreContractCandidate(option = {}, ctx = {}) {
  const current = numberOrNull(ctx.market?.slv?.price);
  const atrValue = numberOrNull(ctx.atr?.value) ?? (current ? current * 0.018 : 1);
  const normalized = normalizeOptionRecord(option);
  const levels = contractTargetLevels(normalized, ctx, ctx.direction);
  const bid = numberOrNull(normalized.bid);
  const ask = numberOrNull(normalized.ask);
  const mid = numberOrNull(normalized.mid) ?? (bid !== null && ask !== null ? round2((bid + ask) / 2) : null);
  const spreadPct = numberOrNull(normalized.spreadPct);
  const volume = numberOrNull(normalized.volume) ?? 0;
  const openInterest = numberOrNull(normalized.openInterest) ?? 0;
  const deltaAbs = Math.abs(numberOrNull(normalized.delta) ?? 0);
  const gamma = Math.abs(numberOrNull(normalized.gamma) ?? 0);
  const theta = numberOrNull(normalized.theta);
  const iv = normalizeIv(normalized.iv);
  const dte = numberOrNull(normalized.dte);
  const trim1Probability = probabilityTouchForContractTarget(ctx, normalized, levels.trim1SLV, ctx.chainAverageIv);
  const trim2Probability = probabilityTouchForContractTarget(ctx, normalized, levels.trim2SLV, ctx.chainAverageIv);
  const stopValue = estimateOptionAtTarget(normalized, levels.stopSLV, current, 0);
  const trim2Value = estimateOptionAtTarget(normalized, levels.trim2SLV, current, 0);
  const entry = mid ?? ask ?? bid ?? 0;
  const riskPerContract = Math.max(0.01, entry - stopValue, entry * 0.35);
  const rewardPerContract = Math.max(0, trim2Value - entry);
  const rr = rewardPerContract / riskPerContract;
  const thetaDrag = mid ? (theta !== null ? Math.abs(theta) / mid : null) : null;
  const expectedMove = contractExpectedMove(ctx.market, normalized, ctx.atr, ctx.chainAverageIv);
  const strikeDistance = current !== null ? Math.abs(normalized.strike - current) : null;
  const setupMoneyness = current !== null
    ? normalized.type === 'P' ? current - normalized.strike : normalized.strike - current
    : null;
  const breakeven = normalized.type === 'P' ? normalized.strike - entry : normalized.strike + entry;
  const breakevenDistance = current !== null ? Math.abs(breakeven - current) : null;
  const rejectionReasons = contractRejectionReasons({
    option: normalized,
    bid,
    ask,
    mid,
    spreadPct,
    volume,
    openInterest,
    deltaAbs,
    dte,
    strikeDistance,
    expectedMove,
    setupMoneyness,
    direction: ctx.direction
  });

  let score = 50;
  if (spreadPct !== null && spreadPct < 0.08) score += 10;
  else if (spreadPct !== null && spreadPct <= 0.12) score += 6;
  else if (spreadPct !== null && spreadPct <= 0.20) score -= 8;
  else score -= 15;
  if (volume > 500) score += 5;
  if (openInterest > 1000) score += 5;

  if (deltaAbs >= 0.35 && deltaAbs <= 0.65) score += 10;
  else if (numberOrNull(normalized.delta) === null) score -= 5;
  if (gamma >= 0.04 && gamma <= 0.25) score += 5;
  if (!hasUsableGreeks(normalized)) score -= 5;
  if (thetaDrag !== null && thetaDrag > 0.15) score -= 10;
  if (iv !== null && ctx.chainAverageIv !== null && iv > ctx.chainAverageIv * 1.35) score -= 5;

  if (dte !== null && dte >= 4 && dte <= 10) score += 10;
  else if (dte !== null && dte >= 2 && dte <= 3 && (ctx.setup?.score ?? 0) >= 80) score += 5;
  if (dte !== null && dte <= 1) score -= 10;
  if (dte !== null && dte > 21) score -= 5;

  if (setupMoneyness !== null && expectedMove !== null && setupMoneyness >= -0.75 && setupMoneyness <= expectedMove + 0.50) score += 10;
  else if (setupMoneyness !== null && setupMoneyness < -1.25) score -= 12;
  else if (setupMoneyness !== null && expectedMove !== null && setupMoneyness > expectedMove * 1.4) score -= 10;
  if (strikeDistance !== null && expectedMove !== null && strikeDistance > expectedMove * 1.8) score -= 8;
  if (breakevenDistance !== null && breakevenDistance > Math.max(0.75, atrValue * Math.sqrt(Math.max(1, dte ?? 1)) * 1.35)) score -= 5;

  if (contractTypeMatchesSetup(normalized, ctx.direction)) score += 15;
  else score -= 15;
  if (trim1Probability !== null && trim1Probability > 0.60) score += 10;
  if (trim2Probability !== null && trim2Probability > 0.35) score += 5;
  if (trim1Probability !== null && trim1Probability < 0.35) score -= 10;

  if (rr >= 3) score += 10;
  else if (rr >= 2) score += 5;
  else if (rr < 1.2) score -= 10;

  const contractScore = Math.round(clamp(score, 0, 100));
  const riskScore = calculateContractRiskScore({ rr, dte, thetaDrag, spreadPct });
  const contractDecision = contractDecisionFromScore(contractScore);
  return {
    ...normalized,
    label: readableContractLabel(normalized),
    typeLabel: normalized.type === 'P' ? 'Put' : 'Call',
    bid,
    ask,
    mid,
    spreadPct,
    volume,
    openInterest,
    iv,
    delta: numberOrNull(normalized.delta),
    gamma: numberOrNull(normalized.gamma),
    theta,
    vega: numberOrNull(normalized.vega),
    liquidityScore: calculateOptionsLiquidityScore(normalized),
    riskScore,
    rr: round2(rr),
    contractScore,
    contractDecision,
    trim1SLV: levels.trim1SLV,
    trim2SLV: levels.trim2SLV,
    stopSLV: levels.stopSLV,
    trim1Premium: estimateOptionAtTarget(normalized, levels.trim1SLV, current, 0),
    trim2Premium: estimateOptionAtTarget(normalized, levels.trim2SLV, current, 0),
    stopPremium: round2(stopValue),
    expectedMove,
    expectedMoveNeeded: levels.expectedMoveNeeded,
    entryCondition: levels.entryCondition,
    avoidCondition: levels.avoidCondition,
    trim1Probability,
    trim2Probability,
    meetsMinimumStandards: rejectionReasons.length === 0,
    rejectionReasons,
    whyRejected: rejectionReasons.join(', ')
  };
}

function contractRejectionReasons({ option = {}, bid, ask, mid, spreadPct, volume, openInterest, deltaAbs, dte, strikeDistance, expectedMove, setupMoneyness, direction }) {
  const reasons = [];
  if (bid === null || bid <= 0) reasons.push('Zero/missing bid');
  if (ask === null || ask <= 0) reasons.push('Zero/missing ask');
  if (mid === null || mid <= 0) reasons.push('Missing mid');
  if (spreadPct !== null && spreadPct > 0.25) reasons.push('Spread over 25%');
  else if (spreadPct !== null && spreadPct > 0.15) reasons.push('Spread over 15%');
  if (spreadPct === null) reasons.push('Missing spread');
  if (!hasUsableGreeks(option)) reasons.push('Missing Greeks');
  if (dte === null) reasons.push('Missing DTE');
  else if (dte < 2) reasons.push('Too little DTE');
  else if (dte > 14) reasons.push('Too much DTE');
  const goodDelta = direction === 'bearish'
    ? option.type === 'P' && deltaAbs >= 0.30 && deltaAbs <= 0.70
    : option.type === 'C' && deltaAbs >= 0.30 && deltaAbs <= 0.70;
  if (!goodDelta) reasons.push('Delta outside 0.30-0.70');
  if ((volume ?? 0) <= 0 && (openInterest ?? 0) <= 0) reasons.push('Illiquid');
  if (strikeDistance !== null && expectedMove !== null && strikeDistance > Math.max(2.5, expectedMove * 1.8)) reasons.push('Too far from SLV');
  if (setupMoneyness !== null && expectedMove !== null && setupMoneyness > expectedMove * 1.4) reasons.push('Too far OTM');
  return [...new Set(reasons)];
}

function contractTargetLevels(option = {}, ctx = {}, direction = 'bullish') {
  const current = numberOrNull(ctx.market?.slv?.price) ?? numberOrNull(option.strike) ?? 0;
  const atrValue = numberOrNull(ctx.atr?.value) ?? Math.max(0.5, current * 0.018);
  const vwapValue = numberOrNull(ctx.vwap?.value);
  const bull = numberOrNull(ctx.triggers?.bullTrigger) ?? current;
  const bear = numberOrNull(ctx.triggers?.bearTrigger) ?? current;
  const strike = numberOrNull(option.strike) ?? current;
  if (direction === 'bearish') {
    const stopSLV = round2(Math.min((vwapValue ?? bull) + 0.15, bull));
    const trim1SLV = round2(Math.min(strike - 1, bear - atrValue * 0.75));
    const trim2SLV = round2(Math.min(strike - 2, bear - atrValue * 1.25));
    const expectedMoveNeeded = round2(Math.max(0, current - bear));
    return {
      stopSLV,
      trim1SLV,
      trim2SLV,
      expectedMoveNeeded,
      entryCondition: `Only enter bearish if SLV loses ${moneyText(bear)} and stays below VWAP with volume.`,
      avoidCondition: `Avoid bearish entry above VWAP or if SLV reclaims ${moneyText(stopSLV)}.`
    };
  }
  const stopSLV = round2(Math.max((vwapValue ?? bear) - 0.15, bear));
  const trim1SLV = round2(Math.max(strike + 1, bull + atrValue * 0.75));
  const trim2SLV = round2(Math.max(strike + 2, bull + atrValue * 1.25));
  const expectedMoveNeeded = round2(Math.max(0, bull - current));
  return {
    stopSLV,
    trim1SLV,
    trim2SLV,
    expectedMoveNeeded,
    entryCondition: `Only buy if SLV reclaims ${moneyText(bull)} and holds above VWAP with volume.`,
    avoidCondition: `Do not buy below VWAP or under ${moneyText(stopSLV)}.`
  };
}

function calculateEntryTimingScore(ctx, recommended, setup = {}, direction = 'bullish') {
  let score = 50;
  const slv = numberOrNull(ctx.market?.slv?.price);
  const bull = numberOrNull(ctx.triggers?.bullTrigger);
  const bear = numberOrNull(ctx.triggers?.bearTrigger);
  const vwap = numberOrNull(ctx.vwap?.value);
  const orHigh = numberOrNull(ctx.openingRange?.high);
  const orLow = numberOrNull(ctx.openingRange?.low);
  const volumeScore = numberOrNull(ctx.volumeScore) ?? 0;
  const spreadPct = numberOrNull(recommended?.spreadPct);
  const bullish = direction !== 'bearish';
  const insideChop = slv !== null && bear !== null && bull !== null && slv >= bear && slv <= bull;

  if (bullish) {
    if (slv !== null && bull !== null && slv > bull) score += 15;
    if (slv !== null && vwap !== null && slv > vwap) score += 10;
    if (slv !== null && orHigh !== null && slv > orHigh) score += 8;
    if (slv !== null && vwap !== null && slv < vwap) score -= 15;
  } else {
    if (slv !== null && bear !== null && slv < bear) score += 15;
    if (slv !== null && vwap !== null && slv < vwap) score += 10;
    if (slv !== null && orLow !== null && slv < orLow) score += 8;
    if (slv !== null && vwap !== null && slv > vwap) score -= 15;
  }

  if (insideChop) score -= 10;
  if (volumeScore >= 7) score += 10;
  else if (volumeScore <= 3) score -= 10;

  const silverChange = numberOrNull(ctx.market?.silver?.changePct);
  if (!ctx.silverValidation?.valid) score -= 10;
  else if (silverChange !== null && (bullish ? silverChange >= 0 : silverChange <= 0)) score += 8;
  else if (silverChange !== null) score -= 10;

  if (spreadPct !== null && spreadPct > 0.20) score -= 10;

  const value = Math.round(clamp(score, 0, 100));
  return {
    score: value,
    label: value >= 75 ? 'ENTER' : value >= 60 ? 'WAIT' : 'AVOID',
    reason: entryTimingReason(value, ctx, direction)
  };
}

function entryTimingReason(score, ctx, direction) {
  const slv = numberOrNull(ctx.market?.slv?.price);
  const trigger = direction === 'bearish' ? numberOrNull(ctx.triggers?.bearTrigger) : numberOrNull(ctx.triggers?.bullTrigger);
  const vwap = numberOrNull(ctx.vwap?.value);
  if (score >= 75) return `Entry timing is confirmed against ${moneyText(trigger)} and VWAP.`;
  if (direction === 'bearish') return `Wait for SLV below ${moneyText(trigger)} and under VWAP; current SLV is ${moneyText(slv)}.`;
  if (vwap !== null && slv !== null && slv < vwap) return `Wait: SLV is below VWAP and has not reclaimed ${moneyText(trigger)}.`;
  return `Wait for SLV to confirm ${moneyText(trigger)} with volume.`;
}

function finalContractDecision(recommended, entryTiming, setup = {}, ctx = {}) {
  if (ctx.bestSetup?.id === 'positionManagement' && ['TRIM', 'EXIT'].includes(ctx.signal?.action)) return ctx.signal.action;
  if (ctx.dataQuality?.status === 'BAD') return 'AVOID';
  if (!recommended) return 'AVOID';
  if (recommended.meetsMinimumStandards === false) return 'AVOID';
  if ((recommended.contractScore ?? 0) < 60 || (entryTiming.score ?? 0) < 60) return 'AVOID';
  if ((recommended.contractScore ?? 0) >= 75 && (entryTiming.score ?? 0) >= 75) return 'BUY';
  return 'WAIT';
}

function contractRecommendationReason(recommended, entryTiming, finalDecision, setup = {}, ctx = {}) {
  if (!recommended) return 'No usable option-chain candidate was found for the active setup.';
  if (ctx.dataQuality?.status === 'BAD') return `Avoid fresh entry: ${ctx.dataQuality.reason}`;
  if (finalDecision === 'BUY') return `${recommended.label} is the strongest contract and entry timing is confirmed.`;
  if (finalDecision === 'TRIM' || finalDecision === 'EXIT') return `${finalDecision} is coming from existing-position management; the best new-contract read is ${recommended.label}.`;
  if ((recommended.contractScore ?? 0) >= 75 && (entryTiming.score ?? 0) < 75) {
    return `${recommended.label} is acceptable, but entry timing is only ${entryTiming.score}/100. ${entryTiming.reason}`;
  }
  if ((recommended.contractScore ?? 0) < 60) return `${recommended.label} does not score well enough for a fresh ${setup?.name || 'setup'} trade.`;
  return `${recommended.label} is a planning candidate, but conditions are not strong enough for entry.`;
}

function groupBestContractByExpiration(candidates = []) {
  const map = new Map();
  for (const candidate of candidates) {
    const existing = map.get(candidate.expiration);
    if (!existing || candidate.contractScore > existing.contractScore) map.set(candidate.expiration, candidate);
  }
  return map;
}

function contractDecisionFromScore(score) {
  const value = numberOrNull(score) ?? 0;
  if (value >= 85) return 'BEST';
  if (value >= 75) return 'GOOD';
  if (value >= 60) return 'WAIT';
  return 'AVOID';
}

function contractTypeMatchesSetup(option = {}, direction = 'bullish') {
  return direction === 'bearish' ? option.type === 'P' : option.type === 'C';
}

function calculateContractRiskScore({ rr, dte, thetaDrag, spreadPct }) {
  let score = 50;
  if (rr >= 3) score += 25;
  else if (rr >= 2) score += 15;
  else if (rr < 1.2) score -= 25;
  if (dte >= 4 && dte <= 10) score += 10;
  else if (dte <= 1) score -= 15;
  if (thetaDrag !== null && thetaDrag < 0.08) score += 10;
  else if (thetaDrag !== null && thetaDrag > 0.15) score -= 15;
  if (spreadPct !== null && spreadPct < 0.12) score += 10;
  else if (spreadPct !== null && spreadPct > 0.20) score -= 15;
  return Math.round(clamp(score, 0, 100));
}

function contractExpectedMove(market = {}, option = {}, atr = {}, chainAverageIv = null) {
  const current = numberOrNull(market.slv.price);
  if (current === null) return null;
  const dte = Math.max(1, numberOrNull(option.dte) ?? 5);
  const iv = normalizeIv(option.iv) ?? chainAverageIv ?? 0.45;
  const atrMove = (numberOrNull(atr.value) ?? current * 0.018) * Math.sqrt(dte);
  const ivMove = current * iv * Math.sqrt(dte / 365);
  return round2(Math.max(atrMove, ivMove));
}

function probabilityTouchForContractTarget(ctx = {}, option = {}, target = null, chainAverageIv = null) {
  const current = numberOrNull(ctx.market?.slv?.price);
  const targetValue = numberOrNull(target);
  if (current === null || targetValue === null) return null;
  const dte = Math.max(1, numberOrNull(option.dte) ?? 5);
  const atrMove = Math.max(0.01, (numberOrNull(ctx.atr?.value) ?? current * 0.018) * Math.sqrt(dte));
  const iv = normalizeIv(option.iv) ?? chainAverageIv ?? 0.45;
  const ivMove = Math.max(0.01, current * iv * Math.sqrt(dte / 365));
  const distance = Math.abs(targetValue - current);
  const atrProbability = clamp(2 * (1 - normalCdf(distance / atrMove)), 0, 1);
  const ivProbability = clamp(2 * (1 - normalCdf(distance / ivMove)), 0, 1);
  return round4(0.55 * ivProbability + 0.45 * atrProbability);
}

function contractDtePreference(dte) {
  const value = numberOrNull(dte);
  if (value === null) return 0;
  if (value >= 4 && value <= 10) return 4;
  if (value >= 8 && value <= 14) return 3;
  if (value >= 2 && value <= 3) return 2;
  if (value >= 11 && value <= 21) return 1;
  return 0;
}

function readableContractLabel(option = {}) {
  const type = option.type === 'P' ? 'Put' : 'Call';
  const strike = numberOrNull(option.strike);
  const strikeText = strike === null ? '-' : moneyText(strike);
  return `SLV ${formatExpirationShort(option.expiration)} ${strikeText} ${type}`;
}

function formatExpirationShort(value) {
  const date = parseExpiration(value);
  if (!date) return String(value || '-');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function probabilityForTarget(targetOdds = [], target) {
  const t = numberOrNull(target);
  if (t === null) return null;
  const exact = targetOdds.find(row => Math.abs(row.target - t) < 0.01);
  if (exact) return exact.probability;
  const nearest = targetOdds.reduce((best, row) => !best || Math.abs(row.target - t) < Math.abs(best.target - t) ? row : best, null);
  return nearest?.probability ?? null;
}

function generateAITradeBrainText(ctx) {
  const { market, silverValidation, tracking, triggers, vwap, volume, selectedOption, optionsLiquidityScore, signal, tradeScore, bestSetup, contractRecommendation, positionManagement } = ctx;
  if (positionManagement?.active) {
    const p = positionManagement.position || {};
    const levels = positionManagement.levels || {};
    const text = [
      `Position mode is active on ${p.label || p.symbol || 'the SLV position'}.`,
      `Current signal is ${positionManagement.signal}: ${positionManagement.reason}`,
      `P/L is ${moneyText(p.pnl)} (${pctText(p.returnPct)}) with ${p.dte ?? '-'} DTE.`,
      `Confirm by reclaiming/holding ${moneyText(levels.reclaimNeededSLV)}; invalidation is ${moneyText(levels.stopSLV)} or option mid below ${moneyText(levels.exitBelowOption)}.`,
      `Trim levels are ${moneyText(levels.trim1SLV)} and ${moneyText(levels.trim2SLV)}; runner is ${moneyText(levels.runnerSLV)}.`
    ].join(' ');
    return text.split(/\s+/).slice(0, 100).join(' ');
  }
  const parts = [];
  const slv = market.slv.price;
  const relative = slv !== null && slv > triggers.bullTrigger ? 'above the bull trigger'
    : slv !== null && slv < triggers.bearTrigger ? 'below the bear trigger'
    : 'inside the neutral zone';
  parts.push(`Best setup is ${bestSetup?.name || 'No Edge'}.`);
  parts.push(`SLV is ${relative}${vwap.value !== null ? ` and ${slv > vwap.value ? 'above' : 'below'} VWAP` : ''}.`);
  parts.push(`Volume is ${pctText(volume.timeAdjustedPace)} of expected pace, so confirmation is ${volume.confirmation.toLowerCase()}.`);
  parts.push(silverValidation.valid ? `Silver is valid with tracking: ${tracking}.` : 'Silver feed is invalid, so SLV-only logic is active.');
  parts.push(`The selected ${selectedOption?.displaySymbol || selectedOption?.streamerSymbol || 'contract'} has liquidity score ${optionsLiquidityScore}/10.`);
  if (contractRecommendation?.recommended) {
    parts.push(`Best contract is ${contractRecommendation.recommended.label}; contract quality ${contractRecommendation.contractQuality.score}/100 and entry timing ${contractRecommendation.entryTiming.score}/100.`);
    parts.push(`Decision: ${contractRecommendation.finalDecision}. Entry improves above ${moneyText(triggers.bullTrigger)} for calls or below ${moneyText(triggers.bearTrigger)} for bearish setups.`);
  }
  parts.push(`Current stance: ${signal.action}; invalidation level is ${bestSetup?.invalidationLevel ? moneyText(bestSetup.invalidationLevel) : 'not set'}. Trade score ${tradeScore.value}/100 (${tradeScore.interpretation}).`);
  return parts.join(' ').split(/\s+/).slice(0, 100).join(' ');
}

function buildBacktestReportPlaceholder(state = {}) {
  const snapshots = state.signalSnapshots || [];
  return {
    snapshotCount: snapshots.length,
    reports: [
      { label: 'Win rate by Trade Score bucket', status: 'Collecting signal snapshots' },
      { label: 'Win rate by Active Setup bucket', status: 'Collecting signal snapshots' },
      { label: 'Best DTE', status: 'Pending outcome fields' },
      { label: 'Best delta range', status: 'Pending outcome fields' },
      { label: 'Best volume confirmation threshold', status: 'Pending outcome fields' },
      { label: 'Average P/L after ENTER CALLS', status: 'Pending outcome fields' },
      { label: 'Average drawdown before success', status: 'Pending outcome fields' }
    ]
  };
}

function calculatePositions(state = {}, calculated = {}) {
  const enriched = (state.tastytradePositions || []).map(row => enrichPosition(row, calculated));
  const positions = applyPositionManagementToRows(enriched, calculated.positionManagement);
  const open = positions.filter(position => Math.abs(position.quantity || 0) > 0);
  const totalValue = round2(open.reduce((sum, position) => sum + (numberOrNull(position.value) ?? 0), 0));
  const totalPnl = round2(open.reduce((sum, position) => sum + (numberOrNull(position.pnl) ?? 0), 0));
  const totalCost = open.reduce((sum, position) => sum + Math.abs(numberOrNull(position.costBasis) ?? 0), 0);
  return {
    status: state.positionsState?.status || 'Not loaded',
    error: state.positionsState?.error || null,
    fetchedAt: state.positionsState?.fetchedAt || null,
    accountNumber: state.positionsState?.accountNumber || null,
    selectedPositionKey: state.inputs?.selectedPositionKey || null,
    managedPositionKey: calculated.positionManagement?.active ? positionKeys(calculated.positionManagement.position || {})[0] || null : null,
    managedPositionLabel: calculated.positionManagement?.position?.label || null,
    totalValue,
    totalPnl,
    totalReturnPct: safeDiv(totalPnl, totalCost),
    deltaExposure: round2(open.reduce((sum, position) => sum + (numberOrNull(position.deltaExposure) ?? 0), 0)),
    thetaPerDay: round2(open.reduce((sum, position) => sum + (numberOrNull(position.thetaPerDay) ?? 0), 0)),
    rows: open
  };
}

function applyPositionManagementToRows(rows = [], management = {}) {
  if (!management?.active) return rows;
  const openRows = rows.filter(position => Math.abs(position.quantity || 0) > 0);
  const managedIndex = rows.findIndex(row => positionMatchesManagement(row, management, openRows));
  return rows.map((row, index) => {
    const isManaged = managedIndex >= 0 ? index === managedIndex : openRows.length === 1 && row === openRows[0];
    if (!isManaged) return row;
    return {
      ...row,
      signal: management.signal || row.signal,
      reason: managementReasonText(management) || row.reason,
      managementSignal: true
    };
  });
}

function positionMatchesManagement(row = {}, management = {}, openRows = []) {
  if (!management?.active) return false;
  if (openRows.length === 1 && row === openRows[0]) return true;
  const position = management.position || {};
  const rowKeys = [row.symbol, row.occSymbol, row.streamerSymbol].map(compactPositionSymbol).filter(Boolean);
  const positionKeys = [position.symbol, position.occSymbol, position.streamerSymbol].map(compactPositionSymbol).filter(Boolean);
  if (rowKeys.some(key => positionKeys.includes(key))) return true;
  return row.expiration && position.expiration
    && row.type === position.type
    && Number(row.strike) === Number(position.strike);
}

function managementReasonText(management = {}) {
  const signal = String(management.signal || '').trim();
  let reason = String(management.reason || '').trim();
  if (!signal) return reason;
  const upper = reason.toUpperCase();
  const prefix = `${signal.toUpperCase()} BECAUSE `;
  if (upper.startsWith(prefix)) reason = reason.slice(prefix.length);
  else if (upper.startsWith(`${signal.toUpperCase()}:`)) reason = reason.slice(signal.length + 1).trim();
  return reason ? `${signal}: ${reason}` : signal;
}

function compactPositionSymbol(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function enrichPosition(row = {}, calculated = {}) {
  const base = normalizePositionRecord(row);
  const quote = base.isOption ? optionLiveQuote(base) : live.symbols[base.symbol] || {};
  const liveFields = base.isOption ? liveOptionFields(quote) : equityLiveFields(quote);
  const mark = numberOrNull(liveFields.mid ?? liveFields.last ?? base.mark ?? base.closePrice ?? base.averagePrice);
  const average = numberOrNull(base.averagePrice) ?? 0;
  const multiplier = base.multiplier;
  const absQuantity = Math.abs(base.quantity);
  const costBasis = round2(average * absQuantity * multiplier);
  const signedValue = mark !== null ? round2(mark * base.quantity * multiplier) : null;
  const value = mark !== null ? round2(mark * absQuantity * multiplier) : null;
  const pnl = mark !== null ? round2((mark - average) * base.quantity * multiplier) : null;
  const returnPct = safeDiv(pnl, costBasis);
  const option = normalizeOptionRecord({ ...base, ...liveFields, bid: liveFields.bid ?? base.bid, ask: liveFields.ask ?? base.ask, mid: mark, source: 'position' });
  const greeks = base.isOption ? {
    delta: numberOrNull(option.delta),
    gamma: numberOrNull(option.gamma),
    theta: numberOrNull(option.theta),
    vega: numberOrNull(option.vega),
    iv: numberOrNull(option.iv)
  } : {};
  const deltaExposure = base.isOption && greeks.delta !== null ? round2(greeks.delta * base.quantity * multiplier) : base.symbol === 'SLV' ? base.quantity : null;
  const thetaPerDay = base.isOption && greeks.theta !== null ? round2(greeks.theta * base.quantity * multiplier) : null;
  const indicators = positionIndicators({ ...base, mark, average, pnl, returnPct, deltaExposure, thetaPerDay, greeks }, calculated);
  return {
    ...base,
    ...greeks,
    mark,
    value,
    signedValue,
    costBasis,
    pnl,
    returnPct,
    deltaExposure,
    thetaPerDay,
    signal: indicators.signal,
    buyProbability: indicators.buy,
    holdProbability: indicators.hold,
    trimProbability: indicators.trim,
    sellProbability: indicators.sell,
    reason: indicators.reason,
    quoteStatus: quote.updatedAt ? 'live' : mark !== null ? 'account/static' : 'missing',
    updatedAt: quote.updatedAt || null
  };
}

function normalizePositionRecord(row = {}) {
  const symbol = String(row.symbol || row['instrument-symbol'] || row.instrumentSymbol || row['underlying-symbol'] || row.underlyingSymbol || '').trim();
  const parsed = parseOptionSymbol(symbol);
  const isOption = Boolean(parsed) || String(row['instrument-type'] || row.instrumentType || '').toLowerCase().includes('option');
  const quantityRaw = numberOrNull(row.quantity ?? row['quantity-decimal'] ?? row.quantityDecimal ?? row['signed-quantity'] ?? row.signedQuantity) ?? 0;
  const direction = String(row['quantity-direction'] || row.quantityDirection || row.direction || '').toLowerCase();
  const quantity = direction.startsWith('short') ? -Math.abs(quantityRaw) : direction.startsWith('long') ? Math.abs(quantityRaw) : quantityRaw;
  const averagePrice = numberOrNull(row['average-open-price'] ?? row.averageOpenPrice ?? row['average-price'] ?? row.averagePrice ?? row.price);
  const multiplier = numberOrNull(row.multiplier) ?? (isOption ? 100 : 1);
  return {
    raw: row,
    symbol,
    streamerSymbol: parsed?.streamerSymbol || (isOption ? optionStreamerSymbolFromParts(parsed?.underlying || 'SLV', parsed?.expiration, parsed?.type, parsed?.strike) : symbol),
    occSymbol: isOption ? symbol : null,
    underlying: parsed?.underlying || row['underlying-symbol'] || row.underlyingSymbol || (isOption ? 'SLV' : symbol),
    instrumentType: row['instrument-type'] || row.instrumentType || (isOption ? 'Equity Option' : 'Equity'),
    isOption,
    expiration: parsed?.expiration || row.expiration || row['expiration-date'] || null,
    dte: daysToExpiration(parsed?.expiration || row.expiration || row['expiration-date']),
    type: parsed?.type || (String(row['option-type'] || row.optionType || '').toUpperCase().startsWith('P') ? 'P' : 'C'),
    strike: parsed?.strike ?? numberOrNull(row.strike ?? row['strike-price']),
    quantity,
    absQuantity: Math.abs(quantity),
    averagePrice,
    mark: numberOrNull(row['mark-price'] ?? row.markPrice ?? row.mark),
    closePrice: numberOrNull(row['close-price'] ?? row.closePrice),
    bid: numberOrNull(row.bid ?? row['bid-price']),
    ask: numberOrNull(row.ask ?? row['ask-price']),
    multiplier
  };
}

function equityLiveFields(quote = {}) {
  const bid = numberOrNull(quote.bid);
  const ask = numberOrNull(quote.ask);
  const mid = bid !== null && ask !== null ? round2((bid + ask) / 2) : numberOrNull(quote.last);
  return {
    bid,
    ask,
    mid,
    last: numberOrNull(quote.last),
    updatedAt: quote.updatedAt
  };
}

function positionIndicators(position, calculated = {}) {
  let buy = 20;
  let hold = 50;
  let trim = 10;
  let sell = 20;
  const bullishExposure = position.quantity > 0 && (!position.isOption || position.type === 'C') || position.quantity < 0 && position.isOption && position.type === 'P';
  const bearishExposure = position.quantity > 0 && position.isOption && position.type === 'P' || position.quantity < 0 && (!position.isOption || position.type === 'C');
  const action = calculated.action;
  const trendScore = numberOrNull(calculated.trendScore) ?? 5;
  const momentumScore = numberOrNull(calculated.momentumScore) ?? 5;
  const returnPct = numberOrNull(position.returnPct) ?? 0;
  if (bullishExposure && action === 'ENTER CALLS') { buy += 30; hold += 10; sell -= 10; }
  if (bearishExposure && (action === 'ENTER PUT SPREAD' || action === 'ENTER PUTS / PUT SPREAD')) { buy += 25; hold += 10; sell -= 5; }
  if (action === 'TRIM') { trim += 35; sell += 10; hold -= 10; }
  if (action === 'AVOID') { sell += 30; hold -= 15; buy -= 10; }
  if (returnPct >= 0.40) { trim += 30; hold -= 5; }
  if (returnPct >= 0.90) { sell += 15; trim += 15; }
  if (returnPct <= -0.30) { sell += 20; hold -= 10; }
  if (bullishExposure && trendScore >= 7 && momentumScore >= 6) hold += 15;
  if (bullishExposure && trendScore <= 3) sell += 25;
  if (bearishExposure && trendScore <= 3) hold += 15;
  if (bearishExposure && trendScore >= 7) sell += 20;
  if (position.isOption && (position.dte ?? 99) <= 1 && optionOutOfMoney(position, calculated.market?.slv?.price)) sell += 20;
  buy = Math.max(0, buy);
  hold = Math.max(0, hold);
  trim = Math.max(0, trim);
  sell = Math.max(0, sell);
  const total = Math.max(1, buy + hold + trim + sell);
  const result = {
    buy: Math.round(clamp(buy / total, 0, 1) * 100),
    hold: Math.round(clamp(hold / total, 0, 1) * 100),
    trim: Math.round(clamp(trim / total, 0, 1) * 100),
    sell: Math.round(clamp(sell / total, 0, 1) * 100)
  };
  const max = Object.entries(result).sort((a, b) => b[1] - a[1])[0]?.[0] || 'hold';
  const signal = max === 'buy' ? 'ADD / BUY' : max === 'trim' ? 'TRIM' : max === 'sell' ? 'EXIT / REDUCE' : 'HOLD';
  const reason = positionReason(position, calculated, signal);
  return { ...result, signal, reason };
}

function optionOutOfMoney(position, slvPrice) {
  const price = numberOrNull(slvPrice);
  if (price === null || position.strike === null) return false;
  return position.type === 'P' ? price > position.strike : price < position.strike;
}

function positionReason(position, calculated, signal) {
  const pieces = [];
  if (position.returnPct !== null) pieces.push(`P/L ${pctText(position.returnPct)}`);
  if (position.isOption && position.dte !== null) pieces.push(`${position.dte} DTE`);
  if (calculated.action) pieces.push(`dashboard ${calculated.action}`);
  if (position.quoteStatus) pieces.push(`${position.quoteStatus} mark`);
  return `${signal}: ${pieces.join(', ') || 'waiting for live mark'}`;
}

function positionSymbolsForLive(state = {}) {
  return [...new Set((state.tastytradePositions || []).flatMap(row => {
    const position = normalizePositionRecord(row);
    return position.isOption ? optionAliases(position) : [position.symbol];
  }).filter(Boolean))];
}

function calculateOptionProjection({ market, selectedOption, contracts, triggers, vwap, atr }) {
  const current = market.slv.price;
  const entry = market.entryOverride ?? selectedOption?.mid ?? 0;
  const targets = projectionTargets(current, triggers, atr);
  const projection = targets.map(target => {
    const today = estimateOptionAtTarget(selectedOption, target, current, 0);
    const tomorrow = estimateOptionAtTarget(selectedOption, target, current, 1);
    const positionValue = today * contracts * 100;
    const cost = entry * contracts * 100;
    const note = hasUsableGreeks(selectedOption) ? 'Greek estimate' : 'Greek data unavailable - estimate only';
    const action = projectionActionForTarget({ target, market, selectedOption, triggers, vwap, entry, today, atr });
    return {
      slv: target,
      target,
      todayMid: round2(today),
      tomorrowMid: round2(tomorrow),
      estimated: round2(today),
      positionValue: round2(positionValue),
      pnl: round2(positionValue - cost),
      returnPct: safeDiv(positionValue - cost, cost),
      action: action.label,
      actionReason: action.reason,
      notes: `${action.reason} | ${note}`
    };
  });
  const currentValue = (selectedOption?.mid ?? 0) * contracts * 100;
  const maxRisk = entry * contracts * 100;
  return {
    symbol: selectedOption?.streamerSymbol || selectedOption?.symbol || '',
    streamerSymbols: selectedOption ? [selectedOption.streamerSymbol, selectedOption.symbol].filter(Boolean) : [],
    breakeven: selectedOption?.type === 'P' ? round2((selectedOption.strike ?? 0) - entry) : round2((selectedOption?.strike ?? 0) + entry),
    maxRisk: round2(maxRisk),
    midpoint: selectedOption?.mid ?? null,
    currentValue: round2(currentValue),
    pnl: round2(currentValue - maxRisk),
    returnPct: safeDiv(currentValue - maxRisk, maxRisk),
    firstTrimPremium: round2(entry * 1.5),
    secondTrimPremium: round2(entry * 2),
    runnerPremium: round2(entry * 3),
    firstTrimSlv: projection.find(row => row.slv >= (selectedOption?.strike ?? 0) + 1)?.slv ?? null,
    secondTrimSlv: projection.find(row => row.slv >= (selectedOption?.strike ?? 0) + 2)?.slv ?? null,
    runnerSlv: projection.find(row => row.slv >= (selectedOption?.strike ?? 0) + 3)?.slv ?? null,
    projection,
    greekBased: hasUsableGreeks(selectedOption)
  };
}

function projectionActionForTarget({ target, market, selectedOption, triggers, vwap, entry, today, atr }) {
  const current = numberOrNull(market.slv?.price);
  const type = selectedOption?.type || 'C';
  const bullish = type !== 'P';
  const strike = numberOrNull(selectedOption?.strike) ?? current ?? target;
  const atrValue = numberOrNull(atr?.value) ?? Math.max(0.5, (current ?? strike) * 0.018);
  const trim1 = bullish ? Math.max(strike + 1, (triggers?.bullTrigger ?? current ?? strike) + atrValue * 0.75) : Math.min(strike - 1, (triggers?.bearTrigger ?? current ?? strike) - atrValue * 0.75);
  const trim2 = bullish ? Math.max(strike + 2, (triggers?.bullTrigger ?? current ?? strike) + atrValue * 1.25) : Math.min(strike - 2, (triggers?.bearTrigger ?? current ?? strike) - atrValue * 1.25);
  const runner = bullish ? Math.max(strike + 3, (triggers?.bullTrigger ?? current ?? strike) + atrValue * 2) : Math.min(strike - 3, (triggers?.bearTrigger ?? current ?? strike) - atrValue * 2);
  const vwapValue = numberOrNull(vwap?.value);
  const optionReturn = entry ? (today - entry) / entry : 0;
  if (bullish) {
    if (target <= (triggers?.bearTrigger ?? -Infinity) || (vwapValue !== null && target < vwapValue && optionReturn < -0.25)) return { label: 'EXIT', reason: 'Below invalidation/VWAP risk' };
    if (target >= runner || optionReturn >= 2) return { label: 'TRIM MORE', reason: 'Runner or large profit zone' };
    if (target >= trim2 || optionReturn >= 0.80) return { label: 'TRIM MORE', reason: 'Trim 2 / 80%+ return zone' };
    if (target >= trim1 || optionReturn >= 0.40) return { label: 'TRIM 25-50%', reason: 'Trim 1 / 40%+ return zone' };
    if (target >= (triggers?.bullTrigger ?? Infinity)) return { label: 'HOLD / ENTER', reason: 'Above bull trigger' };
    return { label: 'WAIT', reason: 'Below entry confirmation' };
  }
  if (target >= (triggers?.bullTrigger ?? Infinity) || (vwapValue !== null && target > vwapValue && optionReturn < -0.25)) return { label: 'EXIT', reason: 'Above invalidation/VWAP risk' };
  if (target <= runner || optionReturn >= 2) return { label: 'TRIM MORE', reason: 'Runner or large profit zone' };
  if (target <= trim2 || optionReturn >= 0.80) return { label: 'TRIM MORE', reason: 'Trim 2 / 80%+ return zone' };
  if (target <= trim1 || optionReturn >= 0.40) return { label: 'TRIM 25-50%', reason: 'Trim 1 / 40%+ return zone' };
  if (target <= (triggers?.bearTrigger ?? -Infinity)) return { label: 'HOLD / ENTER', reason: 'Below bear trigger' };
  return { label: 'WAIT', reason: 'Above bearish confirmation' };
}

function calculateTargetOdds({ market, selectedOption, triggers, atr, optionProjection }) {
  if (market.slv.price === null) return [];
  const dte = Math.max(1, selectedOption?.dte ?? 5);
  const annualizedIV = normalizeIv(selectedOption?.iv) ?? 0.45;
  const expectedMoveAtr = Math.max(0.01, (atr.value ?? market.slv.price * 0.018) * Math.sqrt(dte));
  const expectedMoveIv = Math.max(0.01, market.slv.price * annualizedIV * Math.sqrt(dte / 365));
  const targets = [...new Set([triggers.bullTrigger, optionProjection.firstTrimSlv, optionProjection.secondTrimSlv, optionProjection.runnerSlv, 54, 55, 56, 57, 58].filter(Number.isFinite).map(round2))].sort((a, b) => a - b);
  return targets.map(target => {
    if (target <= market.slv.price) return { target, probability: 1, atrProbability: 1, ivProbability: 1 };
    const zAtr = (target - market.slv.price) / expectedMoveAtr;
    const zIv = (target - market.slv.price) / expectedMoveIv;
    const atrProbability = clamp(2 * (1 - normalCdf(zAtr)), 0, 1);
    const ivProbability = clamp(2 * (1 - normalCdf(zIv)), 0, 1);
    return { target, probability: round4(0.55 * ivProbability + 0.45 * atrProbability), atrProbability: round4(atrProbability), ivProbability: round4(ivProbability) };
  });
}

function generateWhyList(ctx) {
  const { market, triggers, vwap, silverValidation, tracking, volume, volumeScore, optionsLiquidityScore, selectedOption, dataQuality } = ctx;
  const slv = market.slv.price;
  const vwapDiff = slv !== null && vwap.value !== null ? round2(slv - vwap.value) : null;
  const bullDistance = slv !== null ? round2(triggers.bullTrigger - slv) : null;
  const bearDistance = slv !== null ? round2(slv - triggers.bearTrigger) : null;
  const spreadPct = numberOrNull(selectedOption?.spreadPct);
  return [
    whyItem('Above VWAP', slv !== null && vwap.value !== null && slv > vwap.value, vwapDiff === null ? 'Waiting for VWAP' : `${vwapDiff >= 0 ? '+' : ''}${moneyText(vwapDiff)} vs VWAP`, vwapDiff === null ? 'Neutral' : vwapDiff > 0 ? 'Bullish' : 'Bearish'),
    whyItem('Bull trigger', slv !== null && slv > triggers.bullTrigger, bullDistance === null ? 'Waiting for price' : bullDistance <= 0 ? `${moneyText(Math.abs(bullDistance))} above` : `${moneyText(bullDistance)} away`, bullDistance !== null && bullDistance <= 0 ? 'Bullish' : 'Waiting'),
    whyItem('Bear trigger', slv !== null && slv < triggers.bearTrigger, bearDistance === null ? 'Waiting for price' : bearDistance <= 0 ? `${moneyText(Math.abs(bearDistance))} below` : `${moneyText(bearDistance)} cushion`, bearDistance !== null && bearDistance <= 0 ? 'Bearish' : 'Neutral'),
    whyItem('Volume pace', volume.confirmation.includes('confirmed'), `${pctText(volume.timeAdjustedPace)} of expected, score ${volumeScore}/10`, volume.confirmation.includes('Bullish') ? 'Confirmed' : volume.confirmation.includes('Bearish') ? 'Bearish' : volume.confirmation.includes('Head') ? 'Warning' : 'Neutral'),
    whyItem('Silver tracking', silverValidation.valid && tracking !== 'SLV leading', silverValidation.valid ? tracking : silverValidation.reason, !silverValidation.valid ? 'Warning' : tracking === 'SLV lagging' ? 'Bullish catch-up' : tracking === 'SLV leading' ? 'Caution' : 'Valid'),
    whyItem('Option spread', optionsLiquidityScore >= 5, spreadPct === null ? 'No live spread yet' : `${pctText(spreadPct)} spread, liquidity ${optionsLiquidityScore}/10`, spreadPct === null ? 'Waiting' : spreadPct < 0.12 ? 'Acceptable' : spreadPct > 0.20 ? 'Too wide' : 'Caution'),
    whyItem('Greeks', hasUsableGreeks(selectedOption), hasUsableGreeks(selectedOption) ? `Delta ${round2(selectedOption.delta ?? 0)}, theta ${round2(selectedOption.theta ?? 0)}` : 'Greek data unavailable', hasUsableGreeks(selectedOption) ? 'Valid' : 'Warning'),
    whyItem('Data quality', dataQuality.status !== 'BAD', dataQuality.reason, dataQuality.status || 'Unknown')
  ];
}

function calculateDataQuality({ market, selectedOption, silverValidation, optionsLiquidityScore }) {
  const now = Date.now();
  const slvAge = live.symbols.SLV?.updatedAt ? (now - Date.parse(live.symbols.SLV.updatedAt)) / 1000 : Infinity;
  const optionAge = selectedOption?.updatedAt ? (now - Date.parse(selectedOption.updatedAt)) / 1000 : Infinity;
  const open = market.marketStatus === 'OPEN';
  const slvLive = Number.isFinite(market.slv.price) && (!open || slvAge <= 180);
  const optionsLive = selectedOption && (optionsLiquidityScore > 0 || !open || optionAge <= 180);
  const badReasons = [];
  const warningReasons = [];
  if (open && !live.connected) badReasons.push('DXLink live feed is offline');
  if (!Number.isFinite(market.slv.price)) badReasons.push('SLV price is missing');
  else if (open && slvAge > 180) badReasons.push(`SLV live quote is stale or missing (${formatAge(slvAge)})`);
  if (!selectedOption) badReasons.push('No selected SLV option contract');
  else if (!optionsLive) badReasons.push(`Selected option quote is stale or missing (${formatAge(optionAge)})`);
  if (!silverValidation.valid && !Number.isFinite(market.slv.price)) badReasons.push('Silver feed is invalid and no SLV fallback price is available');
  if (badReasons.length) return { status: 'BAD', reason: badReasons.join('; ') + '.' };
  if (open && slvAge > 60) warningReasons.push(`SLV quote is older than 60 seconds (${formatAge(slvAge)})`);
  if (open && optionAge > 60) warningReasons.push(`Selected option quote is older than 60 seconds (${formatAge(optionAge)})`);
  if (!silverValidation.valid) warningReasons.push('Silver feed invalid; SLV-only logic active');
  if (!hasUsableGreeks(selectedOption)) warningReasons.push('Selected option Greeks are missing');
  if (warningReasons.length) return { status: 'WARNING', reason: warningReasons.join('; ') + '.' };
  return { status: 'GOOD', reason: 'SLV, option quote, and silver validation are usable.' };
}

function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return 'no live timestamp';
  if (seconds < 60) return `${Math.round(seconds)}s old`;
  return `${Math.round(seconds / 60)}m old`;
}

function buildWatchlist(state, market) {
  const items = ['SILVER', 'SLV', '/SI', 'GLD', 'GDX', 'DXY', 'VIX', '10Y'];
  return items.map(symbol => {
    const quote = live.symbols[symbol] || {};
    return { symbol, price: quoteMidLast(quote) ?? (symbol === 'SLV' ? market.slv.price : symbol === 'SILVER' ? market.silver?.price : null), changePct: symbol === 'SLV' ? market.slv.changePct : null, status: quote.updatedAt ? 'live' : 'placeholder' };
  });
}

function getSelectedOption(state = {}, market = {}) {
  const currentSlv = numberOrNull(market.slv?.price ?? market.slvPrice) ?? numberOrNull(state.inputs?.slvPrice);
  const chain = enrichOptionChainWithLive(state.optionChain, currentSlv);
  const selectedSymbol = state.config?.selectedOptionSymbol || state.inputs?.optionSymbol || '';
  let option = selectedSymbol ? chain.options.find(row => optionAliases(row).includes(selectedSymbol)) : null;
  if (!option) {
    const strike = numberOrNull(state.inputs?.optionStrike);
    const expiration = state.inputs?.optionExpiration || null;
    const type = String(state.inputs?.optionType || 'C').toUpperCase().startsWith('P') ? 'P' : 'C';
    option = chain.options.find(row => expiration && row.expiration === expiration && row.type === type && strike !== null && Number(row.strike) === strike);
  }
  if (!option) option = chooseDefaultOption(chain, currentSlv, state.inputs?.optionType || 'C');
  if (!option && state.inputs?.optionStrike) {
    option = optionFromInputs(state.inputs);
  }
  return option || null;
}

function optionFromInputs(input = {}) {
  const bid = numberOrNull(input.optionBid);
  const ask = numberOrNull(input.optionAsk);
  const mid = bid !== null && ask !== null ? round2((bid + ask) / 2) : bid ?? ask ?? numberOrNull(input.optionEntry);
  const symbols = optionStreamerSymbols(input);
  const dte = input.optionExpiration ? Math.ceil((new Date(`${input.optionExpiration}T16:00:00-04:00`) - Date.now()) / 86400000) : null;
  return normalizeOptionRecord({
    symbol: symbols[0],
    streamerSymbol: symbols[0],
    strike: numberOrNull(input.optionStrike),
    expiration: input.optionExpiration,
    type: input.optionType || 'C',
    bid,
    ask,
    mid,
    dte,
    source: 'setup fallback'
  });
}

function chooseDefaultOption(chain, currentSlv, type = 'C') {
  if (!chain?.options?.length || currentSlv === null) return null;
  const wantedType = String(type || 'C').toUpperCase().startsWith('P') ? 'P' : 'C';
  const candidates = chain.options
    .filter(row => row.type === wantedType && row.dte !== null && row.dte >= 1 && row.dte <= 14)
    .filter(row => row.strike !== null)
    .sort((a, b) => {
      const aDelta = Math.abs((a.delta ?? (wantedType === 'C' ? 0.5 : -0.5)) - (wantedType === 'C' ? 0.5 : -0.5));
      const bDelta = Math.abs((b.delta ?? (wantedType === 'C' ? 0.5 : -0.5)) - (wantedType === 'C' ? 0.5 : -0.5));
      const aDistance = Math.abs(a.strike - currentSlv);
      const bDistance = Math.abs(b.strike - currentSlv);
      const aLiq = calculateOptionsLiquidityScore(a);
      const bLiq = calculateOptionsLiquidityScore(b);
      return aDelta - bDelta || aDistance - bDistance || bLiq - aLiq || a.dte - b.dte;
    });
  return candidates[0] || chain.options.sort((a, b) => Math.abs((a.strike ?? 0) - currentSlv) - Math.abs((b.strike ?? 0) - currentSlv))[0] || null;
}

function enrichOptionChainWithLive(optionChain = {}, currentSlv = null, inputs = {}) {
  const options = (optionChain.options || []).map(option => {
    const quote = optionLiveQuote(option);
    return normalizeOptionRecord({ ...option, ...selectedInputOptionFields(option, inputs), ...liveOptionFields(quote), source: option.source || optionChain.source || 'tastytrade' });
  });
  const expirations = summarizeExpirations(options, currentSlv);
  return { ...optionChain, options, expirations, quoteStats: optionChainQuoteStats(options) };
}

function selectedInputOptionFields(option = {}, inputs = {}) {
  if (!inputs || !optionMatchesInputs(option, inputs)) return {};
  const bid = numberOrNull(inputs.optionBid);
  const ask = numberOrNull(inputs.optionAsk);
  const mid = bid !== null && ask !== null ? round2((bid + ask) / 2) : numberOrNull(inputs.optionEntry);
  return {
    bid: bid ?? undefined,
    ask: ask ?? undefined,
    mid: mid ?? undefined,
    source: 'selected live fallback'
  };
}

function optionMatchesInputs(option = {}, inputs = {}) {
  const selectedSymbol = String(inputs.optionSymbol || '').trim();
  if (selectedSymbol && optionAliases(option).includes(selectedSymbol)) return true;
  const strike = numberOrNull(inputs.optionStrike);
  const expiration = inputs.optionExpiration || null;
  const type = String(inputs.optionType || 'C').toUpperCase().startsWith('P') ? 'P' : 'C';
  return Boolean(expiration && option.expiration === expiration && option.type === type && strike !== null && Number(option.strike) === strike);
}

function liveOptionFields(quote = {}) {
  const bid = numberOrNull(quote.bid);
  const ask = numberOrNull(quote.ask);
  const mid = bid !== null && ask !== null ? round2((bid + ask) / 2) : numberOrNull(quote.last);
  const fields = {};
  if (bid !== null) fields.bid = bid;
  if (ask !== null) fields.ask = ask;
  if (mid !== null) fields.mid = mid;
  for (const key of ['last', 'volume', 'openInterest', 'iv', 'delta', 'gamma', 'theta', 'vega', 'rho']) {
    const value = numberOrNull(quote[key]);
    if (value !== null) fields[key] = key === 'iv' ? normalizeIv(value) : value;
  }
  if (quote.updatedAt) fields.updatedAt = quote.updatedAt;
  return fields;
}

function optionLiveQuote(option = {}) {
  for (const symbol of optionAliases(option)) {
    if (live.symbols[symbol]) return live.symbols[symbol];
  }
  return {};
}

function optionAliases(option = {}) {
  const parsed = parseOptionSymbol(option.symbol || option.occSymbol || option.streamerSymbol);
  const underlying = parsed?.underlying || option.underlying || 'SLV';
  const expiration = option.expiration || parsed?.expiration;
  const type = option.type || parsed?.type || 'C';
  const strike = numberOrNull(option.strike) ?? parsed?.strike;
  const aliases = [option.streamerSymbol, option.symbol, option.occSymbol, option.displaySymbol, parsed?.streamerSymbol];
  if (expiration && strike !== null) aliases.push(...optionSymbolVariants(underlying, expiration, type, strike));
  return [...new Set(aliases.filter(Boolean))];
}

function optionSymbolVariants(underlying, expiration, type, strike) {
  const date = parseExpiration(expiration);
  if (!date || strike === null || strike === undefined || !Number.isFinite(Number(strike))) return [];
  const root = String(underlying || 'SLV').toUpperCase().replace(/^\./, '');
  const yymmdd = `${String(date.getUTCFullYear()).slice(-2)}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  const normalizedType = String(type || 'C').toUpperCase().startsWith('P') ? 'P' : 'C';
  const dxStrike = trimTrailingZeros(strike);
  const occStrike = String(Math.round(Number(strike) * 1000)).padStart(8, '0');
  return [
    `.${root}${yymmdd}${normalizedType}${dxStrike}`,
    `.${root}${yymmdd}${normalizedType}${Number.isInteger(Number(strike)) ? `${Number(strike)}.0` : dxStrike}`,
    `${root.padEnd(6, ' ')}${yymmdd}${normalizedType}${occStrike}`,
    `${root}${yymmdd}${normalizedType}${occStrike}`
  ];
}

function optionChainQuoteStats(options = []) {
  const quoted = options.filter(row => row.bid !== null || row.ask !== null || row.last !== null).length;
  const greeks = options.filter(hasUsableGreeks).length;
  return { total: options.length, quoted, greeks };
}

function normalizeOptionRecord(row = {}) {
  const symbol = row.symbol || row['option-symbol'] || row.optionSymbol || row['occ-symbol'] || row.occSymbol || row.streamerSymbol || row['streamer-symbol'] || '';
  const parsedSymbol = parseOptionSymbol(symbol);
  const strike = numberOrNull(row.strike ?? row['strike-price'] ?? row.strikePrice) ?? parsedSymbol?.strike ?? null;
  const expiration = row.expiration || row['expiration-date'] || row.expirationDate || row['expires-at'] || parsedSymbol?.expiration || null;
  const typeRaw = row.type || row['option-type'] || row.optionType || row.putCall || row['put-call'] || parsedSymbol?.type || '';
  const type = String(typeRaw).toUpperCase().startsWith('P') ? 'P' : 'C';
  const bid = numberOrNull(row.bid ?? row['bid-price']);
  const ask = numberOrNull(row.ask ?? row['ask-price']);
  const mid = numberOrNull(row.mid ?? row.mark ?? row['mark-price']) ?? (bid !== null && ask !== null ? round2((bid + ask) / 2) : bid ?? ask ?? null);
  const streamerSymbol = row.streamerSymbol || row['streamer-symbol'] || row.dxSymbol || row['dx-symbol'] || parsedSymbol?.streamerSymbol || optionStreamerSymbolFromParts('SLV', expiration, type, strike);
  const dte = numberOrNull(row.dte ?? row['days-to-expiration'] ?? row.daysToExpiration) ?? daysToExpiration(expiration);
  const option = {
    symbol,
    streamerSymbol,
    occSymbol: row.occSymbol || row['occ-symbol'] || symbol,
    displaySymbol: row.displaySymbol || row['display-symbol'] || symbol || streamerSymbol,
    strike,
    expiration,
    type,
    dte,
    bid,
    ask,
    mid,
    last: numberOrNull(row.last ?? row['last-price']),
    volume: numberOrNull(row.volume),
    openInterest: numberOrNull(row.openInterest ?? row['open-interest'] ?? row.open_interest),
    iv: normalizeIv(row.iv ?? row['implied-volatility'] ?? row.impliedVolatility ?? row.volatility),
    delta: numberOrNull(row.delta),
    gamma: numberOrNull(row.gamma),
    theta: numberOrNull(row.theta),
    vega: numberOrNull(row.vega),
    rho: numberOrNull(row.rho),
    updatedAt: row.updatedAt || row['updated-at'] || null,
    source: row.source || 'tastytrade',
    bidTrend: row.bidTrend || 'flat'
  };
  option.spread = option.bid !== null && option.ask !== null ? round2(option.ask - option.bid) : null;
  option.spreadPct = option.spread !== null && option.mid ? option.spread / option.mid : null;
  option.liquidityScore = calculateOptionsLiquidityScore(option);
  option.bestForCallPlay = option.type === 'C'
    && option.delta !== null && option.delta >= 0.35 && option.delta <= 0.65
    && (option.spreadPct === null || option.spreadPct <= 0.12)
    && ((option.volume ?? 0) > 100 || (option.openInterest ?? 0) > 500);
  return option;
}

function projectionTargets(current, triggers, atr) {
  const base = [current !== null ? current - 1 : null, current, triggers.bullTrigger, 54, 55, 56, 57, 58, 60];
  if (current !== null) {
    for (let p = Math.floor(current) - 2; p <= Math.ceil(current) + 6; p += 1) base.push(p);
  }
  return [...new Set(base.filter(Number.isFinite).map(round2))].sort((a, b) => a - b);
}

function estimateOptionAtTarget(option, targetSlv, currentSlv, daysElapsed = 0, ivChangeAssumption = 0) {
  if (!option || !Number.isFinite(targetSlv)) return 0;
  const currentMid = numberOrNull(option.mid) ?? numberOrNull(option.last) ?? 0;
  const dS = currentSlv !== null ? targetSlv - currentSlv : 0;
  const intrinsic = option.type === 'P' ? Math.max(0, (option.strike ?? 0) - targetSlv) : Math.max(0, targetSlv - (option.strike ?? 0));
  if (hasUsableGreeks(option)) {
    const delta = numberOrNull(option.delta) ?? 0;
    const gamma = numberOrNull(option.gamma) ?? 0;
    const theta = numberOrNull(option.theta) ?? 0;
    const vega = numberOrNull(option.vega) ?? 0;
    return round2(Math.max(intrinsic, 0, currentMid + delta * dS + 0.5 * gamma * dS * dS + theta * daysElapsed + vega * ivChangeAssumption));
  }
  const remainingTimeValue = Math.max(0, currentMid - optionIntrinsic(option, currentSlv));
  const decay = daysElapsed ? 0.82 : 1;
  return round2(Math.max(intrinsic, intrinsic + remainingTimeValue * decay, 0));
}

function optionIntrinsic(option, slvPrice) {
  if (!option || slvPrice === null) return 0;
  return option.type === 'P' ? Math.max(0, (option.strike ?? 0) - slvPrice) : Math.max(0, slvPrice - (option.strike ?? 0));
}

function hasUsableGreeks(option) {
  return option && [option.delta, option.gamma, option.theta, option.vega].some(value => Number.isFinite(numberOrNull(value)));
}

function projectedPnlAt(optionProjection, target) {
  const row = optionProjection.projection?.find(item => Math.abs(item.slv - target) < 0.01)
    || optionProjection.projection?.reduce((best, item) => !best || Math.abs(item.slv - target) < Math.abs(best.slv - target) ? item : best, null);
  return row?.pnl ?? null;
}

function summarizeExpirations(options, currentSlv) {
  const map = new Map();
  const currentPrice = numberOrNull(currentSlv);
  for (const option of options) {
    if (!option.expiration) continue;
    const existing = map.get(option.expiration) || { expiration: option.expiration, dte: option.dte, count: 0, strikes: new Set(), impliedMove: null, impliedMoveEstimated: false, ivDistance: Infinity, type: 'weekly' };
    existing.count += 1;
    if (option.strike !== null) existing.strikes.add(option.strike);
    const iv = normalizeIv(option.iv);
    if (currentPrice !== null && iv !== null) {
      const distance = option.strike !== null ? Math.abs(option.strike - currentPrice) : 999;
      if (distance < existing.ivDistance) {
        existing.ivDistance = distance;
        existing.impliedMove = impliedMoveFromIv(currentPrice, iv, option.dte);
        existing.impliedMoveEstimated = false;
      }
    }
    map.set(option.expiration, existing);
  }
  return [...map.values()]
    .map(row => {
      const fallbackMove = row.impliedMove ?? estimatedExpirationMove(currentPrice, row.dte);
      const { ivDistance, ...clean } = row;
      return { ...clean, impliedMove: fallbackMove, impliedMoveEstimated: row.impliedMove === null && fallbackMove !== null, strikes: [...row.strikes].sort((a, b) => a - b) };
    })
    .sort((a, b) => (a.dte ?? 999) - (b.dte ?? 999));
}

function impliedMoveFromIv(currentSlv, iv, dte) {
  const price = numberOrNull(currentSlv);
  const volatility = normalizeIv(iv);
  if (price === null || volatility === null) return null;
  const days = Math.max(0.5, numberOrNull(dte) ?? 1);
  return round2(price * volatility * Math.sqrt(days / 365));
}

function estimatedExpirationMove(currentSlv, dte) {
  const fallbackIv = numberOrNull(process.env.SLV_DEFAULT_IV_ASSUMPTION) ?? 0.45;
  return impliedMoveFromIv(currentSlv, fallbackIv, dte);
}

function optionStreamerSymbolFromParts(underlying, expiration, type, strike) {
  if (!expiration || strike === null || strike === undefined || !Number.isFinite(Number(strike))) return '';
  const date = parseExpiration(expiration);
  if (!date) return '';
  const yymmdd = `${String(date.getUTCFullYear()).slice(-2)}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  return `.${underlying}${yymmdd}${type}${trimTrailingZeros(strike)}`;
}

function daysToExpiration(expiration) {
  if (!expiration) return null;
  const exp = new Date(`${expiration}T16:00:00-04:00`).getTime();
  if (!Number.isFinite(exp)) return null;
  return Math.max(0, Math.ceil((exp - Date.now()) / 86400000));
}

function optionSymbolsForLive(state, slvPrice) {
  const chain = enrichOptionChainWithLive(state.optionChain, slvPrice);
  const selected = getSelectedOption(state, { slvPrice });
  const selectedExpiration = state.inputs?.optionExpiration || selected?.expiration;
  const selectedType = String(state.inputs?.optionType || selected?.type || 'C').toUpperCase().startsWith('P') ? 'P' : 'C';
  const current = numberOrNull(slvPrice);
  const visibleWindow = Math.max(5, numberOrNull(process.env.OPTION_VISIBLE_STRIKE_WINDOW) ?? numberOrNull(state.config?.optionVisibleStrikeWindow) ?? 7);
  const broaderWindow = Math.max(visibleWindow, numberOrNull(process.env.OPTION_NEARBY_STRIKE_WINDOW) ?? numberOrNull(state.config?.optionNearbyStrikeWindow) ?? 5);
  const maxBulk = Math.max(40, numberOrNull(process.env.OPTION_LIVE_CONTRACTS) ?? numberOrNull(state.config?.optionLiveContracts) ?? 140);
  const selectedRows = chain.options
    .filter(row => row.expiration === selectedExpiration && row.type === selectedType)
    .filter(row => current === null || row.strike === null || Math.abs(row.strike - current) <= visibleWindow)
    .sort((a, b) => Number(a.strike) - Number(b.strike));
  const nearbyRows = chain.options
    .filter(row => row.dte !== null && row.dte <= 21)
    .filter(row => row.type === selectedType)
    .filter(row => current === null || row.strike === null || Math.abs(row.strike - current) <= broaderWindow)
    .sort((a, b) => (a.dte ?? 999) - (b.dte ?? 999) || Math.abs((a.strike ?? current ?? 0) - (current ?? 0)) - Math.abs((b.strike ?? current ?? 0) - (current ?? 0)));
  const bulk = uniqueOptionsByPrimarySymbol([...selectedRows, ...nearbyRows]).slice(0, maxBulk).map(optionPrimaryLiveSymbol).filter(Boolean);
  return [...new Set([...optionAliases(selected || {}), ...bulk].filter(Boolean))];
}

function uniqueOptionsByPrimarySymbol(options = []) {
  const seen = new Set();
  const rows = [];
  for (const option of options) {
    const key = optionPrimaryLiveSymbol(option);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(option);
  }
  return rows;
}

function optionPrimaryLiveSymbol(option = {}) {
  return option.streamerSymbol || optionAliases(option)[0] || '';
}

function recentSlvPrices(state) {
  return (state.log || []).slice(-10).map(row => numberOrNull(row.slvPrice)).filter(Number.isFinite);
}

function quoteMidLast(quote = {}) {
  const last = numberOrNull(quote.last);
  if (last !== null) return last;
  const bid = numberOrNull(quote.bid);
  const ask = numberOrNull(quote.ask);
  return bid !== null && ask !== null ? round2((bid + ask) / 2) : null;
}

function whyItem(label, passed, detail, status = '') {
  return { label, passed: Boolean(passed), detail: detail ?? '', status };
}

function normalizeIv(value) {
  const n = numberOrNull(value);
  if (n === null) return null;
  return n > 3 ? n / 100 : n;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function moneyText(value) {
  const n = numberOrNull(value);
  return n === null ? '-' : `$${n.toFixed(2)}`;
}

function pctText(value) {
  const n = numberOrNull(value);
  return n === null ? '-' : `${Math.round(n * 100)}%`;
}

function liveSubscriptionSymbols(state, requestedSymbols = []) {
  const slvPrice = numberOrNull(state.inputs?.slvPrice);
  return [...new Set([
    ...baseSubscriptionSymbols(requestedSymbols),
    'SLV',
    'GLD',
    'GDX',
    ...optionSymbolsForLive(state, slvPrice),
    ...optionStreamerSymbols(state.inputs),
    ...positionSymbolsForLive(state)
  ].filter(Boolean))];
}

function baseSubscriptionSymbols(symbols = []) {
  return [...new Set((symbols || [])
    .filter(symbol => typeof symbol === 'string' && symbol.trim())
    .map(symbol => symbol.trim())
    .filter(symbol => !isSilverProviderSymbol(symbol))
    .filter(symbol => !parseOptionSymbol(symbol))
    .slice(0, 25))];
}

function isSilverProviderSymbol(symbol) {
  return ['/SI', 'SI', 'SILVER', 'TVC:SILVER', 'CAPITALCOM:SILVER', 'OANDA:XAGUSD', 'XAG/USD', 'XAGUSD', 'XAG']
    .includes(String(symbol || '').trim().toUpperCase());
}

async function refreshExternalSilverIfNeeded(config = {}, force = false, slvPrice = null) {
  const now = Date.now();
  const ttlMs = Math.max(15, Number(process.env.SILVER_SPOT_REFRESH_SECONDS || 15)) * 1000;
  if (!force && now < live.spotProvider.nextRefreshAt) return;
  live.spotProvider.nextRefreshAt = now + ttlMs;
  const min = numberOrNull(config.expectedSilverMin) ?? numberOrNull(process.env.EXPECTED_SILVER_MIN) ?? 45;
  const max = numberOrNull(config.expectedSilverMax) ?? numberOrNull(process.env.EXPECTED_SILVER_MAX) ?? 75;
  const silver = await fetchMetalPriceSilver({
    apiKey: process.env.METALPRICE_API_KEY,
    baseUrl: process.env.METALPRICE_API_BASE_URL || 'https://api.metalpriceapi.com/v1',
    slvPrice,
    expectedMin: min,
    expectedMax: max,
    timeoutMs: Number(process.env.METALPRICE_API_TIMEOUT_MS || process.env.SILVER_SPOT_TIMEOUT_MS || 5000)
  });
  live.spotProvider = {
    ...silver,
    updatedAt: silver.timestamp,
    nextRefreshAt: now + ttlMs
  };
}

function marketDataSources(state) {
  return {
    silverSpot: 'MetalPriceAPI',
    silverSpotStatus: live.spotProvider.status || live.spotProvider.reason || 'Not loaded',
    silverSpotUpdatedAt: live.spotProvider.updatedAt || live.spotProvider.timestamp || null,
    silverSpotError: live.spotProvider.error,
    silverFutures: 'disabled: silver is provided only by MetalPriceAPI',
    slv: live.symbols.SLV ? 'DXLink SLV' : 'manual fallback',
    option: firstLiveSymbol(optionStreamerSymbols(state.inputs)) ? 'DXLink option quote' : 'manual/entry fallback'
  };
}

function optionStreamerSymbols(input) {
  const explicit = String(input.optionSymbol || '').trim();
  const strike = numberOrNull(input.optionStrike);
  const expiration = parseExpiration(input.optionExpiration);
  if (explicit) return [explicit];
  if (strike === null || !expiration) return [];
  const underlying = String(input.optionUnderlying || 'SLV').toUpperCase();
  const type = String(input.optionType || 'C').toUpperCase().startsWith('P') ? 'P' : 'C';
  const yymmdd = `${String(expiration.getUTCFullYear()).slice(-2)}${String(expiration.getUTCMonth() + 1).padStart(2, '0')}${String(expiration.getUTCDate()).padStart(2, '0')}`;
  const dxStrike = trimTrailingZeros(strike);
  const occStrike = String(Math.round(strike * 1000)).padStart(8, '0');
  const paddedRoot = underlying.padEnd(6, ' ');
  return [...new Set([
    `.${underlying}${yymmdd}${type}${dxStrike}`,
    `.${underlying}${yymmdd}${type}${Number.isInteger(strike) ? `${strike}.0` : dxStrike}`,
    `${paddedRoot}${yymmdd}${type}${occStrike}`
  ])];
}

function parseExpiration(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function recordSignalSnapshotIfNeeded(state, calculated) {
  state.signalSnapshots = Array.isArray(state.signalSnapshots) ? state.signalSnapshots : [];
  state.actionTimeline = Array.isArray(state.actionTimeline) ? state.actionTimeline : [];
  const snapshot = makeSignalSnapshot(calculated);
  const last = state.signalSnapshots.at(-1);
  const lastTime = last?.timestamp ? Date.parse(last.timestamp) : 0;
  const elapsed = Date.now() - (Number.isFinite(lastTime) ? lastTime : 0);
  const changed = !last
    || last.action !== snapshot.action
    || last.selectedContract !== snapshot.selectedContract
    || Math.abs((numberOrNull(last.tradeScore) ?? 0) - (numberOrNull(snapshot.tradeScore) ?? 0)) >= 5
    || elapsed >= 5 * 60 * 1000;
  if (!changed) return false;
  state.signalSnapshots.push(snapshot);
  state.signalSnapshots = state.signalSnapshots.slice(-1000);
  const previousAction = state.actionTimeline.at(-1)?.action;
  if (previousAction !== snapshot.action) {
    state.actionTimeline.push({
      timestamp: snapshot.timestamp,
      action: snapshot.action,
      activeSetup: snapshot.activeSetup,
      slvPrice: snapshot.slvPrice,
      bullishCallScore: snapshot.bullishCallScore,
      bearishPutScore: snapshot.bearishPutScore,
      noTradeScore: snapshot.noTradeScore,
      positionScore: snapshot.positionScore,
      tradeScore: snapshot.tradeScore,
      selectedOptionMid: snapshot.optionMid,
      positionPnl: snapshot.positionPnl,
      positionReturnPct: snapshot.positionReturnPct,
      reason: snapshot.reason
    });
    state.actionTimeline = state.actionTimeline.slice(-200);
  }
  return true;
}

function makeSignalSnapshot(c = {}) {
  const option = c.selectedOption || {};
  return {
    timestamp: new Date().toISOString(),
    slvPrice: c.market?.slv?.price ?? null,
    silverPrice: c.silver?.valid ? c.silver.price : null,
    vwap: c.vwap?.value ?? null,
    bullTrigger: c.bullTrigger ?? null,
    bearTrigger: c.bearTrigger ?? null,
    volumePace: c.volumePace ?? null,
    tradeScore: c.tradeScore ?? null,
    activeSetup: c.activeSetup ?? null,
    recommendedContract: c.contractRecommendation?.recommended?.label ?? null,
    contractDecision: c.contractRecommendation?.finalDecision ?? null,
    contractScore: c.contractRecommendation?.contractQuality?.score ?? null,
    entryTimingScore: c.contractRecommendation?.entryTiming?.score ?? null,
    bullishCallScore: c.bullishCallScore ?? null,
    bearishPutScore: c.bearishPutScore ?? null,
    noTradeScore: c.noTradeScore ?? null,
    positionScore: c.positionScore ?? null,
    action: c.action ?? null,
    reason: c.reasonSummary ?? null,
    selectedContract: option.displaySymbol || option.streamerSymbol || option.symbol || null,
    optionBid: option.bid ?? null,
    optionAsk: option.ask ?? null,
    optionMid: option.mid ?? null,
    delta: option.delta ?? null,
    gamma: option.gamma ?? null,
    theta: option.theta ?? null,
    iv: option.iv ?? null,
    dte: option.dte ?? null,
    positionPnl: c.positionManagement?.position?.pnl ?? null,
    positionReturnPct: c.positionManagement?.position?.returnPct ?? null,
    positionSignal: c.positionManagement?.signal ?? null,
    outcome30m: null,
    outcome1h: null,
    outcomeEod: null,
    outcomeExpiration: null,
    maxFavorableExcursion: null,
    maxAdverseExcursion: null
  };
}

function appendLog(state, notes) {
  const c = calculate(state.inputs, state);
  const signalSnapshot = makeSignalSnapshot(c);
  state.log.push({
    timestamp: new Date().toISOString(),
    marketStatus: marketStatus(),
    silverSpot: c.silver?.price,
    silverPrice: c.silver?.price,
    silverFutures: null,
    slvPrice: state.inputs.slvPrice,
    slvVolume: state.inputs.slvVolume,
    avgSlvVolume: state.inputs.avgSlvVolume,
    volumePace: c.volumePace,
    vwap: state.inputs.vwap,
    openingRangeHigh: state.inputs.openingRangeHigh,
    openingRangeLow: state.inputs.openingRangeLow,
    bullTrigger: c.bullTrigger,
    bearTrigger: c.bearTrigger,
    activeSetup: c.activeSetup,
    bullishCallScore: c.bullishCallScore,
    bearishPutScore: c.bearishPutScore,
    noTradeScore: c.noTradeScore,
    positionScore: c.positionScore,
    tradeScore: c.tradeScore,
    action: c.action,
    reason: c.reasonSummary,
    positionSignal: c.positionManagement?.signal,
    positionPnl: c.positionManagement?.position?.pnl,
    positionReturnPct: c.positionManagement?.position?.returnPct,
    recommendedContract: c.contractRecommendation?.recommended?.label,
    contractDecision: c.contractRecommendation?.finalDecision,
    contractScore: c.contractRecommendation?.contractQuality?.score,
    entryTimingScore: c.contractRecommendation?.entryTiming?.score,
    confidence: c.confidence,
    confidencePercent: c.confidencePercent,
    selectedContract: signalSnapshot.selectedContract,
    optionBid: signalSnapshot.optionBid,
    optionAsk: signalSnapshot.optionAsk,
    optionMid: signalSnapshot.optionMid,
    delta: signalSnapshot.delta,
    gamma: signalSnapshot.gamma,
    theta: signalSnapshot.theta,
    iv: signalSnapshot.iv,
    dte: signalSnapshot.dte,
    outcome30m: null,
    outcome1h: null,
    outcomeEod: null,
    outcomeExpiration: null,
    maxFavorableExcursion: null,
    maxAdverseExcursion: null,
    apiStatus: state.apiStatus || 'Manual/local',
    dataQuality: c.dataQuality?.status,
    notes
  });
  state.log = state.log.slice(-300);
}

async function recordRuntimeError(error) {
  try {
    const state = await readState();
    state.apiStatus = `Error: ${error.message}`;
    state.timestamp = new Date().toISOString();
    appendLog(state, error.message);
    await writeState(state);
    broadcast(await terminalPayload());
  } catch {
    // Keep the HTTP server alive even if the state file cannot be updated.
  }
}

async function authStatus() {
  const state = await readState();
  const tokens = state.tastytradeTokens || {};
  return {
    oauthConfigured: Boolean(process.env.TASTYTRADE_CLIENT_ID),
    oauthAuthenticated: Boolean(tokens.accessToken),
    sessionTokenCached: Boolean(state.tastytradeSessionToken || process.env.TASTYTRADE_SESSION_TOKEN),
    clientIdPresent: Boolean(process.env.TASTYTRADE_CLIENT_ID),
    redirectUri: oauthRedirectUri(),
    mode: tokens.accessToken ? 'oauth' : state.tastytradeSessionToken || process.env.TASTYTRADE_SESSION_TOKEN ? 'session-token' : 'oauth-required',
    tokenExpiresAt: tokens.expiresAt || null
  };
}

async function startOAuth(req, res, url) {
  const oauth = await buildOAuthUrl();
  res.writeHead(302, { location: oauth.url });
  res.end();
}

async function buildOAuthUrl() {
  const clientId = process.env.TASTYTRADE_CLIENT_ID;
  if (!clientId) throw new Error('Missing TASTYTRADE_CLIENT_ID');
  const state = await readState();
  const nonce = base64Url(crypto.randomBytes(18));
  const usePkce = process.env.TASTYTRADE_OAUTH_USE_PKCE === 'TRUE';
  state.oauth = { nonce, usePkce, createdAt: new Date().toISOString() };
  await writeState(state);
  const params = new URLSearchParams();
  params.set('response_type', 'code');
  params.set('client_id', clientId);
  params.set('redirect_uri', oauthRedirectUri());
  const scope = process.env.TASTYTRADE_OAUTH_SCOPE || '';
  if (scope) params.set('scope', scope);
  params.set('state', nonce);
  if (usePkce) {
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    state.oauth.verifier = verifier;
    await writeState(state);
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
  }
  const authUrl = buildTastytradeAuthorizeUrl(params);
  return { url: authUrl, redirectUri: oauthRedirectUri(), scope, usePkce };
}

function buildTastytradeAuthorizeUrl(params) {
  const base = process.env.TASTYTRADE_AUTH_URL || 'https://my.tastytrade.com/app.html#/oauth/authorize';
  if (base.includes('#')) {
    const [beforeHash, afterHash = ''] = base.split('#');
    const [hashPath] = afterHash.split('?');
    return `${beforeHash}#${hashPath}?${params.toString()}`;
  }
  const url = new URL(base);
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

async function finishOAuth(req, res, url) {
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) return sendHtml(res, `<h1>OAuth failed</h1><pre>${escapeHtml(String(error))}</pre>`, 400);
  const state = await readState();
  if (!code || !state.oauth || returnedState !== state.oauth.nonce) {
    return sendHtml(res, '<h1>OAuth state mismatch</h1><p>Restart the OAuth flow from the dashboard.</p>', 400);
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oauthRedirectUri(),
    client_id: process.env.TASTYTRADE_CLIENT_ID || ''
  });
  if (state.oauth.verifier) body.set('code_verifier', state.oauth.verifier);
  if (process.env.TASTYTRADE_CLIENT_SECRET) body.set('client_secret', process.env.TASTYTRADE_CLIENT_SECRET);
  let tokenResult;
  try {
    tokenResult = await exchangeOAuthCode(state.config, body);
  } catch (tokenError) {
    return sendHtml(res, `<h1>Token exchange failed</h1><pre>${escapeHtml(tokenError.message)}</pre>`, 500);
  }
  const parsed = normalizeOAuthTokenResponse(tokenResult.parsed);
  state.tastytradeTokens = {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    tokenType: parsed.token_type || 'Bearer',
    expiresAt: parsed.expires_in ? new Date(Date.now() + Number(parsed.expires_in) * 1000).toISOString() : null,
    tokenUrl: tokenResult.tokenUrl,
    raw: parsed
  };
  state.oauth = null;
  state.config.provider = 'TASTYTRADE_LIVE';
  state.apiStatus = 'Tastytrade OAuth connected';
  await writeState(state);
  broadcast(await terminalPayload());
  sendHtml(res, `<h1>Tastytrade connected</h1><p>Token endpoint: ${escapeHtml(tokenResult.tokenUrl)}</p><p>You can close this tab and return to the Silver / SLV Play Finder.</p>`);
}

async function exchangeOAuthCode(config, body) {
  const errors = [];
  for (const tokenUrl of oauthTokenUrls(config)) {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: oauthHeaders('application/x-www-form-urlencoded'),
      body
    });
    const text = await response.text();
    if (response.ok) {
      return { tokenUrl, parsed: text ? JSON.parse(text) : {} };
    }
    errors.push(`${tokenUrl} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  throw new Error(`Tastytrade OAuth token exchange failed. ${errors.join(' | ')}`);
}

async function fetchOAuthClientCredentialsToken(config) {
  const clientId = process.env.TASTYTRADE_CLIENT_ID || '';
  const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    throw new Error('Set TASTYTRADE_CLIENT_ID and TASTYTRADE_CLIENT_SECRET in .env before connecting the Tastytrade OAuth client.');
  }
  const tokenUrl = process.env.TASTYTRADE_TOKEN_URL || `${tastytradeBaseUrl(config)}/oauth/token`;
  const attempts = [
    {
      name: 'client_credentials_basic',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' })
    },
    {
      name: 'client_credentials_body',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
    }
  ];
  const errors = [];
  for (const attempt of attempts) {
    const response = await fetch(tokenUrl, { method: 'POST', headers: attempt.headers, body: attempt.body });
    const text = await response.text();
    if (response.ok) {
      const parsed = normalizeOAuthTokenResponse(JSON.parse(text));
      if (!parsed.access_token) throw new Error(`Tastytrade OAuth token response from ${attempt.name} did not include an access token.`);
      return {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token || null,
        tokenType: parsed.token_type || 'Bearer',
        expiresAt: parsed.expires_in ? new Date(Date.now() + Number(parsed.expires_in) * 1000).toISOString() : null,
        grantType: 'client_credentials',
        raw: parsed.raw || parsed
      };
    }
    errors.push(`${attempt.name}: ${response.status} ${text.slice(0, 500)}`);
  }
  throw new Error(`Tastytrade OAuth client token failed. ${errors.join(' | ')}`);
}

function tastytradeClient(config) {
  let sessionToken = process.env.TASTYTRADE_SESSION_TOKEN || '';
  let activeBaseUrl = tastytradeBaseUrl(config);
  async function session(force = false) {
    if (sessionToken && !force) return sessionToken;
    const login = process.env.TASTYTRADE_USERNAME;
    const password = process.env.TASTYTRADE_PASSWORD;
    if (!login || !password) throw new Error('Set TASTYTRADE_USERNAME and TASTYTRADE_PASSWORD environment variables before using Tastytrade.');
    const errors = [];
    for (const candidateBaseUrl of tastytradeBaseUrls(config)) {
      const response = await fetch(candidateBaseUrl + '/sessions', {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ login, password, 'remember-me': true })
      });
      const text = await response.text();
      if (response.ok) {
        const parsed = text ? JSON.parse(text) : {};
        const data = parsed.data || parsed;
        sessionToken = data['session-token'] || data.sessionToken || data.token;
        if (!sessionToken) throw new Error(`Tastytrade did not return a session token from ${candidateBaseUrl}.`);
        activeBaseUrl = candidateBaseUrl;
        return sessionToken;
      }
      const challengeToken = response.headers.get('x-tastyworks-challenge-token') || response.headers.get('x-tastytrade-challenge-token');
      let parsed = {};
      try { parsed = JSON.parse(text); } catch {}
      if (parsed?.error?.code === 'device_challenge_required') {
        throw new Error(`Tastytrade device challenge required from ${candidateBaseUrl}. Log into tastytrade in the browser and approve this device. Challenge token present: ${Boolean(challengeToken)}.`);
      }
      errors.push(`${candidateBaseUrl} -> ${response.status}: ${text.slice(0, 500)}`);
    }
    const nginx401 = errors.every(error => error.includes('-> 401:') && error.toLowerCase().includes('nginx'));
    if (nginx401) {
      throw new Error(`Tastytrade rejected the /sessions login before returning an API JSON response. This usually means Open API Access is not enabled for the account, or the username/password was rejected. In tastytrade, open Manage > API > Open API Access and enable/accept API access, then retry Connect Tastytrade. Details: ${errors.join(' | ')}`);
    }
    throw new Error(`Tastytrade login failed. ${errors.join(' | ')}`);
  }
  async function authed(pathname, options = {}) {
    const token = await authHeader(config, session);
    return request(pathname, { ...options, headers: apiHeaders({ ...(options.headers || {}), Authorization: token }) });
  }
  async function request(pathname, options = {}) {
    const response = await fetch(activeBaseUrl + pathname, options);
    const text = await response.text();
    if (!response.ok) throw new Error(`Tastytrade ${response.status} from ${activeBaseUrl}: ${text}`);
    const parsed = text ? JSON.parse(text) : {};
    return parsed.data || parsed;
  }
  async function authedFirst(paths, label) {
    const errors = [];
    for (const pathname of paths) {
      try {
        return { endpoint: pathname, payload: await authed(pathname) };
      } catch (error) {
        errors.push(`${pathname}: ${error.message}`);
      }
    }
    throw new Error(`${label} failed. ${errors.join(' | ')}`);
  }
  return {
    session,
    accounts: async () => extractItems(await authed('/customers/me/accounts'), ['accounts', 'items']),
    quoteToken: async () => authed('/api-quote-tokens'),
    optionChain: async underlying => authedFirst([
      `/option-chains/${encodeURIComponent(underlying)}/nested`,
      `/option-chains/${encodeURIComponent(underlying)}`,
      `/instruments/equity-options/chains/${encodeURIComponent(underlying)}`,
      `/instruments/equity-options?underlying-symbol=${encodeURIComponent(underlying)}`
    ], `Option chain ${underlying}`),
    marketMetrics: async symbols => authed(`/market-metrics?symbols=${encodeURIComponent(symbols.join(','))}`),
    firstAccountNumber: async () => {
      const accounts = extractItems(await authed('/customers/me/accounts'), ['accounts', 'items']);
      if (!accounts.length) throw new Error('No Tastytrade accounts returned.');
      const account = accounts[0].account || accounts[0];
      return account['account-number'] || account.accountNumber || account.number;
    },
    positions: async accountNumber => extractItems(await authed(`/accounts/${encodeURIComponent(accountNumber)}/positions`), ['items', 'positions'])
  };
}

async function authHeader(config, sessionFactory) {
  const state = await readState();
  const tokens = state.tastytradeTokens || {};
  if (tokens.accessToken || tokens.refreshToken || process.env.TASTYTRADE_REFRESH_TOKEN) {
    if (!state.tastytradeTokens?.refreshToken && process.env.TASTYTRADE_REFRESH_TOKEN) {
      state.tastytradeTokens = {
        accessToken: null,
        refreshToken: process.env.TASTYTRADE_REFRESH_TOKEN,
        tokenType: 'Bearer',
        expiresAt: new Date(0).toISOString(),
        grantType: 'personal_grant'
      };
    }
    const refreshed = await refreshOAuthTokenIfNeeded(state);
    return `${refreshed.tokenType || 'Bearer'} ${refreshed.accessToken}`;
  }
  if (state.tastytradeSessionToken) return state.tastytradeSessionToken;
  if (process.env.TASTYTRADE_SESSION_TOKEN) return process.env.TASTYTRADE_SESSION_TOKEN;
  if (process.env.TASTYTRADE_CLIENT_ID) {
    throw new Error('Tastytrade grant is configured but not connected yet. Click Connect Grant, then Test Tastytrade / Start Live again.');
  }
  return sessionFactory(false);
}

async function refreshOAuthTokenIfNeeded(state, force = false) {
  const tokens = state.tastytradeTokens || {};
  if (!tokens.refreshToken) return tokens;
  if (!force && tokens.accessToken && tokens.expiresAt && Date.parse(tokens.expiresAt) - Date.now() > 60_000) return tokens;
  const refreshResult = await exchangeOAuthRefreshToken(state.config, tokens.refreshToken);
  const parsed = normalizeOAuthTokenResponse(refreshResult.parsed);
  if (!parsed.access_token) throw new Error('Tastytrade OAuth refresh did not return an access token.');
  state.tastytradeTokens = {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token || tokens.refreshToken,
    tokenType: parsed.token_type || tokens.tokenType || 'Bearer',
    expiresAt: parsed.expires_in ? new Date(Date.now() + Number(parsed.expires_in) * 1000).toISOString() : tokens.expiresAt,
    tokenUrl: refreshResult.tokenUrl,
    raw: parsed
  };
  await writeState(state);
  return state.tastytradeTokens;
}

async function exchangeOAuthRefreshToken(config, refreshToken) {
  const clientId = process.env.TASTYTRADE_CLIENT_ID || '';
  const clientSecret = process.env.TASTYTRADE_IGNORE_CLIENT_SECRET === 'TRUE' ? '' : process.env.TASTYTRADE_CLIENT_SECRET || '';
  const urls = oauthTokenUrls(config);
  const attempts = [];
  for (const tokenUrl of urls) {
    if (clientSecret) {
      attempts.push({
        name: 'refresh_doc_secret',
        tokenUrl,
        headers: oauthHeaders('application/x-www-form-urlencoded'),
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_secret: clientSecret
        })
      });
    }
    if (clientId && clientSecret) {
      attempts.push({
        name: 'refresh_basic',
        tokenUrl,
        headers: {
          ...oauthHeaders('application/x-www-form-urlencoded'),
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
      });
    }
    attempts.push({
      name: 'refresh_body_secret',
      tokenUrl,
      headers: oauthHeaders('application/x-www-form-urlencoded'),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {})
      })
    });
    attempts.push({
      name: 'refresh_body_public',
      tokenUrl,
      headers: oauthHeaders('application/x-www-form-urlencoded'),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId
      })
    });
    attempts.push({
      name: 'refresh_json_snake',
      tokenUrl,
      headers: oauthHeaders('application/json'),
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId
      })
    });
    attempts.push({
      name: 'refresh_json_kebab',
      tokenUrl,
      headers: oauthHeaders('application/json'),
      body: JSON.stringify({
        'grant-type': 'refresh-token',
        'refresh-token': refreshToken,
        'client-id': clientId
      })
    });
  }
  const errors = [];
  for (const attempt of attempts) {
    const response = await fetch(attempt.tokenUrl, {
      method: 'POST',
      headers: attempt.headers,
      body: attempt.body
    });
    const text = await response.text();
    if (response.ok) {
      return { tokenUrl: attempt.tokenUrl, parsed: text ? JSON.parse(text) : {} };
    }
    errors.push(`${attempt.name} ${attempt.tokenUrl} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  throw new Error(`Tastytrade OAuth refresh failed. ${errors.join(' | ')}`);
}

function oauthTokenUrls(config = {}) {
  return [...new Set([
    process.env.TASTYTRADE_TOKEN_URL || '',
    'https://api.tastytrade.com/oauth/token',
    'https://api.tastytrade.com/oauth2/token',
    'https://api.tastyworks.com/oauth/token',
    'https://api.tastyworks.com/oauth2/token',
    `${tastytradeBaseUrl(config)}/oauth/token`
  ].filter(Boolean))];
}

function oauthHeaders(contentType) {
  return {
    'content-type': contentType,
    accept: 'application/json',
    'user-agent': process.env.TASTYTRADE_USER_AGENT || 'slv-terminal/1.0'
  };
}

function normalizeOAuthTokenResponse(parsed) {
  const data = parsed.data || parsed;
  return {
    access_token: data.access_token || data.accessToken || data['access-token'],
    refresh_token: data.refresh_token || data.refreshToken || data['refresh-token'],
    token_type: data.token_type || data.tokenType || data['token-type'] || 'Bearer',
    expires_in: data.expires_in || data.expiresIn || data['expires-in'],
    raw: parsed
  };
}

function tastytradeBaseUrl(config = {}) {
  if (process.env.TASTYTRADE_API_BASE_URL) return process.env.TASTYTRADE_API_BASE_URL;
  return (config.tastytradeEnvironment || 'production') === 'production'
    ? 'https://api.tastyworks.com'
    : 'https://api.cert.tastyworks.com';
}

function tastytradeBaseUrls(config = {}) {
  const configured = process.env.TASTYTRADE_API_BASE_URL || '';
  const candidates = (process.env.TASTYTRADE_API_BASE_URLS || '')
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);
  if (configured) candidates.push(configured);
  if ((config.tastytradeEnvironment || 'production') === 'production') {
    candidates.push('https://api.tastyworks.com', 'https://api.tastytrade.com');
  } else {
    candidates.push('https://api.cert.tastyworks.com');
  }
  return [...new Set(candidates)];
}

function apiHeaders(extra = {}) {
  return {
    accept: 'application/json',
    'user-agent': process.env.TASTYTRADE_USER_AGENT || 'slv-terminal/1.0',
    ...extra
  };
}

function oauthRedirectUri() {
  return process.env.TASTYTRADE_REDIRECT_URI || `http://${host}:${port}/auth/tastytrade/callback`;
}

async function connectDxLink(config, symbols) {
  closeDxLink('Reconnecting');
  live.connecting = true;
  live.connected = false;
  live.mode = 'dxlink';
  live.lastError = null;
  live.requestedSymbols = symbols;
  live.status = 'Requesting Tastytrade quote token...';
  broadcast(await terminalPayload());
  const client = tastytradeClient(config);
  const quoteToken = await client.quoteToken();
  const token = quoteToken.token || quoteToken['streamer-token'] || quoteToken.streamerToken;
  const streamerUrl = quoteToken['dxlink-url'] || quoteToken.dxlinkUrl || quoteToken['streamer-url'] || quoteToken.streamerUrl || 'wss://tasty-openapi-ws.dxfeed.com/realtime';
  if (!token) throw new Error('Tastytrade quote token response did not include a streamer token.');
  if (typeof WebSocket !== 'function') throw new Error('This Node runtime does not expose WebSocket. Use Node 22+ or install a WebSocket runtime.');
  live.token = token;
  live.streamerUrl = streamerUrl;
  const wsUrl = process.env.TASTYTRADE_STREAM_TOKEN_IN_QUERY === 'TRUE'
    ? (streamerUrl.includes('?') ? `${streamerUrl}&token=${encodeURIComponent(token)}` : `${streamerUrl}?token=${encodeURIComponent(token)}`)
    : streamerUrl;
  const ws = new WebSocket(wsUrl);
  live.dxlink = ws;
  live.status = 'Connecting DXLink...';
  ws.addEventListener('open', () => {
    live.connecting = false;
    live.connected = true;
    live.status = 'DXLink socket open; setting up...';
    dxSend(ws, { type: 'SETUP', channel: 0, version: '0.1-DXF-JS/0.3.0', keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 });
    broadcastSoon();
  });
  ws.addEventListener('message', event => handleDxMessage(event.data));
  ws.addEventListener('error', event => {
    live.connecting = false;
    live.connected = false;
    live.lastError = event?.message || event?.type || 'WebSocket error';
    live.status = `DXLink error: ${live.lastError}`;
    broadcastSoon();
  });
  ws.addEventListener('close', event => {
    live.connecting = false;
    live.connected = false;
    live.lastError = event?.reason || (event?.code ? `close ${event.code}` : live.lastError);
    if (live.status.startsWith('DXLink live') || live.status.includes('socket open')) live.status = `DXLink disconnected${live.lastError ? `: ${live.lastError}` : ''}`;
    broadcastSoon();
  });
}

function dxSend(ws, value) {
  ws.send(JSON.stringify(value));
}

function handleDxMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  live.lastMessageType = msg.type || null;
  if (msg.type === 'KEEPALIVE') {
    if (live.dxlink?.readyState === 1) dxSend(live.dxlink, { type: 'KEEPALIVE', channel: 0 });
    return;
  }
  if (msg.type === 'SETUP') {
    live.status = 'DXLink setup complete; authorizing...';
    if (live.dxlink?.readyState === 1) dxSend(live.dxlink, { type: 'AUTH', channel: 0, token: live.token });
    broadcastSoon();
    return;
  }
  if (msg.type === 'AUTH_STATE') {
    const authState = msg.state || msg.status || '';
    if (String(authState).toUpperCase() === 'AUTHORIZED') {
      live.status = 'DXLink authorized; opening feed...';
      if (live.dxlink?.readyState === 1) dxSend(live.dxlink, { type: 'CHANNEL_REQUEST', channel: 1, service: 'FEED', parameters: { contract: 'AUTO' } });
    } else {
      live.lastError = `AUTH_STATE ${authState || JSON.stringify(msg)}`;
      live.status = `DXLink auth state: ${authState || 'unknown'}`;
    }
    broadcastSoon();
    return;
  }
  if (msg.type === 'CHANNEL_OPENED' && Number(msg.channel) === 1) {
    subscribeDxFeed();
    return;
  }
  if (msg.type === 'ERROR' || msg.type === 'CHANNEL_CLOSED') {
    live.lastError = msg.error || msg.message || msg.reason || JSON.stringify(msg);
    live.status = `DXLink ${msg.type}: ${live.lastError}`;
    broadcastSoon();
    return;
  }
  if (msg.type === 'FEED_DATA' && Array.isArray(msg.data)) {
    for (const row of msg.data) applyDxRow(row);
    live.lastEventAt = new Date().toISOString();
    live.status = 'DXLink live';
    broadcastSoon();
  }
}

function subscribeDxFeed() {
  if (live.dxlink?.readyState !== 1) return;
  live.status = `DXLink live: ${live.requestedSymbols.join(', ')}`;
  dxSend(live.dxlink, {
    type: 'FEED_SETUP',
    channel: 1,
    acceptAggregationPeriod: 0.1,
      acceptDataFormat: 'COMPACT',
      acceptEventFields: {
        Quote: ['eventType', 'eventSymbol', 'bidPrice', 'askPrice', 'bidSize', 'askSize'],
        Trade: ['eventType', 'eventSymbol', 'price', 'size', 'dayVolume'],
        Summary: ['eventType', 'eventSymbol', 'dayOpenPrice', 'dayHighPrice', 'dayLowPrice', 'prevDayClosePrice', 'openInterest'],
        Greeks: ['eventType', 'eventSymbol', 'price', 'volatility', 'delta', 'gamma', 'theta', 'rho', 'vega']
      }
    });
  dxSend(live.dxlink, { type: 'FEED_SUBSCRIPTION', channel: 1, add: live.requestedSymbols.flatMap(symbol => ['Quote', 'Trade', 'Summary', 'Greeks'].map(type => ({ type, symbol }))) });
  broadcastSoon();
}

function applyDxRow(row) {
  const type = row[0];
  const symbol = row[1];
  if (!symbol) return;
  const quote = live.symbols[symbol] || {};
  if (type === 'Trade') {
    quote.last = numberOrNull(row[2]) ?? quote.last;
    quote.lastSize = numberOrNull(row[3]) ?? quote.lastSize;
    quote.volume = numberOrNull(row[4]) ?? quote.volume;
    updateLiveSession(symbol, quote.last, quote.lastSize);
  }
  if (type === 'Quote') {
    quote.bid = numberOrNull(row[2]) ?? quote.bid;
    quote.ask = numberOrNull(row[3]) ?? quote.ask;
    quote.bidSize = numberOrNull(row[4]) ?? quote.bidSize;
    quote.askSize = numberOrNull(row[5]) ?? quote.askSize;
  }
  if (type === 'Summary') {
    quote.open = numberOrNull(row[2]) ?? quote.open;
    quote.high = numberOrNull(row[3]) ?? quote.high;
    quote.low = numberOrNull(row[4]) ?? quote.low;
    quote.prevClose = numberOrNull(row[5]) ?? quote.prevClose;
    quote.openInterest = numberOrNull(row[6]) ?? quote.openInterest;
  }
  if (type === 'Greeks') {
    quote.greeksPrice = numberOrNull(row[2]) ?? quote.greeksPrice;
    quote.iv = normalizeIv(row[3]) ?? quote.iv;
    quote.delta = numberOrNull(row[4]) ?? quote.delta;
    quote.gamma = numberOrNull(row[5]) ?? quote.gamma;
    quote.theta = numberOrNull(row[6]) ?? quote.theta;
    quote.rho = numberOrNull(row[7]) ?? quote.rho;
    quote.vega = numberOrNull(row[8]) ?? quote.vega;
  }
  quote.updatedAt = new Date().toISOString();
  live.symbols[symbol] = quote;
}

function closeDxLink(reason) {
  if (live.dxlink) {
    try { live.dxlink.close(); } catch {}
  }
  live.dxlink = null;
  live.connected = false;
  live.connecting = false;
  live.token = null;
  live.status = reason || 'DXLink stopped';
}

function applyLiveQuotesToInputs(state) {
  const slv = live.symbols.SLV;
  if (slv) {
    const slvMid = Number.isFinite(slv.bid) && Number.isFinite(slv.ask) ? round2((slv.bid + slv.ask) / 2) : null;
    if (Number.isFinite(slv.last)) state.inputs.slvPrice = slv.last;
    else if (slvMid !== null) state.inputs.slvPrice = slvMid;
    if (Number.isFinite(slv.volume)) state.inputs.slvVolume = slv.volume;
    if (Number.isFinite(slv.high)) state.inputs.dayHigh = slv.high;
    if (Number.isFinite(slv.low)) state.inputs.dayLow = slv.low;
    if (Number.isFinite(slv.prevClose)) state.inputs.priorSlvClose = slv.prevClose;
  }
  if (Number.isFinite(live.session.slvVwapShares) && live.session.slvVwapShares > 0) {
    state.inputs.vwap = round2(live.session.slvVwapDollars / live.session.slvVwapShares);
  }
  if (Number.isFinite(live.session.slvOpeningRangeHigh)) state.inputs.openingRangeHigh = live.session.slvOpeningRangeHigh;
  if (Number.isFinite(live.session.slvOpeningRangeLow)) state.inputs.openingRangeLow = live.session.slvOpeningRangeLow;
  const optionQuote = firstLiveSymbol(optionStreamerSymbols(state.inputs));
  if (optionQuote) {
    if (Number.isFinite(optionQuote.bid)) state.inputs.optionBid = optionQuote.bid;
    if (Number.isFinite(optionQuote.ask)) state.inputs.optionAsk = optionQuote.ask;
  }
}

function updateLiveSession(symbol, price, size) {
  if (symbol !== 'SLV' || !Number.isFinite(price)) return;
  const shares = Number.isFinite(size) && size > 0 ? size : 1;
  live.session.slvVwapDollars += price * shares;
  live.session.slvVwapShares += shares;
  const minutes = easternMinutes();
  if (minutes >= 570 && minutes <= 585) {
    live.session.slvOpeningRangeHigh = live.session.slvOpeningRangeHigh === null ? price : Math.max(live.session.slvOpeningRangeHigh, price);
    live.session.slvOpeningRangeLow = live.session.slvOpeningRangeLow === null ? price : Math.min(live.session.slvOpeningRangeLow, price);
  }
}

function firstLiveSymbol(symbols) {
  for (const symbol of symbols) {
    if (live.symbols[symbol]) return live.symbols[symbol];
  }
  return null;
}

function liveSnapshot() {
  return {
    connected: live.connected,
    connecting: live.connecting,
    mode: live.mode,
    status: live.status,
    lastError: live.lastError,
    lastMessageType: live.lastMessageType,
    lastEventAt: live.lastEventAt,
    requestedSymbols: live.requestedSymbols,
    session: live.session,
    symbols: live.symbols
  };
}

function eventStream(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  const client = { res };
  sseClients.add(client);
  terminalPayload().then(payload => sendEvent(client, payload)).catch(() => {});
  req.on('close', () => sseClients.delete(client));
}

function broadcast(payload) {
  for (const client of sseClients) sendEvent(client, payload);
}

let broadcastTimer = null;
function broadcastSoon() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    try {
      broadcast(await terminalPayload());
    } catch {}
  }, 150);
}

function sendEvent(client, payload) {
  try {
    client.res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    sseClients.delete(client);
  }
}

function extractItems(response, keys) {
  if (Array.isArray(response)) return response;
  for (const key of keys) if (Array.isArray(response[key])) return response[key];
  return [];
}

function marketStatus(date = new Date()) {
  const parts = easternParts(date);
  const weekday = parts.find(p => p.type === 'weekday').value;
  if (weekday === 'Sat' || weekday === 'Sun') return 'CLOSED';
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = Number(parts.find(p => p.type === 'minute').value);
  const minutes = hour * 60 + minute;
  if (minutes < 570) return 'PREMARKET';
  if (minutes <= 960) return 'OPEN';
  return 'CLOSED';
}

function easternMinutes(date = new Date()) {
  const parts = easternParts(date);
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = Number(parts.find(p => p.type === 'minute').value);
  return hour * 60 + minute;
}

function easternParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(date);
}

function nextScheduledUpdate() {
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const times = ['08:00', '09:00', '09:45', '14:00', '15:00', '15:45'];
  for (const t of times) {
    const candidate = new Date(`${today}T${t}:00-04:00`);
    if (candidate > now) return `${today} ${t} ET`;
  }
  return 'Next trading day 08:00 ET';
}

function buildChart(log) {
  return (log || []).slice(-80).map(row => ({
    time: row.timestamp,
    spot: row.silverSpot,
    slv: row.slvPrice,
    volume: row.slvVolume,
    bull: row.bullTrigger,
    bear: row.bearTrigger
  }));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function sendFile(res, filePath, type) {
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    sendJson(res, { error: 'File not found' }, 404);
  }
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Silver / SLV Play Finder</title><style>body{font-family:system-ui;background:#070b14;color:#e5edf7;padding:32px;line-height:1.45}a{color:#67e8f9}pre{white-space:pre-wrap;background:#101827;border:1px solid #263244;border-radius:8px;padding:16px}</style></head><body>${html}</body></html>`);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function applyCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '86400');
}

function contentType(filePath) {
  return filePath.endsWith('.css') ? 'text/css' : filePath.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeDiv(a, b) {
  return b ? a / b : 0;
}

function average(values = []) {
  const clean = values.map(numberOrNull).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function roundNickel(n) {
  return round2(Math.round(n / 0.05) * 0.05);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function trimTrailingZeros(value) {
  return String(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
}
