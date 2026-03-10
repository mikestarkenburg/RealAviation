import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent
} from "@elgato/streamdeck";
import { delayService, DelayInfo } from "../delay-service";
import {
  AirportDelaySettings,
  DEFAULT_DELAY_SETTINGS
} from "../types";
import { escapeXml, toNumber } from "../utils";

/** Detail fields to cycle through */
const BASE_FIELDS = ['status', 'reason', 'time'] as const;
/** Extra fields when AeroAPI data is available */
const AERO_FIELDS = ['status', 'reason', 'time', 'flights'] as const;
type DelayField = 'status' | 'reason' | 'time' | 'flights';

/** Background colors by delay severity */
const DELAY_COLORS: Record<DelayInfo['status'], string> = {
  ok: '#00AA00',        // green
  delay: '#CC8800',     // amber
  groundstop: '#CC0000', // red
  closure: '#990000'    // dark red
};

/** Internal display state */
interface DelayDisplayState {
  currentFieldIndex: number;
  lastDelayInfo: DelayInfo | null;
  lastFaaFetch: number;
  lastAeroFetch: number;
}

@action({ UUID: "com.starkenburg.atis.delay" })
export class AirportDelayAction extends SingletonAction<AirportDelaySettings> {

  private logger = streamDeck.logger.createScope("AirportDelayAction");
  private displayStates: Map<string, DelayDisplayState> = new Map();
  private faaTimers: Map<string, NodeJS.Timeout> = new Map();
  private aeroTimers: Map<string, NodeJS.Timeout> = new Map();

