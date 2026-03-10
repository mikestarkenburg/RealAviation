import streamDeck from "@elgato/streamdeck";

/**
 * A single delay program (GDP, ground stop, closure, or arrival/departure delay)
 */
export interface DelayProgram {
  type: string;       // 'Ground Delay', 'Ground Stop', 'Closure', 'Departure Delay', etc.
  reason?: string;
  avgDelay?: string;  // e.g., "55 minutes"
  maxDelay?: string;  // e.g., "1 hour and 24 minutes"
}

/**
 * Enhanced delay statistics from AeroAPI
 */
export interface AeroApiDelayStats {
  delayedDepartures: number;
  delayedArrivals: number;
  cancelledDepartures: number;
  cancelledArrivals: number;
  totalDelayed: number;
  totalCancelled: number;
  avgDepartureDelay: string | null;  // e.g., "45 min"
  avgArrivalDelay: string | null;
}

/**
 * Aggregated delay info for a single airport
 */
export interface DelayInfo {
  airport: string;
  status: 'ok' | 'delay' | 'groundstop' | 'closure';
  programs: DelayProgram[];
  // Enhanced data from AeroAPI (optional)
  aeroApiStats: AeroApiDelayStats | null;
  dataSource: 'faa' | 'hybrid';
}

/**
 * Service for fetching airport delay status
 * Primary: FAA NAS Status API (free, no auth)
 * Enhanced: FlightAware AeroAPI (requires API key)
 */
export class DelayService {
  private logger = streamDeck.logger.createScope("DelayService");
  private readonly FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
  private readonly AERO_URL = 'https://aeroapi.flightaware.com/aeroapi';

  /**
   * Get delay status for a specific airport (FAA only — free)
   */
  async getFaaDelays(icaoCode: string): Promise<DelayInfo> {
    const iataCode = icaoCode.startsWith('K') && icaoCode.length === 4
      ? icaoCode.substring(1)
      : icaoCode;

    try {
      const response = await fetch(this.FAA_URL, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        this.logger.error(`FAA API error: ${response.status}`);
        return { airport: icaoCode, status: 'ok', programs: [], aeroApiStats: null, dataSource: 'faa' };
      }

      const text = await response.text();
      let data: any;

      try {
        data = JSON.parse(text);
      } catch {
        return this.parseTextResponse(icaoCode, iataCode, text);
      }

      return this.parseJsonResponse(icaoCode, iataCode, data);
    } catch (error) {
      this.logger.error(`Error fetching FAA delays: ${error}`);
      return { airport: icaoCode, status: 'ok', programs: [], aeroApiStats: null, dataSource: 'faa' };
    }
  }

  /**
   * Get enhanced delay data from AeroAPI
   * Uses GET /airports/delays (global endpoint, $0.05/call)
   * Filters results for the specified airport
   */
  async getAeroApiDelays(icaoCode: string, apiKey: string): Promise<AeroApiDelayStats | null> {
    if (!apiKey) return null;

    const iataCode = icaoCode.startsWith('K') && icaoCode.length === 4
      ? icaoCode.substring(1)
      : icaoCode;

    try {
      const url = `${this.AERO_URL}/airports/delays`;
      const response = await fetch(url, {
        headers: { 'x-apikey': apiKey }
      });

      if (!response.ok) {
        this.logger.error(`AeroAPI delays error: ${response.status} ${response.statusText}`);
        return null;
      }

      const json: any = await response.json();
      return this.parseAeroApiResponse(icaoCode, iataCode, json);
    } catch (error) {
      this.logger.error(`AeroAPI delays error: ${error}`);
      return null;
    }
  }

  /**
   * Get combined delay info (FAA + AeroAPI)
   */
  async getCombinedDelays(
    icaoCode: string,
    faaInfo: DelayInfo,
    apiKey: string
  ): Promise<DelayInfo> {
    const stats = await this.getAeroApiDelays(icaoCode, apiKey);
    if (!stats) return faaInfo;

    const combined: DelayInfo = { ...faaInfo, aeroApiStats: stats, dataSource: 'hybrid' };

    // If FAA says OK but AeroAPI shows significant delays, upgrade status
    if (combined.status === 'ok' && stats.totalDelayed > 5) {
      combined.status = 'delay';
      combined.programs.push({
        type: 'Flight Delays',
        reason: `${stats.totalDelayed} delayed, ${stats.totalCancelled} cancelled`,
        avgDelay: stats.avgDepartureDelay || undefined
      });
    }

    return combined;
  }

