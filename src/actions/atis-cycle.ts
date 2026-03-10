import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent
} from "@elgato/streamdeck";
import { atisService } from "../atis-service";
import {
  CycleSettings,
  CycleDisplayState,
  DEFAULT_CYCLE_SETTINGS,
  FLIGHT_CATEGORY_COLORS,
  FlightCategory,
  parseAirportList
} from "../types";
import { escapeXml, toNumber, openUrl } from "../utils";

/** Long press threshold in milliseconds */
const LONG_PRESS_MS = 500;

@action({ UUID: "com.starkenburg.atis.cycle" })
export class AtisCycleAction extends SingletonAction<CycleSettings> {

  private logger = streamDeck.logger.createScope("AtisCycleAction");
  private displayStates: Map<string, CycleDisplayState> = new Map();
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private keyDownTimes: Map<string, number> = new Map();

  /**
   * Called when action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<CycleSettings>): Promise<void> {
    const settings = { ...DEFAULT_CYCLE_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    // Initialize display state
    this.displayStates.set(contextId, {
      currentAirportIndex: 0,
      lastFetch: 0,
      cachedData: new Map()
    });

    // Start refresh timer
    this.startRefreshTimer(contextId, ev, settings);

    // Initial fetch and display
    await this.refreshAndDisplay(contextId, ev, settings);
  }

  /**
   * Called when action disappears from the Stream Deck
   */
  override async onWillDisappear(ev: WillDisappearEvent<CycleSettings>): Promise<void> {
    const contextId = ev.action.id;

    // Clear refresh timer
    const timer = this.refreshTimers.get(contextId);
    if (timer) {
      clearInterval(timer);
      this.refreshTimers.delete(contextId);
    }

    // Clean up state
    this.displayStates.delete(contextId);
    this.keyDownTimes.delete(contextId);
  }

  /**
   * Called when settings are received/changed
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<CycleSettings>): Promise<void> {
    const settings = { ...DEFAULT_CYCLE_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    // Restart refresh timer with new interval
    this.startRefreshTimer(contextId, ev, settings);

    // Refresh display with new settings
    await this.refreshAndDisplay(contextId, ev, settings);
  }

  /**
   * Record key down timestamp for long press detection
   */
  override async onKeyDown(ev: KeyDownEvent<CycleSettings>): Promise<void> {
    this.keyDownTimes.set(ev.action.id, Date.now());
  }

