import streamDeck from "@elgato/streamdeck";
import type { AtisResponse, StationInfo, FlightCategory } from "./types";

const API_BASE = 'https://atis.info/api';

/**
 * Service for fetching ATIS data from atis.info API
 * 
 * API Response Format:
 * - GET /stations -> ["KABQ", "KADW", ...] (array of ICAO strings)
 * - GET /{ICAO} -> [{ airport, type, code, datis, time, updatedAt }]
 */
export class AtisService {
  private logger = streamDeck.logger.createScope("AtisService");

  /**
   * Fetch available stations from the API
   * Returns array of ICAO codes as station info objects
   */
  async getStations(): Promise<StationInfo[]> {
    try {
      const response = await fetch(`${API_BASE}/stations`);
      
      if (!response.ok) {
        this.logger.error(`Failed to fetch stations: ${response.status}`);
        return [];
      }

      const data = await response.json();
      
      // API returns simple array of ICAO strings: ["KABQ", "KADW", ...]
      if (Array.isArray(data)) {
        return data.map((icao: string) => ({
          icao: icao,
          name: icao // No name provided by API, use ICAO as name
        }));
      }

      this.logger.warn("Unexpected stations response format");
      return [];
    } catch (error) {
      this.logger.error(`Error fetching stations: ${error}`);
      return [];
    }
  }

  /**
   * Fetch ATIS for a specific airport
   * API returns array (may have multiple entries for split arrival/departure ATIS)
   */
  async getAtis(icao: string): Promise<AtisResponse | null> {
    try {
      const response = await fetch(`${API_BASE}/${icao.toUpperCase()}`);
      
      if (!response.ok) {
        this.logger.error(`Failed to fetch ATIS for ${icao}: ${response.status}`);
        return null;
      }

      const data = await response.json();
      
      if (!Array.isArray(data) || data.length === 0) {
        this.logger.warn(`No ATIS data for ${icao}`);
        return null;
      }

      // Prefer "combined" type, fall back to first entry
      const atisData = data.find((d: any) => d.type === 'combined') || data[0];
      
      return this.parseAtisResponse(icao, atisData);
    } catch (error) {
      this.logger.error(`Error fetching ATIS for ${icao}: ${error}`);
      return null;
    }
  }

  /**
   * Parse atis.info API response to our standard structure
   * 
   * Input format:
   * {
   *   "airport": "KSFO",
   *   "type": "combined",
   *   "code": "O",
   *   "datis": "SFO ATIS INFO O 2256Z. 00000KT 10SM OVC200 16/11 A3025...",
   *   "time": "2256",
   *   "updatedAt": "2026-01-30T23:54:14.6196197Z"
   * }
   */
  private parseAtisResponse(icao: string, data: any): AtisResponse {
    const datis = data.datis || '';
    const parsed = this.parseMetarFromDatis(datis);
    const flightRules = this.calculateFlightCategory(parsed.ceiling ?? null, parsed.visibility ?? null);

    return {
      airport: data.airport || icao,
      icao: data.airport || icao,
      atis_letter: (data.code || '?').toUpperCase(),
      effective_time: data.time || '',
      flight_rules: flightRules,
      wind: parsed.wind,
      visibility: parsed.visibilityStr,
      clouds: parsed.clouds,
      temperature: parsed.temperature,
      dewpoint: parsed.dewpoint,
      altimeter: parsed.altimeter,
      raw_text: datis,
      metar: parsed.metar
    };
  }

