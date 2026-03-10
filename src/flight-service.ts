import streamDeck from "@elgato/streamdeck";

/**
 * Flight status data — unified interface for both AeroAPI and OpenSky
 */
export interface FlightStatusData {
  ident: string;
  status: string;          // "Scheduled", "En Route", "Taxiing", "Landed", "Cancelled", etc.
  origin: string | null;
  destination: string | null;
  registration: string | null;
  gateOrigin: string | null;
  gateDestination: string | null;
  terminalOrigin: string | null;
  terminalDestination: string | null;
  scheduledOut: string | null;   // gate departure (ISO)
  estimatedOut: string | null;
  actualOut: string | null;
  scheduledIn: string | null;    // gate arrival (ISO)
  estimatedIn: string | null;
  actualIn: string | null;
  departureDelay: number | null; // minutes
  arrivalDelay: number | null;   // minutes
  cancelled: boolean;
  diverted: boolean;
  progressPercent: number | null;
  // Position data (OpenSky only)
  altitude: number | null;       // feet
  speed: number | null;          // knots (ground speed)
  heading: number | null;        // degrees true
  verticalRate: number | null;   // ft/min
  // Data source indicator
  dataSource: 'aeroapi' | 'opensky';
}

/**
 * Service for flight status via FlightAware AeroAPI v4 or OpenSky Network fallback
 */
export class FlightService {
  private logger = streamDeck.logger.createScope("FlightService");
  private readonly AERO_URL = 'https://aeroapi.flightaware.com/aeroapi';
  private readonly OPENSKY_URL = 'https://opensky-network.org/api';

  // Cache for OpenSky icao24 lookups
  private icao24Cache: Map<string, string> = new Map();

  /**
   * Get flight status. Uses AeroAPI if apiKey provided, otherwise falls back to OpenSky.
   */
  async getFlightStatus(ident: string, apiKey: string): Promise<FlightStatusData | null> {
    if (!ident) return null;

    if (apiKey) {
      return this.getAeroApiStatus(ident, apiKey);
    }
    return this.getOpenSkyStatus(ident);
  }

  // ── AeroAPI (FlightAware) ──────────────────────────────────

  private async getAeroApiStatus(ident: string, apiKey: string): Promise<FlightStatusData | null> {
    try {
      const url = `${this.AERO_URL}/flights/${encodeURIComponent(ident)}`;
      const response = await fetch(url, {
        headers: { 'x-apikey': apiKey }
      });

      if (!response.ok) {
        this.logger.error(`AeroAPI error: ${response.status} ${response.statusText}`);
        return null;
      }

      const json: any = await response.json();
      const flights: any[] = json.flights;

      if (!flights || flights.length === 0) {
        this.logger.info(`No flights found for ${ident}`);
        return null;
      }

      const flight = this.pickRelevantFlight(flights);
      if (!flight) return null;

      return this.parseAeroApiFlight(flight);
    } catch (error) {
      this.logger.error(`AeroAPI error: ${error}`);
      return null;
    }
  }

  private pickRelevantFlight(flights: any[]): any {
    const active = flights.find((f: any) => {
      const s = (f.status || '').toLowerCase();
      return s.includes('en route') || s.includes('taxiing') || s === 'active';
    });
    if (active) return active;

    const now = new Date();
    const upcoming = flights
      .filter((f: any) => {
        const s = (f.status || '').toLowerCase();
        return (s.includes('scheduled') || s === 'filed') && !f.cancelled;
      })
      .filter((f: any) => {
        const dep = f.scheduled_out || f.estimated_out;
        return dep ? new Date(dep) >= new Date(now.getTime() - 2 * 60 * 60 * 1000) : true;
      })
      .sort((a: any, b: any) => {
        const aTime = a.scheduled_out || a.estimated_out || '';
        const bTime = b.scheduled_out || b.estimated_out || '';
        return aTime.localeCompare(bTime);
      });
    if (upcoming.length > 0) return upcoming[0];

    const cancelled = flights.find((f: any) => f.cancelled);
    if (cancelled) return cancelled;

    const landed = flights
      .filter((f: any) => {
        const s = (f.status || '').toLowerCase();
        return s.includes('landed') || s.includes('arrived');
      })
      .sort((a: any, b: any) => {
        const aTime = a.actual_in || a.actual_on || '';
        const bTime = b.actual_in || b.actual_on || '';
        return bTime.localeCompare(aTime);
      });
    if (landed.length > 0) return landed[0];

    return flights[0];
  }

