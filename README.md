# Silver / SLV Play Finder

Local live dashboard for SLV weekly options trading. The current working app is the Node dashboard in `local_app/`.

## Start

Run:

```bash
./start-terminal.command
```

The launcher opens:

```text
http://127.0.0.1:8788
```

Use the local server URL for live data. Opening `local_app/public/index.html` directly can show the interface, but live API calls and dropdown updates are most reliable through `http://127.0.0.1:8788`.

## Live Data Architecture

```text
MetalPriceAPI -> market.silver
Tastytrade/DXLink -> market.slv + market.options + positions
Normalized market object -> Strategy Engine -> Play Finder
```

- MetalPriceAPI is used for silver spot only.
- Tastytrade/DXLink is used for SLV quotes, options, Greeks, and positions.
- `.env`, tokens, account data, logs, and local runtime state are intentionally excluded.

## Review Package

See `PROJECT_REVIEW_SUMMARY.md` for the ChatGPT review notes and file map.

This is a trading workflow tool, not financial advice.