  /**
   * On key up: short press cycles airports, long press opens browser
   */
  override async onKeyUp(ev: KeyUpEvent<CycleSettings>): Promise<void> {
    const settings = { ...DEFAULT_CYCLE_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;
    const state = this.displayStates.get(contextId);

    if (!state) return;

    const downTime = this.keyDownTimes.get(contextId) || Date.now();
    const duration = Date.now() - downTime;
    this.keyDownTimes.delete(contextId);

    if (duration >= LONG_PRESS_MS) {
      // Long press — open browser for current airport
      await this.openBrowser(settings, state);
    } else {
      // Short press — cycle to next airport
      await this.cycleAirport(contextId, ev, settings, state);
    }
  }

  /**
   * Cycle to the next airport in the list
   */
  private async cycleAirport(
    contextId: string,
    ev: KeyUpEvent<CycleSettings>,
    settings: CycleSettings,
    state: CycleDisplayState
  ): Promise<void> {
    const airports = parseAirportList(settings.airportsStr);

    if (airports.length <= 1) return;

    // Cycle to next airport
    state.currentAirportIndex = (state.currentAirportIndex + 1) % airports.length;
    await this.updateDisplay(contextId, ev, settings, state);
  }

  /**
   * Open browser to atis.info for current airport
   */
  private async openBrowser(settings: CycleSettings, state: CycleDisplayState): Promise<void> {
    const airports = parseAirportList(settings.airportsStr);
    const currentAirport = airports[state.currentAirportIndex];

    if (!currentAirport) return;

    const url = atisService.getAtisWebUrl(currentAirport);
    openUrl(url);
  }

  /**
   * Start or restart the refresh timer
   */
  private startRefreshTimer(
    contextId: string,
    ev: WillAppearEvent<CycleSettings> | DidReceiveSettingsEvent<CycleSettings>,
    settings: CycleSettings
  ): void {
    // Clear existing timer
    const existingTimer = this.refreshTimers.get(contextId);
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    // Set up new timer
    const interval = Math.max(toNumber(settings.refreshInterval, 60), 30) * 1000;
    const timer = setInterval(async () => {
      await this.refreshAndDisplay(contextId, ev, settings);
    }, interval);

    this.refreshTimers.set(contextId, timer);
  }

  /**
   * Fetch fresh ATIS data for all airports and update display
   */
  private async refreshAndDisplay(
    contextId: string,
    ev: WillAppearEvent<CycleSettings> | DidReceiveSettingsEvent<CycleSettings> | KeyUpEvent<CycleSettings>,
    settings: CycleSettings
  ): Promise<void> {
    const state = this.displayStates.get(contextId);
    if (!state) return;

    const airports = parseAirportList(settings.airportsStr);

    // Clear stale entries for airports no longer in the list
    for (const key of state.cachedData.keys()) {
      if (!airports.includes(key)) state.cachedData.delete(key);
    }

    // Fetch ATIS for all configured airports in parallel
    const results = await Promise.allSettled(
      airports.map(async (icao) => {
        const atis = await atisService.getAtis(icao);
        return { icao, atis };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.atis) {
        state.cachedData.set(result.value.icao, result.value.atis);
      }
    }

    state.lastFetch = Date.now();
    await this.updateDisplay(contextId, ev, settings, state);
  }

  /**
   * Update the Stream Deck key display
   */
  private async updateDisplay(
    contextId: string,
    ev: WillAppearEvent<CycleSettings> | DidReceiveSettingsEvent<CycleSettings> | KeyUpEvent<CycleSettings>,
    settings: CycleSettings,
    state: CycleDisplayState
  ): Promise<void> {
    const airports = parseAirportList(settings.airportsStr);

    if (airports.length === 0) {
      // No airports configured
      await ev.action.setImage(this.generateImage('?', 'UNKNOWN', '----'));
      return;
    }

    // Ensure index is in range
    if (state.currentAirportIndex >= airports.length) {
      state.currentAirportIndex = 0;
    }

    const currentAirport = airports[state.currentAirportIndex];
    const atis = state.cachedData.get(currentAirport);

    if (!atis) {
      // No data yet
      await ev.action.setImage(this.generateImage('?', 'UNKNOWN', currentAirport));
      return;
    }

    const image = this.generateImage(
      atis.atis_letter,
      atis.flight_rules || 'UNKNOWN',
      currentAirport
    );

    await ev.action.setImage(image);
  }

  /**
   * Generate SVG image — airport ID top-left, ATIS letter right-aligned
   * Same layout as the single-airport letter screen
   */
  private generateImage(
    letter: string,
    flightCategory: FlightCategory,
    airportId: string
  ): string {
    const bgColor = FLIGHT_CATEGORY_COLORS[flightCategory];

    // 288×288 canvas (2× resolution)
    const S = 288;
    const infoFontSize = 53;
    const mainFontSize = 182;

    // Content area (below airport ID)
    const contentTop = 62;
    const contentBottom = 276;
    const contentCenterY = (contentTop + contentBottom) / 2;

    // Letter baseline — vertically centered, shifted 5% lower
    const capHeight = Math.round(mainFontSize * 0.72);
    const mainBaseline = Math.round(contentCenterY + capHeight / 2) + 14;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
        <rect width="${S}" height="${S}" fill="${bgColor}"/>
        <text
          x="12"
          y="48"
          text-anchor="start"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${infoFontSize}"
          font-weight="bold"
          fill="white"
        >${escapeXml(airportId)}</text>
        <text
          x="${S - 12}"
          y="${mainBaseline}"
          text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${mainFontSize}"
          font-weight="bold"
          fill="white"
        >${escapeXml(letter)}</text>
      </svg>
    `;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

}
