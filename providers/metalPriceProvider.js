const DEFAULT_BASE_URL = 'https://api.metalpriceapi.com/v1';

export async function fetchMetalPriceSilver({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  slvPrice = null,
  expectedMin = 45,
  expectedMax = 75,
  timeoutMs = 5000,
  fetchImpl = fetch
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return invalidSilver({
      error: 'Missing METALPRICE_API_KEY',
      reason: 'MetalPriceAPI key is not configured',
      expectedMin,
      expectedMax
    });
  }

  const url = new URL(`${String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/latest`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('base', 'USD');
  url.searchParams.set('currencies', 'XAG');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 5000));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'slv-command-center/1.0'
      }
    });
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`MetalPriceAPI returned non-JSON response: ${text.slice(0, 160)}`);
    }
    if (!response.ok) {
      const info = parsed?.error?.info || parsed?.message || text.slice(0, 240);
      throw new Error(`HTTP ${response.status}: ${info}`);
    }
    if (parsed?.success === false) {
      const code = parsed?.error?.code ? `${parsed.error.code}: ` : '';
      throw new Error(`${code}${parsed?.error?.info || 'MetalPriceAPI request failed'}`);
    }
    return normalizeMetalPriceSilver(parsed, { slvPrice, expectedMin, expectedMax });
  } catch (error) {
    return invalidSilver({
      error: error.name === 'AbortError' ? 'MetalPriceAPI request timed out' : error.message,
      reason: 'MetalPriceAPI unavailable',
      expectedMin,
      expectedMax
    });
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeMetalPriceSilver(payload = {}, {
  slvPrice = null,
  expectedMin = 45,
  expectedMax = 75
} = {}) {
  const rates = payload.rates || {};
  const price = numberOrNull(rates.USDXAG)
    ?? (numberOrNull(rates.XAG) && numberOrNull(rates.XAG) > 0 ? 1 / numberOrNull(rates.XAG) : null);
  const timestamp = payload.timestamp ? new Date(Number(payload.timestamp) * 1000).toISOString() : new Date().toISOString();
  const silver = {
    source: 'MetalPriceAPI',
    provider: 'MetalPriceAPI',
    symbol: 'XAGUSD',
    price: price === null ? null : round4(price),
    change: null,
    changePct: null,
    priorClose: null,
    high: null,
    low: null,
    timestamp,
    valid: false,
    status: 'Silver feed invalid',
    reason: 'No MetalPriceAPI XAG/USD price returned',
    error: null,
    expectedRange: { min: expectedMin, max: expectedMax }
  };

  if (silver.price === null) return silver;
  if (silver.price < expectedMin || silver.price > expectedMax) {
    silver.reason = `Silver ${silver.price} outside expected ${expectedMin}-${expectedMax}`;
    return silver;
  }
  if (silver.price < 40 && numberOrNull(slvPrice) !== null && numberOrNull(slvPrice) > 45) {
    silver.reason = 'Silver below 40 while SLV is above 45';
    return silver;
  }

  silver.valid = true;
  silver.status = 'Silver valid';
  silver.reason = 'Validated inside expected range';
  return silver;
}

export function invalidSilver({
  error = null,
  reason = 'Silver feed invalid',
  expectedMin = 45,
  expectedMax = 75
} = {}) {
  return {
    source: 'MetalPriceAPI',
    provider: 'MetalPriceAPI',
    symbol: 'XAGUSD',
    price: null,
    change: null,
    changePct: null,
    priorClose: null,
    high: null,
    low: null,
    timestamp: new Date().toISOString(),
    valid: false,
    status: 'Silver feed invalid',
    reason,
    error,
    expectedRange: { min: expectedMin, max: expectedMax }
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}