  /**
   * Parse METAR components from D-ATIS text
   * Example: "SFO ATIS INFO O 2256Z. 00000KT 10SM OVC200 16/11 A3025 (THREE ZERO TWO FIVE)..."
   */
  private parseMetarFromDatis(datis: string): {
    wind?: string;
    visibility?: number | null;
    visibilityStr?: string;
    ceiling?: number | null;
    clouds?: string;
    temperature?: string;
    dewpoint?: string;
    altimeter?: string;
    metar?: string;
  } {
    if (!datis) return {};

    const result: any = {};

    // Wind: 00000KT, 28012KT, 28012G20KT, VRB05KT
    const windMatch = datis.match(/\b((?:VRB|\d{3})\d{2,3}(?:G\d{2,3})?KT)\b/);
    if (windMatch) result.wind = windMatch[1];

    // Visibility: 10SM, 3SM, 1/2SM, 1 1/2SM, P6SM
    const visMatch = datis.match(/\b(P?\d+(?:\s+\d+)?(?:\/\d+)?\s*SM)\b/);
    if (visMatch) {
      result.visibilityStr = visMatch[1];
      result.visibility = this.parseVisibilityValue(visMatch[1]);
    }

    // Clouds: FEW020, SCT040, BKN050, OVC100, CLR, SKC
    const cloudMatches = datis.match(/\b((?:FEW|SCT|BKN|OVC)\d{3}|CLR|SKC)\b/gi);
    if (cloudMatches) {
      result.clouds = cloudMatches.join(' ');
      result.ceiling = this.parseCeilingFromClouds(cloudMatches);
    }

    // Temperature/Dewpoint: 16/11, M02/M05, 16/M01
    const tempMatch = datis.match(/\b(M?\d{2})\/(M?\d{2})\b/);
    if (tempMatch) {
      result.temperature = tempMatch[1].replace('M', '-');
      result.dewpoint = tempMatch[2].replace('M', '-');
    }

    // Altimeter: A3025, A2992
    const altMatch = datis.match(/\bA(\d{4})\b/);
    if (altMatch) {
      result.altimeter = `A${altMatch[1]}`;
    }

    // Extract approximate METAR portion (from wind to altimeter)
    if (result.wind && result.altimeter) {
      const metarMatch = datis.match(new RegExp(
        `${result.wind}.*?${result.altimeter}`,
        'i'
      ));
      if (metarMatch) {
        result.metar = metarMatch[0];
      }
    }

    return result;
  }

  /**
   * Parse visibility string to numeric statute miles
   */
  private parseVisibilityValue(visStr: string): number | null {
    if (!visStr) return null;

    // Remove SM suffix and P prefix
    let str = visStr.replace(/SM$/i, '').replace(/^P/, '').trim();

    // Handle mixed number like "1 1/2"
    if (str.includes(' ')) {
      const parts = str.split(' ');
      const whole = parseInt(parts[0], 10) || 0;
      const frac = this.parseFraction(parts[1]);
      return whole + frac;
    }

    // Handle fraction like "1/2"
    if (str.includes('/')) {
      return this.parseFraction(str);
    }

    // Simple integer
    return parseInt(str, 10) || null;
  }

  /**
   * Parse fraction string to decimal
   */
  private parseFraction(frac: string): number {
    const [num, den] = frac.split('/').map(Number);
    return den ? num / den : 0;
  }

  /**
   * Find lowest ceiling (BKN or OVC layer)
   */
  private parseCeilingFromClouds(cloudLayers: string[]): number | null {
    let lowestCeiling: number | null = null;

    for (const layer of cloudLayers) {
      const match = layer.match(/^(BKN|OVC)(\d{3})$/i);
      if (match) {
        const height = parseInt(match[2], 10) * 100; // Convert hundreds to feet
        if (lowestCeiling === null || height < lowestCeiling) {
          lowestCeiling = height;
        }
      }
    }

    return lowestCeiling;
  }

  /**
   * Calculate flight category based on ceiling and visibility
   * Uses FAA flight category definitions
   */
  private calculateFlightCategory(ceiling: number | null, visibility: number | null): FlightCategory {
    // LIFR: Ceiling < 500ft OR Visibility < 1SM
    if ((ceiling !== null && ceiling < 500) || (visibility !== null && visibility < 1)) {
      return 'LIFR';
    }

    // IFR: Ceiling 500-999ft OR Visibility 1-<3SM
    if ((ceiling !== null && ceiling < 1000) || (visibility !== null && visibility < 3)) {
      return 'IFR';
    }

    // MVFR: Ceiling 1000-3000ft OR Visibility 3-5SM
    if ((ceiling !== null && ceiling <= 3000) || (visibility !== null && visibility <= 5)) {
      return 'MVFR';
    }

    // VFR: Ceiling > 3000ft AND Visibility > 5SM (or unlimited)
    return 'VFR';
  }

  /**
   * Get the web URL for an airport's ATIS page
   */
  getAtisWebUrl(icao: string): string {
    return `https://atis.info/${icao.toUpperCase()}`;
  }
}

export const atisService = new AtisService();
