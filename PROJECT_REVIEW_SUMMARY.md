# Silver / SLV Command Center - ChatGPT Review Package

Packaged: 2026-07-01

This project is a local Node.js trading dashboard for SLV options. It is designed around this provider flow:

```text
MetalPriceAPI -> market.silver
Tastytrade/DXLink -> market.slv + market.options + positions
Normalized market object -> Strategy Engine -> Play Finder -> Trade Plan -> Position Monitor
```

Secrets, tokens, account data, local state, and logs are intentionally excluded from the review package and GitHub upload.

## Sanitized File Tree

```text
.
├── .env.example
├── .gitignore
├── README.md
├── PROJECT_REVIEW_SUMMARY.md
├── package.json
├── start-terminal.command
├── local_app/
│   ├── server.mjs
│   ├── setup.mjs
│   ├── data/
│   │   └── state.json
│   └── public/
│       └── index.html
└── providers/
    └── metalPriceProvider.js
```

Excluded examples:

```text
.env
node_modules/
*.log
local_app/data/state.local.json
local_app/data/*.bak
set-tastytrade-password.command
set-tastytrade-refresh-token.command
.DS_Store
```

## Main Server File

`local_app/server.mjs`

Responsibilities:

- Local HTTP server on `127.0.0.1:8788`
- Static dashboard serving from `local_app/public/index.html`
- Server-sent event stream for live dashboard refreshes
- Tastytrade session / OAuth helper routes
- Tastytrade account positions
- SLV option chain loading and normalization
- DXLink live quote subscription
- MetalPriceAPI silver refresh orchestration through the provider module
- Normalized market object assembly
- Strategy engine calculations
- Position-management calculations
- Snapshot logging and lightweight backtesting foundation

Main routes:

```text
GET  /
GET  /api/state
GET  /api/events
GET  /api/silver
GET  /api/setup/status
GET  /api/auth/status
GET  /api/options/chain
POST /api/options/refresh
POST /api/options/select
POST /api/tastytrade/positions
POST /api/tastytrade/positions/select
POST /api/live/start
POST /api/live/stop
POST /api/inputs
POST /api/log
POST /api/reset
```

## Main Dashboard HTML / JS / CSS

`local_app/public/index.html`

This file currently contains the dashboard HTML, CSS, and browser-side JavaScript in one file. Browser-side state is centralized in `TradeState`. UI cards subscribe to `TradeState` and re-render after refreshes, option selections, position selections, and planning changes.

## Provider Files

`providers/metalPriceProvider.js`

Responsibilities:

- Fetch XAG/USD from MetalPriceAPI
- Normalize the response to `market.silver`
- Validate silver price against the configured expected range
- Reject invalid low silver prints, especially the incorrect roughly `$29` feed when SLV is in the `$50s`
- Return invalid silver objects without breaking the dashboard

## Strategy Engine Files

The strategy engine currently lives inside `local_app/server.mjs`. This is working, but it is the clearest next refactor candidate.

Important functions include:

```text
calculate()
calculateMarketState()
normalizedSilverFromProvider()
validateSilverPrice()
calculateDynamicRatio()
calculateImpliedSLV()
calculateOpeningRange()
calculateVWAP()
calculateATR()
calculateTriggers()
calculateVolumePace()
calculateTrendScore()
calculateMomentumScore()
calculateOptionsLiquidityScore()
calculateTrackingStatus()
calculateInstitutionalFlow()
calculateAllStrategies()
calculateBullishCallMomentumScore()
calculateVWAPBounceScore()
calculateBearishPutSpreadScore()
calculateBearishBreakdownScore()
calculateNoTradeScore()
calculatePositionManagementScore()
selectBestActiveSetup()
generateActionFromBestSetup()
generateStrategyWhyList()
calculateTradeScore()
calculateTradePlan()
calculateTradeMap()
calculateMissionControl()
generateAITradeBrainText()
```

Current evaluated setups:

```text
Bullish Call Momentum
VWAP Bounce / Reclaim
Bearish Put Spread
Bearish Breakdown
No Edge / Chop Zone
Manage Existing Position
```

## Option Chain Logic

Option chain logic is in `local_app/server.mjs`.

Important functions:

```text
refreshOptionChainIfNeeded()
optionChainPayload()
refreshOptionChain()
selectOption()
normalizeOptionChain()
collectOptionsFromNode()
optionLegFromNestedValue()
parseOptionSymbol()
enrichOptionChainWithLive()
getSelectedOption()
chooseDefaultOption()
calculateContractRecommendation()
scoreContractCandidate()
contractRejectionReasons()
calculateOptionProjection()
calculateTargetOdds()
```

Data source:

```text
Tastytrade option chain endpoint through the local tastytrade client
DXLink quotes for live bid/ask/mid/Greeks when available
```

## Position Management Logic

Position logic is in `local_app/server.mjs`.

Important functions:

```text
tastytradePositions()
selectTastytradePosition()
refreshPositionsIfNeeded()
calculatePositions()
applyPositionManagementToRows()
buildPositionManagement()
primaryManagedPosition()
managedPositionFromBase()
managedPositionFromOption()
enrichPosition()
normalizePositionRecord()
positionIndicators()
positionReason()
positionSymbolsForLive()
```

The app defaults to the largest open SLV position when no position is selected. Clicking a position stores a selected position key so Position Mission Control and Suggested Trade focus on that position.

## State JSON Structure

Default state is stored at:

```text
local_app/data/state.json
```

Local runtime state is stored separately and excluded:

```text
local_app/data/state.local.json
```

Sanitized default sections:

```text
inputs
config
optionChain
log
```

## Current `.env.example`

The included `.env.example` contains placeholders only. It intentionally does not include MetalPriceAPI keys, Tastytrade credentials, OAuth secrets, refresh tokens, session tokens, or account numbers.

Runtime URL defaults:

```text
HOST=127.0.0.1
PORT=8788
TASTYTRADE_REDIRECT_URI=http://127.0.0.1:8788/auth/tastytrade/callback
```

## Console / Server Errors Observed During Packaging

Checks run:

```bash
node --check local_app/server.mjs
SLV_TERMINAL_NO_SERVER=1 node local_app/server.mjs
```

Results:

- `node --check local_app/server.mjs` passed.
- `SLV_TERMINAL_NO_SERVER=1 node local_app/server.mjs` ran calculations successfully.
- In the Codex sandbox, MetalPriceAPI returned `fetch failed` because the sandbox has restricted network access.
- In the Codex sandbox, binding local ports can produce `EPERM`. Run from normal Mac Terminal using `./start-terminal.command`.

## How To Run Locally

Use:

```bash
./start-terminal.command
```

Then open:

```text
http://127.0.0.1:8788/
```

Do not commit `.env`.

## Review Notes

The main architectural improvement still available is to split `local_app/server.mjs` into dedicated modules:

```text
providers/
services/tastytradeClient.js
services/dxlinkClient.js
strategy/
options/
positions/
state/
routes/
```

The dashboard is functional but still evolving. The planning section and active-position section should remain visually and logically separate so current position management cannot be confused with future trade planning.
