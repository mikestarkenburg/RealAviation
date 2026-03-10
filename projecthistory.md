# RealAviation — Project History

## Origin

This project started as a simple ATIS display for Elgato Stream Deck — a single key that shows the current ATIS letter for an airport with flight category color coding (VFR/MVFR/IFR/LIFR). It was originally called "streamdeck-atis" and used the atis.info API as its only data source.

## Evolution to RealAviation

Over several development sessions, the plugin grew from one action into a full aviation toolkit with four distinct Stream Deck actions. The repo was renamed from "streamdeck-atis" to "RealAviation" to reflect the broader scope.

## Development Timeline

### Phase 1 — ATIS Foundation
- Built the **ATIS Single Airport** action: displays ATIS letter, time, wind, visibility, sky condition, temperature/dewpoint, and altimeter
- Press cycles through each detail field
- Background color reflects flight category (green/blue/red/magenta)
- Built the **ATIS Multi-Airport** action: cycles through multiple airports showing their ATIS letters
- Long press opens the airport's ATIS page in a browser
- Data source: atis.info API (free, no auth)

### Phase 2 — Flight Tracker (OpenSky)
- Added the **Flight Tracker** action using OpenSky Network as a free data source
- Shows live position data for airborne flights: altitude, ground speed, heading, vertical rate
- No API key required, uses OpenSky's public REST API (400 credits/day)

### Phase 3 — Flight Tracker (AeroAPI Upgrade)
- Researched flight data APIs: AviationStack, AeroDataBox, AirLabs, AeroAPI
- Selected FlightAware AeroAPI v4 as the enhanced data source
- Rewrote the flight service to support both data sources:
  - **Without API key**: OpenSky Network (free, position data only)
  - **With AeroAPI key**: Full flight status, schedule, gates, terminals
- Supports both flight numbers (UA1234) and tail numbers (N12345)

### Phase 4 — Flight Tracker Enhancements
- Added **3-page cycling** for AeroAPI mode:
  1. Status page (ON TIME / DELAY / ENRTE / TAXI / ARRIVED / CXLD)
  2. Departure page (origin airport, departure time, terminal/gate)
  3. Arrival page (destination airport, arrival time, terminal/gate)
- Added **2-page cycling** for OpenSky mode:
  1. Status page (altitude or ON GND, ground speed)
  2. Position page (heading, vertical rate, ground speed)
- Added **long press** to open the flight on FlightAware in a browser
- Added **local/Zulu time** setting
- Added **configurable bottom line** on status page: departure time, date (MAR 07), or route (SFO → JFK)
- Implemented long press detection via onKeyDown/onKeyUp timing (500ms threshold)

### Phase 5 — Airport Delays
- Built the **Airport Delays** action using the FAA NAS Status API
- Shows formal Traffic Management Initiatives: Ground Delay Programs (GDP), Ground Stops, closures
- Press cycles through status, reason, and delay time
- Color-coded: green (OK), amber (GDP), red (ground stop), dark red (closure)

### Phase 6 — Polish and GitHub
- Created unique SVG icons for each action (airplane silhouette for flight tracker, warning triangle for delays)
- Added loading states ("LOADING"), error states ("SETUP", "NO FLT")
- Rewrote README with full documentation
- Updated manifest.json (name, version, tooltips, icon paths)
- Initialized git repo, flattened directory structure, pushed to GitHub
- Renamed GitHub repo from streamdeck-atis to RealAviation

### Phase 7 — Hybrid Airport Delays (AeroAPI Enhancement)
- Investigated why the delay key showed "OK" when FlightAware's MiseryMap showed delays at airports
- Root cause: FAA NAS Status API only reports formal TMIs, not individual flight delays
- Implemented hybrid approach:
  - **Without API key (free)**: FAA NAS Status API — catches GDPs, ground stops, closures
  - **With AeroAPI key (enhanced)**: Also fetches flight-level delay data from FlightAware
  - Shows count of delayed/cancelled flights when no formal TMI is active
  - Separate, slower refresh timer for AeroAPI (default 15 min) to conserve credits
  - Added "FLIGHTS" page showing delay and cancellation counts
- Updated settings panel with optional AeroAPI key and API refresh interval

### Phase 8 — Code Review and Marketplace Prep
- Full codebase review identified 29 issues across all source files
- **Security fixes**: Removed debug logging and Node.js debug mode from production, replaced `exec` shell commands with `execFile` to prevent command injection
- **Reliability fixes**: Added settings value coercion (string → number) to prevent NaN timer intervals, fixed ATIS parser returning VFR instead of UNKNOWN when no weather data available, fixed zero visibility incorrectly parsed as null, fixed delay status showing "GDP" for non-GDP delay programs
- **Code quality**: Extracted shared `escapeXml`, `toNumber`, `openUrl` utilities to `utils.ts`, eliminating duplication across 4 action files. Fixed unescaped regex in METAR extraction. Added M-prefix handling for visibility (M1/4SM)
- **Performance**: Changed sequential ATIS fetches in multi-airport mode to parallel (`Promise.allSettled`), added stale cache cleanup when airport list changes
- **Offline support**: Bundled sdpi-components.js locally instead of loading from CDN, so settings panels work without internet
- **Metadata**: Synced version numbers between package.json and manifest.json, updated package name and description

## Architecture

- **Runtime**: Elgato Stream Deck SDK v2 with TypeScript and TC39 decorators
- **Build**: Rollup bundler, outputs to `com.starkenburg.atis.sdPlugin/bin/plugin.js`
- **Display**: SVG images generated in code (288x288 canvas), rendered as base64 data URIs
- **Settings UI**: sdpi-components v4 web components
- **Data pattern**: Each action has its own service class and display state management, with independent refresh timers per key instance

## Data Sources

| Feature | Source | Auth | Cost |
|---------|--------|------|------|
| ATIS | atis.info | None | Free |
| Flight Tracking (basic) | OpenSky Network | None | Free (400 credits/day) |
| Flight Tracking (enhanced) | FlightAware AeroAPI v4 | API key | ~$5/mo free credit |
| Airport Delays (basic) | FAA NAS Status | None | Free |
| Airport Delays (enhanced) | FlightAware AeroAPI v4 | API key | ~$5/mo free credit |
