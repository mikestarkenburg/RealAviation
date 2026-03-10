import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  KeyUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent
} from "@elgato/streamdeck";
import { exec } from "child_process";
import { flightService, FlightStatusData } from "../flight-service";
import {
  FlightTrackSettings,
  DEFAULT_FLIGHT_TRACK_SETTINGS,
  TimeFormat
} from "../types";

/** Long press threshold in milliseconds */
const LONG_PRESS_MS = 500;

/** Display pages for AeroAPI mode */
const AERO_PAGES = ['status', 'departure', 'arrival'] as const;
/** Display pages for OpenSky mode (position data only) */
const OPENSKY_PAGES = ['status', 'position'] as const;

/** Background colors by flight phase */
const PHASE_COLORS = {
  onTime: '#00AA00',      // green
  delayed: '#CC8800',     // amber
  cancelled: '#CC0000',   // red
  active: '#2277CC',      // blue
  landed: '#00AA00',      // green
  diverted: '#CC0000',    // red
  unknown: '#666666'      // gray
};

/** Internal display state */
interface TrackDisplayState {
  currentPage: number;
  lastData: FlightStatusData | null;
  lastFetch: number;
  loading: boolean;
}

@action({ UUID: "com.starkenburg.atis.flighttrack" })
export class FlightTrackAction extends SingletonAction<FlightTrackSettings> {

  private logger = streamDeck.logger.createScope("FlightTrackAction");
  private displayStates: Map<string, TrackDisplayState> = new Map();
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private keyDownTimes: Map<string, number> = new Map();

