import streamDeck from "@elgato/streamdeck";

/**
 * Flight status data from FlightAware AeroAPI v4
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
}

/**
 * Service for flight status via FlightAware AeroAPI v4
 * https://www.flightaware.com/aeroapi/portal
 *
 * Auth: x-apikey header
 * Free tier: ~$5/month credit (~100 queries)
 */
export class FlightService {
  private logger = streamDeck.logger.createScope("FlightService");
  private readonly BASE_URL = 'https://aeroapi.flightaware.com/aeroapi';

  /**
   * Get flight status by flight number or tail/registration number.
   * AeroAPI auto-detects identifier type.
   * Returns the most relevant flight (upcoming or most recently active).
   */
  async getFlightStatus(ident: string, apiKey: string): Promise<FlightStatusData | null> {
    if (!ident || !apiKey) return null;

    try {
      const url = `${this.BASE_URL}/flights/${encodeURIComponent(ident)}`;
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

      // Pick the most relevant flight:
      // 1. Currently active (en route, taxiing)
      // 2. Next upcoming (scheduled, not yet departed)
      // 3. Most recently landed/arrived
      const flight = this.pickRelevantFlight(flights);
      if (!flight) return null;

      return this.parseFlight(flight);
    } catch (error) {
      this.logger.error(`Error fetching flight status: ${error}`);
      return null;
    }
  }

  /**
   * Pick the most relevant flight from the results array.
   * Priority: active > upcoming scheduled > most recent landed
   */
  private pickRelevantFlight(flights: any[]): any {
    // Active flights (en route, taxiing)
    const active = flights.find((f: any) => {
      const s = (f.status || '').toLowerCase();
      return s.includes('en route') || s.includes('taxiing') || s === 'active';
    });
    if (active) return active;

    // Upcoming scheduled flights (not yet departed, not cancelled)
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

    // Cancelled flights (show if nothing else)
    const cancelled = flights.find((f: any) => f.cancelled);
    if (cancelled) return cancelled;

    // Most recently landed
    const landed = flights
      .filter((f: any) => {
        const s = (f.status || '').toLowerCase();
        return s.includes('landed') || s.includes('arrived');
      })
      .sort((a: any, b: any) => {
        const aTime = a.actual_in || a.actual_on || '';
        const bTime = b.actual_in || b.actual_on || '';
        return bTime.localeCompare(aTime); // most recent first
      });
    if (landed.length > 0) return landed[0];

    // Fallback: first result
    return flights[0];
  }

  private parseFlight(f: any): FlightStatusData {
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
      progressPercent: f.progress_percent != null ? f.progress_percent : null
    };
  }
}

export const flightService = new FlightService();