  // ── AeroAPI Response Parsing ──────────────────────────────────

  private parseAeroApiResponse(
    icaoCode: string,
    iataCode: string,
    data: any
  ): AeroApiDelayStats | null {
    // AeroAPI /airports/delays returns an array of airport delay entries
    // Each entry has: airport, num_delays, category, etc.
    const delays: any[] = data?.delays || data || [];

    if (!Array.isArray(delays)) {
      this.logger.warn('AeroAPI delays: unexpected response format');
      return null;
    }

    let delayedDep = 0;
    let delayedArr = 0;
    let cancelledDep = 0;
    let cancelledArr = 0;
    let avgDepDelay: number | null = null;
    let avgArrDelay: number | null = null;

    for (const entry of delays) {
      // Match airport by ICAO or IATA code
      const entryAirport = (
        entry.airport || entry.airport_code || entry.id || ''
      ).toUpperCase();
      const entryIata = (entry.iata || entry.airport_iata || '').toUpperCase();

      const matches = entryAirport === icaoCode.toUpperCase()
        || entryAirport === iataCode.toUpperCase()
        || entryIata === iataCode.toUpperCase();

      if (!matches) continue;

      // Parse the delay entry
      const category = (entry.category || entry.type || entry.delay_type || '').toLowerCase();
      const numDelays = entry.num_delays || entry.delayed || entry.count || 0;
      const numCancelled = entry.num_cancellations || entry.cancelled || 0;
      const avgDelaySec = entry.average_delay || entry.avg_delay || null;

      if (category.includes('depart') || category.includes('outbound')) {
        delayedDep += numDelays;
        cancelledDep += numCancelled;
        if (avgDelaySec != null) avgDepDelay = avgDelaySec;
      } else if (category.includes('arriv') || category.includes('inbound')) {
        delayedArr += numDelays;
        cancelledArr += numCancelled;
        if (avgDelaySec != null) avgArrDelay = avgDelaySec;
      } else {
        // Generic delay entry
        delayedDep += Math.ceil(numDelays / 2);
        delayedArr += Math.floor(numDelays / 2);
        cancelledDep += Math.ceil(numCancelled / 2);
        cancelledArr += Math.floor(numCancelled / 2);
        if (avgDelaySec != null && avgDepDelay == null) avgDepDelay = avgDelaySec;
      }
    }

    const totalDelayed = delayedDep + delayedArr;
    const totalCancelled = cancelledDep + cancelledArr;

    // If airport not found in the response, it has no significant delays
    if (totalDelayed === 0 && totalCancelled === 0) {
      return {
        delayedDepartures: 0,
        delayedArrivals: 0,
        cancelledDepartures: 0,
        cancelledArrivals: 0,
        totalDelayed: 0,
        totalCancelled: 0,
        avgDepartureDelay: null,
        avgArrivalDelay: null
      };
    }

    return {
      delayedDepartures: delayedDep,
      delayedArrivals: delayedArr,
      cancelledDepartures: cancelledDep,
      cancelledArrivals: cancelledArr,
      totalDelayed,
      totalCancelled,
      avgDepartureDelay: avgDepDelay != null ? this.formatSeconds(avgDepDelay) : null,
      avgArrivalDelay: avgArrDelay != null ? this.formatSeconds(avgArrDelay) : null
    };
  }