  override async onWillAppear(ev: WillAppearEvent<AirportDelaySettings>): Promise<void> {
    const settings = { ...DEFAULT_DELAY_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    this.displayStates.set(contextId, {
      currentFieldIndex: 0,
      lastDelayInfo: null,
      lastFaaFetch: 0,
      lastAeroFetch: 0
    });

    this.startTimers(contextId, ev, settings);
    await this.refreshFaaAndDisplay(contextId, ev, settings);

    // Kick off AeroAPI fetch if key is configured
    if (settings.apiKey) {
      this.refreshAeroAndDisplay(contextId, ev, settings);
    }
  }

  override async onWillDisappear(ev: WillDisappearEvent<AirportDelaySettings>): Promise<void> {
    const contextId = ev.action.id;
    this.clearTimers(contextId);
    this.displayStates.delete(contextId);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AirportDelaySettings>): Promise<void> {
    const settings = { ...DEFAULT_DELAY_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    const state = this.displayStates.get(contextId);
    if (state) {
      state.currentFieldIndex = 0;
      state.lastDelayInfo = null;
    }

    this.startTimers(contextId, ev, settings);
    await this.refreshFaaAndDisplay(contextId, ev, settings);

    if (settings.apiKey) {
      this.refreshAeroAndDisplay(contextId, ev, settings);
    }
  }

  /**
   * Press cycles through delay detail fields
   */
  override async onKeyDown(ev: KeyDownEvent<AirportDelaySettings>): Promise<void> {
    const settings = { ...DEFAULT_DELAY_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;
    const state = this.displayStates.get(contextId);
    if (!state) return;

    const fields = state.lastDelayInfo?.aeroApiStats ? AERO_FIELDS : BASE_FIELDS;
    state.currentFieldIndex = (state.currentFieldIndex + 1) % fields.length;
    await this.updateDisplay(contextId, ev, settings, state);
  }

  // ── Timers ──────────────────────────────────────────────────

  private startTimers(
    contextId: string,
    ev: WillAppearEvent<AirportDelaySettings> | DidReceiveSettingsEvent<AirportDelaySettings>,
    settings: AirportDelaySettings
  ): void {
    this.clearTimers(contextId);

    // FAA timer (free data, fast refresh)
    const faaInterval = Math.max(toNumber(settings.refreshInterval, 120), 60) * 1000;
    const faaTimer = setInterval(async () => {
      await this.refreshFaaAndDisplay(contextId, ev, settings);
    }, faaInterval);
    this.faaTimers.set(contextId, faaTimer);

    // AeroAPI timer (costs credits, slow refresh)
    if (settings.apiKey) {
      const aeroInterval = Math.max(toNumber(settings.apiRefreshInterval, 900), 300) * 1000;
      const aeroTimer = setInterval(async () => {
        await this.refreshAeroAndDisplay(contextId, ev, settings);
      }, aeroInterval);
      this.aeroTimers.set(contextId, aeroTimer);
    }
  }

  private clearTimers(contextId: string): void {
    const faaTimer = this.faaTimers.get(contextId);
    if (faaTimer) { clearInterval(faaTimer); this.faaTimers.delete(contextId); }

    const aeroTimer = this.aeroTimers.get(contextId);
    if (aeroTimer) { clearInterval(aeroTimer); this.aeroTimers.delete(contextId); }
  }

  // ── Data Refresh ──────────────────────────────────────────

  private async refreshFaaAndDisplay(
    contextId: string,
    ev: WillAppearEvent<AirportDelaySettings> | DidReceiveSettingsEvent<AirportDelaySettings> | KeyDownEvent<AirportDelaySettings>,
    settings: AirportDelaySettings
  ): Promise<void> {
    const state = this.displayStates.get(contextId);
    if (!state) return;

    const airport = settings.airport.trim().toUpperCase();
    if (!airport) return;

    const faaInfo = await delayService.getFaaDelays(airport);

    // Preserve existing AeroAPI stats if we have them
    if (state.lastDelayInfo?.aeroApiStats) {
      faaInfo.aeroApiStats = state.lastDelayInfo.aeroApiStats;
      faaInfo.dataSource = 'hybrid';

      // Re-apply the upgrade logic
      if (faaInfo.status === 'ok' && faaInfo.aeroApiStats.totalDelayed > 5) {
        faaInfo.status = 'delay';
        // Only add the Flight Delays program if not already present
        if (!faaInfo.programs.some(p => p.type === 'Flight Delays')) {
          const stats = faaInfo.aeroApiStats;
          faaInfo.programs.push({
            type: 'Flight Delays',
            reason: `${stats.totalDelayed} delayed, ${stats.totalCancelled} cancelled`,
            avgDelay: stats.avgDepartureDelay || undefined
          });
        }
      }
    }

    state.lastDelayInfo = faaInfo;
    state.lastFaaFetch = Date.now();
    await this.updateDisplay(contextId, ev, settings, state);
  }

  private async refreshAeroAndDisplay(
    contextId: string,
    ev: WillAppearEvent<AirportDelaySettings> | DidReceiveSettingsEvent<AirportDelaySettings>,
    settings: AirportDelaySettings
  ): Promise<void> {
    const state = this.displayStates.get(contextId);
    if (!state || !settings.apiKey) return;

    const airport = settings.airport.trim().toUpperCase();
    if (!airport) return;

    // Get the current FAA info as base
    let info = state.lastDelayInfo;
    if (!info) {
      info = await delayService.getFaaDelays(airport);
    }

    // Merge with AeroAPI data
    const combined = await delayService.getCombinedDelays(airport, info, settings.apiKey);
    state.lastDelayInfo = combined;
    state.lastAeroFetch = Date.now();
    await this.updateDisplay(contextId, ev, settings, state);
  }

  // ── Display ──────────────────────────────────────────────

  private async updateDisplay(
    contextId: string,
    ev: WillAppearEvent<AirportDelaySettings> | DidReceiveSettingsEvent<AirportDelaySettings> | KeyDownEvent<AirportDelaySettings>,
    settings: AirportDelaySettings,
    state: DelayDisplayState
  ): Promise<void> {
    const airport = settings.airport.trim().toUpperCase() || '----';
    const info = state.lastDelayInfo;
    const fields = info?.aeroApiStats ? AERO_FIELDS : BASE_FIELDS;
    const field = fields[state.currentFieldIndex % fields.length];

    const bgColor = info ? DELAY_COLORS[info.status] : DELAY_COLORS.ok;
    const content = this.getFieldContent(info, field, airport);
    const image = this.generateImage(content.lines, bgColor, content.topLeft, content.label);
    await ev.action.setImage(image);
  }

  private getFieldContent(
    info: DelayInfo | null,
    field: DelayField,
    airport: string
  ): { lines: string[]; topLeft?: string; label?: string } {
    if (!info) {
      return { lines: ['---'], topLeft: airport };
    }

    switch (field) {
      case 'status': {
        const statusText = this.statusDisplayText(info);
        return { lines: [statusText], topLeft: airport };
      }

      case 'reason': {
        if (info.programs.length === 0) {
          return { lines: ['---'], label: 'REASON' };
        }
        const reason = info.programs[0].reason || 'Unknown';
        const lines = this.wrapText(reason, 12);
        return { lines, label: 'REASON' };
      }

      case 'time': {
        if (info.programs.length === 0) {
          return { lines: ['---'], label: 'DELAY' };
        }
        const program = info.programs[0];
        const timeLines: string[] = [program.type];
        if (program.avgDelay) {
          timeLines.push(this.abbreviateDelay(program.avgDelay));
        } else if (program.maxDelay) {
          timeLines.push(this.abbreviateDelay(program.maxDelay));
        }
        return { lines: timeLines, label: 'DELAY' };
      }

      case 'flights': {
        const stats = info.aeroApiStats;
        if (!stats) return { lines: ['---'], label: 'FLIGHTS' };

        const lines: string[] = [];
        if (stats.totalDelayed > 0) {
          lines.push(`${stats.totalDelayed} DLY`);
        }
        if (stats.totalCancelled > 0) {
          lines.push(`${stats.totalCancelled} CXL`);
        }
        if (stats.avgDepartureDelay) {
          lines.push(`AVG ${stats.avgDepartureDelay}`);
        }
        if (lines.length === 0) {
          lines.push('0 DLY');
        }
        return { lines, label: 'FLIGHTS' };
      }

      default:
        return { lines: ['---'] };
    }
  }

  private statusDisplayText(info: DelayInfo): string {
    switch (info.status) {
      case 'ok': return 'OK';
      case 'delay': {
        if (info.programs.length === 0) return 'DELAY';
        const type = info.programs[0].type.toLowerCase();
        if (type === 'flight delays') return 'DELAYS';
        if (type === 'ground delay') return 'GDP';
        return 'DELAY';
      }
      case 'groundstop': return 'STOP';
      case 'closure': return 'CLSD';
    }
  }

  /** Abbreviate delay string for small display */
  private abbreviateDelay(delay: string): string {
    let result = delay
      .replace(/\s*hours?\s*/gi, 'h ')
      .replace(/\s*minutes?\s*/gi, 'm')
      .replace(/\s*and\s*/gi, ' ')
      .trim();
    result = result.replace(/\s+/g, ' ');
    return result;
  }

  /** Wrap text into lines of max `maxChars` characters */
  private wrapText(text: string, maxChars: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      if (current.length + word.length + 1 > maxChars && current.length > 0) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);

    return lines.slice(0, 4);
  }

  /**
   * Generate SVG image for the key
   */
  private generateImage(
    lines: string[],
    bgColor: string,
    topLeft?: string,
    label?: string
  ): string {
    const S = 288;
    const infoFontSize = 53;

    let svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
        <rect width="${S}" height="${S}" fill="${bgColor}"/>
    `;

    if (topLeft) {
      svg += `
        <text x="12" y="48" text-anchor="start"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${infoFontSize}" font-weight="bold" fill="white"
        >${escapeXml(topLeft)}</text>
      `;
    }

    const contentTop = topLeft ? 62 : 12;
    const contentBottom = 276;

    if (label) {
      svg += `
        <text x="${S - 12}" y="${contentTop + 28}" text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="30" font-weight="bold" fill="white" fill-opacity="0.5"
        >${escapeXml(label)}</text>
      `;
    }

    const effectiveTop = label ? contentTop + 40 : contentTop;
    const effectiveHeight = contentBottom - effectiveTop;
    const effectiveCenterY = (effectiveTop + contentBottom) / 2;

    const lineCount = lines.length;
    const maxLen = Math.max(...lines.map(l => l.length));

    let fontSize: number;
    if (lineCount === 1) {
      if (maxLen <= 2) fontSize = 120;
      else if (maxLen <= 4) fontSize = 88;
      else if (maxLen <= 6) fontSize = 66;
      else fontSize = 52;
    } else if (lineCount === 2) {
      if (maxLen <= 5) fontSize = 62;
      else fontSize = 48;
    } else if (lineCount === 3) {
      fontSize = 42;
    } else {
      fontSize = 36;
    }

    const lineSpacing = fontSize * 1.2;
    const blockHeight = fontSize * 0.72 + (lineCount - 1) * lineSpacing;
    if (blockHeight > effectiveHeight * 0.95) {
      const scale = (effectiveHeight * 0.95) / blockHeight;
      fontSize = Math.floor(fontSize * scale);
    }

    const actualSpacing = fontSize * 1.2;
    const actualBlockHeight = fontSize * 0.72 + (lineCount - 1) * actualSpacing;
    const startBaseline = effectiveCenterY - actualBlockHeight / 2 + fontSize * 0.72;

    for (let i = 0; i < lines.length; i++) {
      const y = Math.round(startBaseline + i * actualSpacing);
      svg += `
        <text x="${S / 2}" y="${y}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${fontSize}" font-weight="bold" fill="white"
        >${escapeXml(lines[i])}</text>
      `;
    }

    svg += '</svg>';
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

}