  private parseAeroApiFlight(f: any): FlightStatusData {
    return {
      ident: f.ident || '',
      status: f.status || 'Unknown',
      origin: f.origin?.code_iata || f.origin?.code || null,
      destination: f.destination?.code_iata || f.destination?.code || null,
      registration: f.registration || null,
      gateOrigin: f.gate_origin || null,
      gateDestination: f.gate_destination || null,
      terminalOrigin: f.terminal_origin || null,
      terminalDestination: f.terminal_destination || null,
      scheduledOut: f.scheduled_out || null,
      estimatedOut: f.estimated_out || null,
      actualOut: f.actual_out || null,
      scheduledIn: f.scheduled_in || null,
      estimatedIn: f.estimated_in || null,
      actualIn: f.actual_in || null,
      departureDelay: f.departure_delay != null ? f.departure_delay : null,
      arrivalDelay: f.arrival_delay != null ? f.arrival_delay : null,
      cancelled: f.cancelled === true,
      diverted: f.diverted === true,
      progressPercent: f.progress_percent != null ? f.progress_percent : null,
      altitude: null,
      speed: null,
      heading: null,
      verticalRate: null,
      dataSource: 'aeroapi'
    };
  }

  // ── OpenSky Network (free, no API key) ─────────────────────

  private async getOpenSkyStatus(callsign: string): Promise<FlightStatusData | null> {
    try {
      const normalizedCallsign = callsign.trim().toUpperCase();
      let state: any[] | null = null;

      // Try cached icao24 first for efficiency
      const cachedIcao24 = this.icao24Cache.get(normalizedCallsign);
      if (cachedIcao24) {
        state = await this.fetchOpenSkyByIcao24(cachedIcao24);
        if (!state) {
          // Aircraft may have landed — clear cache and try full search
          this.icao24Cache.delete(normalizedCallsign);
        }
      }

      if (!state) {
        // Full search — expensive but necessary for first lookup
        const result = await this.fetchOpenSkyByCallsign(normalizedCallsign);
        if (!result) return null;
        state = result.state;
        this.icao24Cache.set(normalizedCallsign, result.icao24);
      }

      return this.parseOpenSkyState(state, normalizedCallsign);
    } catch (error) {
      this.logger.error(`OpenSky error: ${error}`);
      return null;
    }
  }

  private async fetchOpenSkyByCallsign(callsign: string): Promise<{ state: any[]; icao24: string } | null> {
    const response = await fetch(`${this.OPENSKY_URL}/states/all`);
    if (!response.ok) {
      this.logger.error(`OpenSky API error: ${response.status}`);
      return null;
    }

    const json: any = await response.json();
    if (!json.states || json.states.length === 0) return null;

    const state = json.states.find((s: any[]) =>
      (s[1] || '').trim().toUpperCase() === callsign
    );

    if (!state) {
      this.logger.info(`Callsign ${callsign} not found in ${json.states.length} states`);
      return null;
    }

    return { state, icao24: state[0] };
  }

  private async fetchOpenSkyByIcao24(icao24: string): Promise<any[] | null> {
    const response = await fetch(`${this.OPENSKY_URL}/states/all?icao24=${icao24.toLowerCase()}`);
    if (!response.ok) return null;

    const json: any = await response.json();
    if (!json.states || json.states.length === 0) return null;

    return json.states[0];
  }

  private parseOpenSkyState(state: any[], callsign: string): FlightStatusData {
    const altMeters = state[7];
    const speedMs = state[9];
    const vrateMs = state[11];
    const onGround = state[8];

    return {
      ident: callsign,
      status: onGround ? 'On Ground' : 'En Route',
      origin: null,
      destination: null,
      registration: null,
      gateOrigin: null,
      gateDestination: null,
      terminalOrigin: null,
      terminalDestination: null,
      scheduledOut: null,
      estimatedOut: null,
      actualOut: null,
      scheduledIn: null,
      estimatedIn: null,
      actualIn: null,
      departureDelay: null,
      arrivalDelay: null,
      cancelled: false,
      diverted: false,
      progressPercent: null,
      altitude: altMeters != null ? Math.round(altMeters * 3.28084) : null,
      speed: speedMs != null ? Math.round(speedMs * 1.94384) : null,
      heading: state[10] != null ? Math.round(state[10]) : null,
      verticalRate: vrateMs != null ? Math.round(vrateMs * 196.85) : null,
      dataSource: 'opensky'
    };
  }
}

export const flightService = new FlightService();