  private formatSeconds(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  // ── FAA JSON Response Parsing ────────────────────────────────

  private parseJsonResponse(icaoCode: string, iataCode: string, data: any): DelayInfo {
    const programs: DelayProgram[] = [];
    let worstStatus: DelayInfo['status'] = 'ok';

    const delayTypes = data?.airport_status_information?.delay_types
      || data?.delay_types
      || [];

    for (const delayType of delayTypes) {
      // Ground Delay Programs
      const gdpList = delayType.ground_delay_list || delayType.Ground_Delay_List || [];
      for (const gdp of (Array.isArray(gdpList) ? gdpList : [gdpList])) {
        if (!gdp) continue;
        const arpt = (gdp.arpt || gdp.ARPT || '').toUpperCase();
        if (arpt === iataCode.toUpperCase()) {
          programs.push({
            type: 'Ground Delay',
            reason: gdp.reason || gdp.Reason,
            avgDelay: gdp.avg || gdp.Avg,
            maxDelay: gdp.max || gdp.Max
          });
          if (worstStatus === 'ok') worstStatus = 'delay';
        }
      }

      // Ground Stops
      const gsList = delayType.ground_stop_list || delayType.Ground_Stop_List || [];
      for (const gs of (Array.isArray(gsList) ? gsList : [gsList])) {
        if (!gs) continue;
        const arpt = (gs.arpt || gs.ARPT || '').toUpperCase();
        if (arpt === iataCode.toUpperCase()) {
          programs.push({
            type: 'Ground Stop',
            reason: gs.reason || gs.Reason
          });
          if (worstStatus !== 'closure') worstStatus = 'groundstop';
        }
      }

      // Airport Closures
      const clList = delayType.airport_closure_list || delayType.Airport_Closure_List || [];
      for (const cl of (Array.isArray(clList) ? clList : [clList])) {
        if (!cl) continue;
        const arpt = (cl.arpt || cl.ARPT || '').toUpperCase();
        if (arpt === iataCode.toUpperCase()) {
          programs.push({
            type: 'Closure',
            reason: cl.reason || cl.Reason
          });
          worstStatus = 'closure';
        }
      }

      // Arrival/Departure Delays
      const dlList = delayType.delay_list || delayType.Delay_List || [];
      for (const dl of (Array.isArray(dlList) ? dlList : [dlList])) {
        if (!dl) continue;
        const arpt = (dl.arpt || dl.ARPT || '').toUpperCase();
        if (arpt === iataCode.toUpperCase()) {
          const dlType = dl.type || dl.Type || '';
          programs.push({
            type: dlType ? `${dlType} Delay` : 'Delay',
            reason: dl.reason || dl.Reason,
            avgDelay: dl.min && dl.max ? `${dl.min}-${dl.max}` : undefined
          });
          if (worstStatus === 'ok') worstStatus = 'delay';
        }
      }
    }

    return { airport: icaoCode, status: worstStatus, programs, aeroApiStats: null, dataSource: 'faa' };
  }

  // ── FAA Text/XML Fallback ────────────────────────────────────

  private parseTextResponse(icaoCode: string, iataCode: string, text: string): DelayInfo {
    const programs: DelayProgram[] = [];
    let worstStatus: DelayInfo['status'] = 'ok';

    const upperIata = iataCode.toUpperCase();

    if (!text.toUpperCase().includes(upperIata)) {
      return { airport: icaoCode, status: 'ok', programs: [], aeroApiStats: null, dataSource: 'faa' };
    }

    if (text.includes('Ground_Stop') || text.includes('ground_stop')) {
      const gsRegex = new RegExp(`<ARPT>${upperIata}</ARPT>[\\s\\S]*?<Reason>([^<]*)</Reason>`, 'i');
      const gsMatch = text.match(gsRegex);
      if (gsMatch) {
        programs.push({ type: 'Ground Stop', reason: gsMatch[1] });
        worstStatus = 'groundstop';
      }
    }

    if (text.includes('Ground_Delay') || text.includes('ground_delay')) {
      const gdpRegex = new RegExp(
        `<ARPT>${upperIata}</ARPT>[\\s\\S]*?<Avg>([^<]*)</Avg>[\\s\\S]*?<Reason>([^<]*)</Reason>`,
        'i'
      );
      const gdpMatch = text.match(gdpRegex);
      if (gdpMatch) {
        programs.push({ type: 'Ground Delay', avgDelay: gdpMatch[1], reason: gdpMatch[2] });
        if (worstStatus === 'ok') worstStatus = 'delay';
      }
    }

    if (text.includes('Closure') || text.includes('closure')) {
      const clRegex = new RegExp(`<ARPT>${upperIata}</ARPT>[\\s\\S]*?<Reason>([^<]*)</Reason>`, 'i');
      const clMatch = text.match(clRegex);
      if (clMatch) {
        programs.push({ type: 'Closure', reason: clMatch[1] });
        worstStatus = 'closure';
      }
    }

    if (programs.length === 0) {
      programs.push({ type: 'Delay', reason: 'Check FAA NAS Status for details' });
      worstStatus = 'delay';
    }

    return { airport: icaoCode, status: worstStatus, programs, aeroApiStats: null, dataSource: 'faa' };
  }
}

export const delayService = new DelayService();
