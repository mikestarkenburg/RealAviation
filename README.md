# RealAviation for Stream Deck

Real aviation tools for pilots on Elgato Stream Deck. Four actions for monitoring ATIS, tracking flights, and checking airport delays.

## Actions

### ATIS - Single Airport
Displays ATIS information for one airport with flight category color coding. Press to cycle through details:
- **ATIS Letter** (with airport identifier)
- **Time** (Zulu or local)
- **Wind** (direction and speed on separate lines)
- **Visibility**
- **Sky Condition** (cloud layers)
- **Temperature / Dewpoint**
- **Altimeter** (formatted with decimal, e.g. 29.94)

Background color indicates flight category: green (VFR), blue (MVFR), red (IFR), magenta (LIFR).

### ATIS - Multiple Airports
Monitor ATIS letters across multiple airports. Short press cycles through your airport list. Long press opens the airport's ATIS page in your browser.

### Flight Tracker
Track any flight by flight number (UA1234) or tail number (N12345).

**Without an API key (free):** Uses OpenSky Network for live position data. Shows altitude, ground speed, heading, and vertical rate for airborne flights. No signup required.

**With a FlightAware AeroAPI key (enhanced):** Full flight status with three pages:
1. **Status** — ON TIME / DELAY / ENRTE / TAXI / ARRIVED / CXLD with configurable bottom line (departure time, date, or route)
2. **Departure** — Origin airport, departure time, terminal and gate
3. **Arrival** — Destination airport, arrival time, terminal and gate

Short press cycles pages. Long press opens the flight on FlightAware.

#### Getting an AeroAPI Key
1. Sign up at [flightaware.com/aeroapi](https://www.flightaware.com/aeroapi/portal)
2. Get your API key from the developer portal
3. Paste it into the "AeroAPI Key" field in the action settings

FlightAware provides approximately $5/month in free API credit (~100 queries). At the default 2-minute refresh rate, one 4-hour flight uses ~120 queries. Increase the refresh interval to 5-10 minutes to track more flights per month.

### Airport Delays
Shows FAA ground delay programs, ground stops, and airport closures. Press to cycle through status, reason, and delay time.

**Without an API key (free):** Uses the FAA NAS Status API to show formal Traffic Management Initiatives — Ground Delay Programs (GDP), Ground Stops, and airport closures. These are official FAA-imposed restrictions.

**With a FlightAware AeroAPI key (enhanced):** Also fetches flight-level delay data from FlightAware, showing how many individual flights are delayed or cancelled at the airport. This catches situations where flights are delayed but no formal FAA program is in effect. Press to cycle through an additional "FLIGHTS" page showing delay counts. AeroAPI refreshes on a separate, slower timer (default 15 min) to conserve API credits.

Colors: green (no delays), amber (ground delay program or flight delays), red (ground stop), dark red (closure).

## Setup

### Prerequisites
- Stream Deck v6.9+
- Node.js v20+
- Stream Deck CLI (`npm install -g @elgato/cli`)

### Install for Development
```bash
git clone https://github.com/mikestarkenburg/RealAviation.git
cd RealAviation
npm install
npm run build
streamdeck link com.starkenburg.atis.sdPlugin
streamdeck restart com.starkenburg.atis
```

### Build
```bash
npm run build
streamdeck restart com.starkenburg.atis
```

### Package for Distribution
```bash
streamdeck pack com.starkenburg.atis.sdPlugin
```

## Project Structure
```
RealAviation/
├── src/
│   ├── plugin.ts                # Entry point — registers all actions
│   ├── types.ts                 # Settings interfaces and constants
│   ├── atis-service.ts          # ATIS data from atis.info API
│   ├── flight-service.ts        # Flight data (AeroAPI + OpenSky fallback)
│   ├── delay-service.ts         # FAA NAS Status + AeroAPI delay client
│   ├── utils.ts                 # Shared utilities (XML escaping, URL opening)
│   └── actions/
│       ├── atis-display.ts      # Single airport ATIS
│       ├── atis-cycle.ts        # Multi-airport cycling
│       ├── flight-track.ts      # Flight tracker
│       └── airport-delay.ts     # Airport delay status
├── com.starkenburg.atis.sdPlugin/
│   ├── manifest.json
│   ├── ui/                      # Settings panels (sdpi-components v4)
│   └── static/imgs/             # Icons
├── package.json
├── tsconfig.json
└── rollup.config.mjs
```

## Data Sources

| Feature | Source | Auth Required | Cost |
|---------|--------|---------------|------|
| ATIS | atis.info | No | Free |
| Flight Tracking (basic) | OpenSky Network | No | Free (400 credits/day) |
| Flight Tracking (enhanced) | FlightAware AeroAPI v4 | API key | ~$5/mo free credit |
| Airport Delays (basic) | FAA NAS Status | No | Free |
| Airport Delays (enhanced) | FlightAware AeroAPI v4 | API key | ~$5/mo free credit |

## License

MIT License — See LICENSE file
