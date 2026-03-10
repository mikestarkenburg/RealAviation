import type { JsonValue } from "@elgato/utils";

/**
 * Flight category based on ceiling and visibility
 */
export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | 'UNKNOWN';

/**
 * Time format for ATIS effective time
 */
export type TimeFormat = 'zulu' | 'local';

/**
 * ATIS response from the API
 * NOTE: Verify this structure against actual atis.info API response
 */
export interface AtisResponse {
  airport: string;
  icao: string;
  atis_letter: string;
  effective_time: string; // ISO timestamp or Zulu time string
  flight_rules?: FlightCategory;
  wind?: string;
  visibility?: string;
  clouds?: string;
  temperature?: string;
  dewpoint?: string;
  altimeter?: string;
  raw_text?: string;
  metar?: string;
}

/**
 * Station info from /stations endpoint
 */
export interface StationInfo {
  icao: string;
  name: string;
  type?: string;
  [key: string]: JsonValue;
}

/**
 * Single Airport ATIS settings
 */
export interface AtisSettings {
  primaryAirport: string;
  timeFormat: TimeFormat;
  refreshInterval: number; // seconds
  [key: string]: JsonValue;
}

/**
 * Default single airport settings
 */
export const DEFAULT_SETTINGS: AtisSettings = {
  primaryAirport: 'KSFO',
  timeFormat: 'zulu',
  refreshInterval: 60
};

/**
 * Cycle Airports settings
 */
export interface CycleSettings {
  airportsStr: string; // comma-separated ICAO codes
  refreshInterval: number; // seconds
  [key: string]: JsonValue;
}

/**
 * Default cycle airports settings
 */
export const DEFAULT_CYCLE_SETTINGS: CycleSettings = {
  airportsStr: '',
  refreshInterval: 60
};

/**
 * Parse airports from comma-separated string
 */
export function parseAirportList(str: string): string[] {
  if (!str) return [];
  return str.split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length === 4 && /^[A-Z]{4}$/.test(s));
}

/**
 * Display state for single airport action
 */
export interface DisplayState {
  currentDetailIndex: number;
  lastFetch: number;
  cachedData: Map<string, AtisResponse>;
}

/**
 * Display state for cycle airports action
 */
export interface CycleDisplayState {
  currentAirportIndex: number;
  lastFetch: number;
  cachedData: Map<string, AtisResponse>;
}

/**
 * Detail fields to cycle through
 */
export const DETAIL_FIELDS = ['letter', 'time', 'wind', 'visibility', 'clouds', 'temperature', 'altimeter'] as const;
export type DetailField = typeof DETAIL_FIELDS[number];

/**
 * Bottom line display option for flight tracker status page
 */
export type FlightBottomLine = 'depTime' | 'date' | 'route';

/**
 * Flight Tracking settings (AeroAPI / FlightAware)
 */
export interface FlightTrackSettings {
  flightIdent: string;      // flight number (UA1234) or tail number (N12345)
  apiKey: string;           // FlightAware AeroAPI key
  timeFormat: TimeFormat;   // zulu or local
  bottomLine: FlightBottomLine; // what to show on bottom of status page
  refreshInterval: number;  // seconds
  [key: string]: JsonValue;
}

export const DEFAULT_FLIGHT_TRACK_SETTINGS: FlightTrackSettings = {
  flightIdent: '',
  apiKey: '',
  timeFormat: 'zulu',
  bottomLine: 'depTime',
  refreshInterval: 120 // 2 minutes (AeroAPI costs ~$0.05/query, ~$5/mo free credit)
};

/**
 * Airport Delay settings
 */
export interface AirportDelaySettings {
  airport: string;
  refreshInterval: number; // seconds
  [key: string]: JsonValue;
}

export const DEFAULT_DELAY_SETTINGS: AirportDelaySettings = {
  airport: 'KSFO',
  refreshInterval: 120 // 2 minutes
};

/**
 * Color mapping for flight categories
 */
export const FLIGHT_CATEGORY_COLORS: Record<FlightCategory, string> = {
  VFR: '#00AA00',    // Green
  MVFR: '#0066CC',   // Blue
  IFR: '#CC0000',    // Red
  LIFR: '#CC00CC',   // Magenta
  UNKNOWN: '#666666' // Gray
};
