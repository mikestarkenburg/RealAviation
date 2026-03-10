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

/** Detail fields to cycle through */
const DELAY_FIELDS = ['status', 'reason', 'time'] as const;
type DelayField = typeof DELAY_FIELDS[number];

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
  lastFetch: number;
}

@action({ UUID: "com.starkenburg.atis.delay" })
export class AirportDelayAction extends SingletonAction<AirportDelaySettings> {

  private logger = streamDeck.logger.createScope("AirportDelayAction");
  private displayStates: Map<string, DelayDisplayState> = new Map();
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();

  override async onWillAppear(ev: WillAppearEvent<AirportDelaySettings>): Promise<void> {
    const settings = { ...DEFAULT_DELAY_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    this.displayStates.set(contextId, {
      currentFieldIndex: 0,
      lastDelayInfo: null,
      lastFetch: 0
    });

    this.startRefreshTimer(contextId, ev, settings);
    await this.refreshAndDisplay(contextId, ev, settings);
  }

  override async onWillDisappear(ev: WillDisappearEvent<AirportDelaySettings>): Promise<void> {
    const contextId = ev.action.id;
    const timer = this.refreshTimers.get(contextId);
    if (timer) {
      clearInterval(timer);
      this.refreshTimers.delete(contextId);
    }
    this.displayStates.delete(contextId);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AirportDelaySettings>): Promise<void> {
    const settings = { ...DEFAULT_DELAY_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    const state = this.displayStates.get(contextId);
    if (state) state.currentFieldIndex = 0;

    this.startRefreshTimer(contextId, ev, settings);
    await this.refreshAndDisplay(contextId, ev, settings);
  }

  /**
   * Press cycles through delay detail fields
   */
  override async onKeyDown(ev: KeyDownEvent<AirportDelaySettings>): Promise<void> {
    const settings = { ...DEFAULT_DELAY_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;
    const state = this.displayStates.get(contextId);
    if (!state) return;

    state.currentFieldIndex = (state.currentFieldIndex + 1) % DELAY_FIELDS.length;
    await this.updateDisplay(contextId, ev, settings, state);
  }

  private startRefreshTimer(
    contextId: string,
    ev: WillAppearEvent<AirportDelaySettings> | DidReceiveSettingsEvent<AirportDelaySettings>,
    settings: AirportDelaySettings
  ): void {
    const existingTimer = this.refreshTimers.get(contextId);
    if (existingTimer) clearInterval(existingTimer);

    const interval = Math.max(settings.refreshInterval, 60) * 1000; // Minimum 60s
    const timer = setInterval(async () => {
      await this.refreshAndDisplay(contextId, ev, settings);
    }, interval);

    this.refreshTimers.set(contextId, timer);
  }

  private async refreshAndDisplay(
    contextId: string,
    ev: WillAppearEvent<AirportDelaySettings> | DidReceiveSettingsEvent<AirportDelaySettings> | KeyDownEvent<AirportDelaySettings>,
    settings: AirportDelaySettings
  ): Promise<void> {
    const state = this.displayStates.get(contextId);
    if (!state) return;

    const airport = settings.airport.trim().toUpperCase();
    if (airport) {
      const delayInfo = await delayService.getAirportDelays(airport);
      state.lastDelayInfo = delayInfo;
    }

    state.lastFetch = Date.now();
    await this.updateDisplay(contextId, ev, settings, state);
  }

  private async updateDisplay(
    contextId: string,
    ev: WillAppearEvent<AirportDelaySettings> | DidReceiveSettingsEvent<AirportDelaySettings> | KeyDownEvent<AirportDelaySettings>,
    settings: AirportDelaySettings,
    state: DelayDisplayState
  ): Promise<void> {
    const airport = settings.airport.trim().toUpperCase() || '----';
    const info = state.lastDelayInfo;
    const field = DELAY_FIELDS[state.currentFieldIndex];

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
        const statusText = this.statusDisplayText(info.status);
        return { lines: [statusText], topLeft: airport };
      }

      case 'reason': {
        if (info.programs.length === 0) {
          return { lines: ['---'], label: 'REASON' };
        }
        // Show reason from first (worst) program, wrap long text
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

      default:
        return { lines: ['---'] };
    }
  }

  private statusDisplayText(status: DelayInfo['status']): string {
    switch (status) {
      case 'ok': return 'OK';
      case 'delay': return 'GDP';
      case 'groundstop': return 'STOP';
      case 'closure': return 'CLSD';
    }
  }

  /** Abbreviate delay string for small display (e.g., "1 hour and 24 minutes" → "1h 24m") */
  private abbreviateDelay(delay: string): string {
    let result = delay
      .replace(/\s*hours?\s*/gi, 'h ')
      .replace(/\s*minutes?\s*/gi, 'm')
      .replace(/\s*and\s*/gi, ' ')
      .trim();
    // Collapse whitespace
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

    // Limit to 4 lines max
    return lines.slice(0, 4);
  }

  /**
   * Generate SVG image for the key
   * Supports multi-line main text
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

    // Top-left identifier (airport code)
    if (topLeft) {
      svg += `
        <text x="12" y="48" text-anchor="start"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${infoFontSize}" font-weight="bold" fill="white"
        >${this.escapeXml(topLeft)}</text>
      `;
    }

    const contentTop = topLeft ? 62 : 12;
    const contentBottom = 276;

    // Label in top-right
    if (label) {
      svg += `
        <text x="${S - 12}" y="${contentTop + 28}" text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="30" font-weight="bold" fill="white" fill-opacity="0.5"
        >${this.escapeXml(label)}</text>
      `;
    }

    // Main content area
    const effectiveTop = label ? contentTop + 40 : contentTop;
    const effectiveHeight = contentBottom - effectiveTop;
    const effectiveCenterY = (effectiveTop + contentBottom) / 2;

    const lineCount = lines.length;
    const maxLen = Math.max(...lines.map(l => l.length));

    // Adaptive font sizing
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

    // Ensure fits in available height
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
        >${this.escapeXml(lines[i])}</text>
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
