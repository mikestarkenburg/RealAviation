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
 * Aggregated delay info for a single airport
 */
export interface DelayInfo {
  airport: string;
  status: 'ok' | 'delay' | 'groundstop' | 'closure';
  programs: DelayProgram[];
}

/**
 * Service for fetching FAA airport delay status
 * Uses the FAA NAS Status API (public, no auth required)
 * https://nasstatus.faa.gov/api/airport-status-information
 *
 * Returns all airports with active delay programs.
 * If an airport is not in the response, it has no delays.
 */
export class DelayService {
  private logger = streamDeck.logger.createScope("DelayService");
  private readonly BASE_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

  /**
   * Get delay status for a specific airport
   * @param icaoCode ICAO code (e.g., "KSFO") — will be converted to IATA for FAA lookup
   */
  async getAirportDelays(icaoCode: string): Promise<DelayInfo> {
    // Convert ICAO to IATA (strip leading K for US airports)
    const iataCode = icaoCode.startsWith('K') && icaoCode.length === 4
      ? icaoCode.substring(1)
      : icaoCode;

    try {
      const response = await fetch(this.BASE_URL, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        this.logger.error(`FAA API error: ${response.status}`);
        return { airport: icaoCode, status: 'ok', programs: [] };
      }

      // Try JSON first, fall back to text parsing
      const text = await response.text();
      let data: any;

      try {
        data = JSON.parse(text);
      } catch {
        // If not JSON, try to extract delay info from XML/text
        return this.parseTextResponse(icaoCode, iataCode, text);
      }

      return this.parseJsonResponse(icaoCode, iataCode, data);
    } catch (error) {
      this.logger.error(`Error fetching airport delays: ${error}`);
      return { airport: icaoCode, status: 'ok', programs: [] };
    }
  }

  /**
   * Parse JSON response from FAA NAS Status API
   */
  private parseJsonResponse(icaoCode: string, iataCode: string, data: any): DelayInfo {
    const programs: DelayProgram[] = [];
    let worstStatus: DelayInfo['status'] = 'ok';

    // Navigate the response structure
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

    return { airport: icaoCode, status: worstStatus, programs };
  }

  /**
   * Fallback: parse text/XML response by searching for the airport code
   */
  private parseTextResponse(icaoCode: string, iataCode: string, text: string): DelayInfo {
    const programs: DelayProgram[] = [];
    let worstStatus: DelayInfo['status'] = 'ok';

    const upperIata = iataCode.toUpperCase();

    // Check if this airport appears in any delay context
    if (!text.toUpperCase().includes(upperIata)) {
      return { airport: icaoCode, status: 'ok', programs: [] };
    }

    // Look for Ground Stop references
    if (text.includes('Ground_Stop') || text.includes('ground_stop')) {
      const gsRegex = new RegExp(`<ARPT>${upperIata}</ARPT>[\\s\\S]*?<Reason>([^<]*)</Reason>`, 'i');
      const gsMatch = text.match(gsRegex);
      if (gsMatch) {
        programs.push({ type: 'Ground Stop', reason: gsMatch[1] });
        worstStatus = 'groundstop';
      }
    }

    // Look for Ground Delay references
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

    // Look for Closure references
    if (text.includes('Closure') || text.includes('closure')) {
      const clRegex = new RegExp(`<ARPT>${upperIata}</ARPT>[\\s\\S]*?<Reason>([^<]*)</Reason>`, 'i');
      const clMatch = text.match(clRegex);
      if (clMatch) {
        programs.push({ type: 'Closure', reason: clMatch[1] });
        worstStatus = 'closure';
      }
    }

    // If we found the airport but couldn't parse specific programs, mark as delay
    if (programs.length === 0) {
      programs.push({ type: 'Delay', reason: 'Check FAA NAS Status for details' });
      worstStatus = 'delay';
    }

    return { airport: icaoCode, status: worstStatus, programs };
  }
}

export const delayService = new DelayService();