  override async onWillAppear(ev: WillAppearEvent<FlightTrackSettings>): Promise<void> {
    const settings = { ...DEFAULT_FLIGHT_TRACK_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    this.displayStates.set(contextId, {
      currentPage: 0,
      lastData: null,
      lastFetch: 0,
      loading: true
    });

    // Show loading state immediately
    await ev.action.setImage(this.generateStatusImage('----', 'LOADING', null, PHASE_COLORS.unknown));

    this.startRefreshTimer(contextId, ev, settings);
    await this.refreshAndDisplay(contextId, ev, settings);
  }

  override async onWillDisappear(ev: WillDisappearEvent<FlightTrackSettings>): Promise<void> {
    const contextId = ev.action.id;
    const timer = this.refreshTimers.get(contextId);
    if (timer) {
      clearInterval(timer);
      this.refreshTimers.delete(contextId);
    }
    this.displayStates.delete(contextId);
    this.keyDownTimes.delete(contextId);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<FlightTrackSettings>): Promise<void> {
    const settings = { ...DEFAULT_FLIGHT_TRACK_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    const state = this.displayStates.get(contextId);
    if (state) {
      state.lastData = null;
      state.currentPage = 0;
      state.loading = true;
    }

    this.startRefreshTimer(contextId, ev, settings);
    await this.refreshAndDisplay(contextId, ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<FlightTrackSettings>): Promise<void> {
    this.keyDownTimes.set(ev.action.id, Date.now());
  }

  override async onKeyUp(ev: KeyUpEvent<FlightTrackSettings>): Promise<void> {
    const settings = { ...DEFAULT_FLIGHT_TRACK_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;
    const state = this.displayStates.get(contextId);
    if (!state) return;

    const downTime = this.keyDownTimes.get(contextId) || Date.now();
    const duration = Date.now() - downTime;
    this.keyDownTimes.delete(contextId);

    if (duration >= LONG_PRESS_MS) {
      await this.openFlightAware(settings);
    } else {
      const pageCount = state.lastData?.dataSource === 'opensky'
        ? OPENSKY_PAGES.length
        : AERO_PAGES.length;
      state.currentPage = (state.currentPage + 1) % pageCount;
      await this.updateDisplay(contextId, ev, settings, state);
    }
  }

  private async openFlightAware(settings: FlightTrackSettings): Promise<void> {
    const ident = settings.flightIdent.trim().toUpperCase();
    if (!ident) return;

    const url = `https://flightaware.com/live/flight/${encodeURIComponent(ident)}`;
    const command = process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

    exec(command, (error) => {
      if (error) this.logger.error(`Failed to open browser: ${error}`);
    });
  }

  private startRefreshTimer(
    contextId: string,
    ev: WillAppearEvent<FlightTrackSettings> | DidReceiveSettingsEvent<FlightTrackSettings>,
    settings: FlightTrackSettings
  ): void {
    const existingTimer = this.refreshTimers.get(contextId);
    if (existingTimer) clearInterval(existingTimer);

    const interval = Math.max(settings.refreshInterval, 60) * 1000;
    const timer = setInterval(async () => {
      await this.refreshAndDisplay(contextId, ev, settings);
    }, interval);

    this.refreshTimers.set(contextId, timer);
  }

  private async refreshAndDisplay(
    contextId: string,
    ev: WillAppearEvent<FlightTrackSettings> | DidReceiveSettingsEvent<FlightTrackSettings>,
    settings: FlightTrackSettings
  ): Promise<void> {
    const state = this.displayStates.get(contextId);
    if (!state) return;

    const ident = settings.flightIdent.trim().toUpperCase();
    if (!ident) {
      state.lastData = null;
      state.loading = false;
      await this.updateDisplay(contextId, ev, settings, state);
      return;
    }

    const data = await flightService.getFlightStatus(ident, settings.apiKey);
    state.lastData = data;
    state.lastFetch = Date.now();
    state.loading = false;
    await this.updateDisplay(contextId, ev, settings, state);
  }

  private async updateDisplay(
    contextId: string,
    ev: WillAppearEvent<FlightTrackSettings> | DidReceiveSettingsEvent<FlightTrackSettings> | KeyUpEvent<FlightTrackSettings>,
    settings: FlightTrackSettings,
    state: TrackDisplayState
  ): Promise<void> {
    const ident = settings.flightIdent.trim().toUpperCase() || '----';
    const data = state.lastData;
    const timeFormat = settings.timeFormat || 'zulu';

    if (state.loading) {
      await ev.action.setImage(this.generateStatusImage(ident, 'LOADING', null, PHASE_COLORS.unknown));
      return;
    }

    if (!data) {
      const msg = !settings.flightIdent.trim() ? 'SETUP' : 'NO FLT';
      await ev.action.setImage(this.generateStatusImage(ident, msg, null, PHASE_COLORS.unknown));
      return;
    }

    const bgColor = this.getPhaseColor(data);
    let image: string;

    if (data.dataSource === 'opensky') {
      // OpenSky mode: status + position pages
      const page = OPENSKY_PAGES[state.currentPage % OPENSKY_PAGES.length];
      switch (page) {
        case 'position':
          image = this.renderOpenSkyPositionPage(ident, data, bgColor);
          break;
        case 'status':
        default:
          image = this.renderOpenSkyStatusPage(ident, data, bgColor);
          break;
      }
    } else {
      // AeroAPI mode: status + departure + arrival pages
      const page = AERO_PAGES[state.currentPage % AERO_PAGES.length];
      switch (page) {
        case 'departure':
          image = this.renderDeparturePage(ident, data, bgColor, timeFormat);
          break;
        case 'arrival':
          image = this.renderArrivalPage(ident, data, bgColor, timeFormat);
          break;
        case 'status':
        default:
          image = this.renderStatusPage(ident, data, bgColor, settings);
          break;
      }
    }

    await ev.action.setImage(image);
  }

  // ── AeroAPI Page Renderers ──────────────────────────────────

  private renderStatusPage(
    ident: string,
    data: FlightStatusData,
    bgColor: string,
    settings: FlightTrackSettings
  ): string {
    const phase = this.determinePhase(data);
    const bottomText = this.getBottomLineText(data, settings);
    return this.generateStatusImage(ident, phase.statusText, bottomText, bgColor);
  }

  private renderDeparturePage(
    ident: string,
    data: FlightStatusData,
    bgColor: string,
    timeFormat: TimeFormat
  ): string {
    const airport = data.origin || '---';
    const bestTime = data.actualOut || data.estimatedOut || data.scheduledOut;
    const timeStr = bestTime ? this.formatTime(bestTime, timeFormat) : '--:--';

    let gateLine: string | null = null;
    const parts: string[] = [];
    if (data.terminalOrigin) parts.push(`T${data.terminalOrigin}`);
    if (data.gateOrigin) parts.push(`G${data.gateOrigin}`);
    if (parts.length > 0) gateLine = parts.join(' ');

    return this.generateDetailImage(ident, 'DEP', airport, timeStr, gateLine, bgColor);
  }

  private renderArrivalPage(
    ident: string,
    data: FlightStatusData,
    bgColor: string,
    timeFormat: TimeFormat
  ): string {
    const airport = data.destination || '---';
    const bestTime = data.actualIn || data.estimatedIn || data.scheduledIn;
    const timeStr = bestTime ? this.formatTime(bestTime, timeFormat) : '--:--';

    let gateLine: string | null = null;
    const parts: string[] = [];
    if (data.terminalDestination) parts.push(`T${data.terminalDestination}`);
    if (data.gateDestination) parts.push(`G${data.gateDestination}`);
    if (parts.length > 0) gateLine = parts.join(' ');

    return this.generateDetailImage(ident, 'ARR', airport, timeStr, gateLine, bgColor);
  }

  // ── OpenSky Page Renderers ─────────────────────────────────

  private renderOpenSkyStatusPage(
    ident: string,
    data: FlightStatusData,
    bgColor: string
  ): string {
    const statusLower = (data.status || '').toLowerCase();
    let statusText: string;
    let bottomText: string | null = null;

    if (statusLower.includes('en route') || statusLower.includes('airborne')) {
      statusText = data.altitude != null
        ? (data.altitude >= 18000 ? `FL${Math.round(data.altitude / 100)}` : data.altitude.toLocaleString())
        : 'AIRBORNE';
      if (data.speed != null) bottomText = `GS ${data.speed}KT`;
    } else {
      statusText = 'ON GND';
    }

    return this.generateStatusImage(ident, statusText, bottomText, bgColor);
  }

  private renderOpenSkyPositionPage(
    ident: string,
    data: FlightStatusData,
    bgColor: string
  ): string {
    const lines: string[] = [];

    if (data.heading != null) lines.push(`HDG ${String(data.heading).padStart(3, '0')}°`);
    if (data.verticalRate != null) {
      const sign = data.verticalRate >= 0 ? '+' : '';
      lines.push(`VS ${sign}${data.verticalRate}`);
    }
    if (data.speed != null) lines.push(`GS ${data.speed}KT`);

    const mainText = lines.length > 0 ? lines[0] : '---';
    const bottomText = lines.length > 1 ? lines[1] : null;

    return this.generateStatusImage(ident, mainText, bottomText, bgColor);
  }

  // ── Phase / Status Logic ────────────────────────────────────

  private getPhaseColor(data: FlightStatusData): string {
    if (data.cancelled) return PHASE_COLORS.cancelled;
    if (data.diverted) return PHASE_COLORS.diverted;

    const s = (data.status || '').toLowerCase();
    if (s.includes('en route') || s === 'active' || s.includes('taxiing')) return PHASE_COLORS.active;
    if (s.includes('on ground')) return PHASE_COLORS.landed;
    if (s.includes('landed') || s.includes('arrived')) return PHASE_COLORS.landed;
    if (s.includes('scheduled') || s.includes('filed') || s === 'unknown') {
      const delay = data.departureDelay;
      if (delay != null && delay > 15) return PHASE_COLORS.delayed;
      return PHASE_COLORS.onTime;
    }
    return PHASE_COLORS.unknown;
  }

  private determinePhase(data: FlightStatusData): { statusText: string } {
    const statusLower = (data.status || '').toLowerCase();

    if (data.cancelled) return { statusText: 'CXLD' };
    if (data.diverted) return { statusText: 'DIVRT' };
    if (statusLower.includes('en route') || statusLower === 'active') return { statusText: 'ENRTE' };
    if (statusLower.includes('taxiing')) {
      return { statusText: statusLower.includes('in') ? 'TAXI IN' : 'TAXI' };
    }
    if (statusLower.includes('landed') || statusLower.includes('arrived')) return { statusText: 'ARRIVED' };

    if (statusLower.includes('scheduled') || statusLower.includes('filed') || statusLower === 'unknown') {
      const delay = data.departureDelay;
      if (delay != null && delay > 15) return { statusText: 'DELAY' };
      return { statusText: 'ON TIME' };
    }

    return { statusText: data.status.substring(0, 7).toUpperCase() };
  }

  private getBottomLineText(data: FlightStatusData, settings: FlightTrackSettings): string | null {
    const timeFormat = settings.timeFormat || 'zulu';

    switch (settings.bottomLine) {
      case 'date': {
        const depTime = data.scheduledOut || data.estimatedOut;
        if (!depTime) return null;
        try {
          const d = new Date(depTime);
          const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
          if (timeFormat === 'local') {
            return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
          }
          return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
        } catch {
          return null;
        }
      }

      case 'route': {
        const orig = data.origin || '???';
        const dest = data.destination || '???';
        return `${orig} → ${dest}`;
      }

      case 'depTime':
      default: {
        const depTime = data.estimatedOut || data.scheduledOut;
        if (!depTime) return null;
        return `DEP ${this.formatTime(depTime, timeFormat)}`;
      }
    }
  }

  // ── Time Formatting ─────────────────────────────────────────

  private formatTime(iso: string, timeFormat: TimeFormat): string {
    try {
      const d = new Date(iso);
      if (timeFormat === 'local') {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}L`;
      }
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return `${hh}:${mm}Z`;
    } catch {
      return '??:??';
    }
  }

  // ── SVG Image Generators ────────────────────────────────────

  private generateStatusImage(
    ident: string,
    statusText: string,
    bottomText: string | null,
    bgColor: string
  ): string {
    const S = 288;

    let svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
        <rect width="${S}" height="${S}" fill="${bgColor}"/>
    `;

    svg += `
      <text x="12" y="48" text-anchor="start"
        font-family="Arial, Helvetica, sans-serif"
        font-size="46" font-weight="bold" fill="white"
      >${this.escapeXml(ident)}</text>
    `;

    if (bottomText) {
      const statusZone = { top: 62, bottom: 200 };
      const bottomZone = { top: 200, bottom: 276 };

      const statusLen = statusText.length;
      let statusFontSize: number;
      if (statusLen <= 4) statusFontSize = 82;
      else if (statusLen <= 5) statusFontSize = 72;
      else if (statusLen <= 7) statusFontSize = 60;
      else if (statusLen <= 9) statusFontSize = 48;
      else statusFontSize = 40;

      const statusCenterY = (statusZone.top + statusZone.bottom) / 2;
      const statusCapH = Math.round(statusFontSize * 0.72);
      const statusBaseline = Math.round(statusCenterY + statusCapH / 2);

      svg += `
        <text x="${S / 2}" y="${statusBaseline}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${statusFontSize}" font-weight="bold" fill="white"
        >${this.escapeXml(statusText)}</text>
      `;

      const btLen = bottomText.length;
      let btFontSize: number;
      if (btLen <= 6) btFontSize = 38;
      else if (btLen <= 10) btFontSize = 34;
      else btFontSize = 28;

      const btCenterY = (bottomZone.top + bottomZone.bottom) / 2;
      const btCapH = Math.round(btFontSize * 0.72);
      const btBaseline = Math.round(btCenterY + btCapH / 2);

      svg += `
        <text x="${S / 2}" y="${btBaseline}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${btFontSize}" font-weight="bold" fill="white" fill-opacity="0.85"
        >${this.escapeXml(bottomText)}</text>
      `;
    } else {
      const contentTop = 62;
      const contentBottom = 276;
      const centerY = (contentTop + contentBottom) / 2;

      const len = statusText.length;
      let fontSize: number;
      if (len <= 4) fontSize = 90;
      else if (len <= 5) fontSize = 78;
      else if (len <= 7) fontSize = 64;
      else fontSize = 52;

      const capH = Math.round(fontSize * 0.72);
      const baseline = Math.round(centerY + capH / 2);

      svg += `
        <text x="${S / 2}" y="${baseline}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${fontSize}" font-weight="bold" fill="white"
        >${this.escapeXml(statusText)}</text>
      `;
    }

    svg += '</svg>';
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  private generateDetailImage(
    ident: string,
    label: string,
    airport: string,
    timeStr: string,
    gateLine: string | null,
    bgColor: string
  ): string {
    const S = 288;

    let svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
        <rect width="${S}" height="${S}" fill="${bgColor}"/>
    `;

    svg += `
      <text x="12" y="48" text-anchor="start"
        font-family="Arial, Helvetica, sans-serif"
        font-size="46" font-weight="bold" fill="white"
      >${this.escapeXml(ident)}</text>
    `;

    svg += `
      <text x="${S - 12}" y="48" text-anchor="end"
        font-family="Arial, Helvetica, sans-serif"
        font-size="30" font-weight="bold" fill="white" fill-opacity="0.5"
      >${this.escapeXml(label)}</text>
    `;

    if (gateLine) {
      const airportZone = { top: 62, bottom: 168 };
      const timeZone = { top: 168, bottom: 230 };
      const gateZone = { top: 230, bottom: 276 };

      const airportFontSize = 90;
      const airportCenterY = (airportZone.top + airportZone.bottom) / 2;
      const airportCapH = Math.round(airportFontSize * 0.72);
      const airportBaseline = Math.round(airportCenterY + airportCapH / 2);
      svg += `
        <text x="${S / 2}" y="${airportBaseline}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${airportFontSize}" font-weight="bold" fill="white"
        >${this.escapeXml(airport)}</text>
      `;

      const timeFontSize = 38;
      const timeCenterY = (timeZone.top + timeZone.bottom) / 2;
      const timeCapH = Math.round(timeFontSize * 0.72);
      const timeBaseline = Math.round(timeCenterY + timeCapH / 2);
      svg += `
        <text x="${S / 2}" y="${timeBaseline}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${timeFontSize}" font-weight="bold" fill="white" fill-opacity="0.85"
        >${this.escapeXml(timeStr)}</text>
      `;

      const gateFontSize = 28;
      const gateCenterY = (gateZone.top + gateZone.bottom) / 2;
      const gateCapH = Math.round(gateFontSize * 0.72);
      const gateBaseline = Math.round(gateCenterY + gateCapH / 2);
      svg += `
        <text x="${S / 2}" y="${gateBaseline}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${gateFontSize}" font-weight="bold" fill="white" fill-opacity="0.6"
        >${this.escapeXml(gateLine)}</text>
      `;
    } else {
      const airportZone = { top: 62, bottom: 190 };
      const timeZone = { top: 190, bottom: 276 };

      const airportFontSize = 100;
      const airportCenterY = (airportZone.top + airportZone.bottom) / 2;
      const airportCapH = Math.round(airportFontSize * 0.72);
      const airportBaseline = Math.round(airportCenterY + airportCapH / 2);
      svg += `
        <text x="${S / 2}" y="${airportBaseline}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${airportFontSize}" font-weight="bold" fill="white"
        >${this.escapeXml(airport)}</text>
      `;

      const timeFontSize = 42;
      const timeCenterY = (timeZone.top + timeZone.bottom) / 2;
      const timeCapH = Math.round(timeFontSize * 0.72);
      const timeBaseline = Math.round(timeCenterY + timeCapH / 2);
      svg += `
        <text x="${S / 2}" y="${timeBaseline}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${timeFontSize}" font-weight="bold" fill="white" fill-opacity="0.85"
        >${this.escapeXml(timeStr)}</text>
      `;
    }

    svg += '</svg>';
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
