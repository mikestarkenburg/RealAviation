import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent
} from "@elgato/streamdeck";
import { atisService } from "../atis-service";
import {
  AtisSettings,
  AtisResponse,
  DisplayState,
  DEFAULT_SETTINGS,
  DETAIL_FIELDS,
  DetailField,
  FLIGHT_CATEGORY_COLORS,
  FlightCategory
} from "../types";

@action({ UUID: "com.starkenburg.atis.display" })
export class AtisDisplayAction extends SingletonAction<AtisSettings> {

  private logger = streamDeck.logger.createScope("AtisDisplayAction");
  private displayStates: Map<string, DisplayState> = new Map();
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Called when action appears on the Stream Deck
   */
  override async onWillAppear(ev: WillAppearEvent<AtisSettings>): Promise<void> {
    const settings = { ...DEFAULT_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    // Initialize display state
    this.displayStates.set(contextId, {
      currentDetailIndex: 0,
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
  override async onWillDisappear(ev: WillDisappearEvent<AtisSettings>): Promise<void> {
    const contextId = ev.action.id;

    // Clear refresh timer
    const timer = this.refreshTimers.get(contextId);
    if (timer) {
      clearInterval(timer);
      this.refreshTimers.delete(contextId);
    }

    // Clean up state
    this.displayStates.delete(contextId);
  }

  /**
   * Called when settings are received/changed
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AtisSettings>): Promise<void> {
    const settings = { ...DEFAULT_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;

    // Restart refresh timer with new interval
    this.startRefreshTimer(contextId, ev, settings);

    // Refresh display with new settings
    await this.refreshAndDisplay(contextId, ev, settings);
  }

  /**
   * Short press cycles through ATIS detail fields
   */
  override async onKeyDown(ev: KeyDownEvent<AtisSettings>): Promise<void> {
    const settings = { ...DEFAULT_SETTINGS, ...ev.payload.settings };
    const contextId = ev.action.id;
    const state = this.displayStates.get(contextId);

    if (!state) return;

    // Cycle to next detail field
    state.currentDetailIndex = (state.currentDetailIndex + 1) % DETAIL_FIELDS.length;
    await this.updateDisplay(contextId, ev, settings, state);
  }

  /**
   * Start or restart the refresh timer
   */
  private startRefreshTimer(
    contextId: string,
    ev: WillAppearEvent<AtisSettings> | DidReceiveSettingsEvent<AtisSettings>,
    settings: AtisSettings
  ): void {
    // Clear existing timer
    const existingTimer = this.refreshTimers.get(contextId);
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    // Set up new timer
    const interval = Math.max(settings.refreshInterval, 30) * 1000; // Minimum 30 seconds
    const timer = setInterval(async () => {
      await this.refreshAndDisplay(contextId, ev, settings);
    }, interval);

    this.refreshTimers.set(contextId, timer);
  }

  /**
   * Fetch fresh ATIS data and update display
   */
  private async refreshAndDisplay(
    contextId: string,
    ev: WillAppearEvent<AtisSettings> | DidReceiveSettingsEvent<AtisSettings> | KeyDownEvent<AtisSettings>,
    settings: AtisSettings
  ): Promise<void> {
    const state = this.displayStates.get(contextId);
    if (!state) return;

    const icao = settings.primaryAirport;
    if (icao) {
      const atis = await atisService.getAtis(icao);
      if (atis) {
        state.cachedData.set(icao, atis);
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
    ev: WillAppearEvent<AtisSettings> | DidReceiveSettingsEvent<AtisSettings> | KeyDownEvent<AtisSettings>,
    settings: AtisSettings,
    state: DisplayState
  ): Promise<void> {
    const icao = settings.primaryAirport;
    const atis = state.cachedData.get(icao);

    if (!atis) {
      // No data - show error state
      await ev.action.setImage(this.generateImage('?', 'UNKNOWN', icao));
      return;
    }

    // Determine what to display based on current detail index
    const detailField = DETAIL_FIELDS[state.currentDetailIndex];
    const displayContent = this.getDisplayContent(atis, detailField, settings);

    // Generate and set the image
    const image = this.generateImage(
      displayContent.main,
      atis.flight_rules || 'UNKNOWN',
      detailField === 'letter' ? icao : undefined,
      detailField,
      displayContent.label
    );

    await ev.action.setImage(image);
  }

  /**
   * Get display content based on current detail field
   */
  private getDisplayContent(
    atis: AtisResponse,
    field: DetailField,
    settings: AtisSettings
  ): { main: string; label?: string } {
    switch (field) {
      case 'letter':
        return { main: atis.atis_letter };
      case 'time':
        return {
          main: this.formatTime(atis.effective_time, settings.timeFormat),
          label: settings.timeFormat === 'zulu' ? 'ZULU' : 'LOCAL'
        };
      case 'wind':
        return { main: atis.wind || 'N/A', label: 'WIND' };
      case 'visibility':
        return { main: atis.visibility || 'N/A', label: 'VIS' };
      case 'clouds':
        return { main: atis.clouds || 'N/A', label: 'SKY' };
      case 'temperature':
        return { main: `${atis.temperature || '?'}/${atis.dewpoint || '?'}`, label: 'T/DP' };
      case 'altimeter':
        return { main: this.formatAltimeter(atis.altimeter || 'N/A'), label: 'ALT' };
      default:
        return { main: atis.atis_letter };
    }
  }

  /**
   * Format time based on settings
   */
  private formatTime(timeStr: string, format: 'zulu' | 'local'): string {
    if (!timeStr) return '----';

    if (format === 'zulu') {
      // Already in Zulu, just format nicely
      const match = timeStr.match(/(\d{2})(\d{2})Z?/);
      if (match) {
        return `${match[1]}:${match[2]}Z`;
      }
      return timeStr;
    }

    // Convert to local time
    try {
      // Parse Zulu time (assuming current date)
      const match = timeStr.match(/(\d{2})(\d{2})Z?/);
      if (match) {
        const now = new Date();
        const utc = new Date(Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          parseInt(match[1]),
          parseInt(match[2])
        ));
        return utc.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
      }
    } catch (e) {
      // Fall back to Zulu
    }

    return timeStr;
  }

  /**
   * Generate SVG image for Stream Deck key
   */
  private generateImage(
    mainText: string,
    flightCategory: FlightCategory,
    airportId?: string,
    detailField?: DetailField,
    label?: string
  ): string {
    const bgColor = FLIGHT_CATEGORY_COLORS[flightCategory];
    const isLetter = !detailField || detailField === 'letter';

    // 288×288 canvas (2× resolution) — Stream Deck downscales for sharper rendering
    const S = 288;
    const infoFontSize = 53;

    let svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
        <rect width="${S}" height="${S}" fill="${bgColor}"/>
    `;

    // Airport ID — left-justified top, bold, full white
    if (airportId) {
      svg += `
        <text
          x="12"
          y="48"
          text-anchor="start"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${infoFontSize}"
          font-weight="bold"
          fill="white"
        >${this.escapeXml(airportId)}</text>
      `;
    }

    // Content area bounds
    const contentTop = airportId ? 62 : 12;
    const contentBottom = 276;
    const contentCenterY = (contentTop + contentBottom) / 2;

    if (isLetter) {
      // ATIS letter — 15% bigger (158→182), 5% lower (+14px)
      const mainFontSize = 182;
      const capHeight = Math.round(mainFontSize * 0.72);
      const mainBaseline = Math.round(contentCenterY + capHeight / 2) + 14;

      svg += `
        <text
          x="${S - 12}"
          y="${mainBaseline}"
          text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${mainFontSize}"
          font-weight="bold"
          fill="white"
        >${this.escapeXml(mainText)}</text>
      `;
    } else {
      // Detail field — optimized layout for maximum readability
      svg += this.generateDetailContent(mainText, detailField!, label, S, contentTop, contentBottom);
    }

    svg += '</svg>';

    // Return as data URI
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  /**
   * Generate SVG content for detail fields (wind, visibility, clouds, etc.)
   * Uses adaptive font sizing and multi-line layout for readability
   */
  private generateDetailContent(
    text: string,
    field: DetailField,
    label: string | undefined,
    S: number,
    contentTop: number,
    contentBottom: number
  ): string {
    let svgContent = '';

    // Small label in top-right corner (e.g., "WIND", "VIS", "SKY")
    if (label) {
      svgContent += `
        <text
          x="${S - 12}"
          y="${contentTop + 28}"
          text-anchor="end"
          font-family="Arial, Helvetica, sans-serif"
          font-size="30"
          font-weight="bold"
          fill="white"
          fill-opacity="0.5"
        >${this.escapeXml(label)}</text>
      `;
    }

    // Effective content area (below label if present)
    const effectiveTop = label ? contentTop + 40 : contentTop;
    const effectiveBottom = contentBottom;
    const effectiveHeight = effectiveBottom - effectiveTop;
    const effectiveCenterY = (effectiveTop + effectiveBottom) / 2;

    // Split text into display lines based on field type
    let lines: string[];
    switch (field) {
      case 'wind':
        lines = this.formatWindLines(text);
        break;
      case 'clouds':
        lines = this.formatCloudLines(text);
        break;
      default:
        lines = [text];
        break;
    }

    // Calculate font size based on line count and max text length
    const lineCount = lines.length;
    const maxLen = Math.max(...lines.map(l => l.length));
    let fontSize: number;

    if (lineCount === 1) {
      // Single line — sized to fit within key margins
      if (maxLen <= 3) fontSize = 100;
      else if (maxLen <= 4) fontSize = 88;
      else if (maxLen <= 5) fontSize = 76;
      else if (maxLen <= 6) fontSize = 66;
      else if (maxLen <= 7) fontSize = 58;
      else fontSize = 48;
    } else if (lineCount === 2) {
      if (maxLen <= 4) fontSize = 68;
      else if (maxLen <= 6) fontSize = 58;
      else fontSize = 48;
    } else if (lineCount === 3) {
      fontSize = 46;
    } else {
      fontSize = 38;
    }

    // Ensure text block fits in available height
    const lineSpacing = fontSize * 1.2;
    const blockHeight = fontSize * 0.72 + (lineCount - 1) * lineSpacing;
    if (blockHeight > effectiveHeight * 0.95) {
      const scale = (effectiveHeight * 0.95) / blockHeight;
      fontSize = Math.floor(fontSize * scale);
    }

    // Position lines vertically centered in effective area
    const actualSpacing = fontSize * 1.2;
    const actualBlockHeight = fontSize * 0.72 + (lineCount - 1) * actualSpacing;
    const startBaseline = effectiveCenterY - actualBlockHeight / 2 + fontSize * 0.72;

    for (let i = 0; i < lines.length; i++) {
      const y = Math.round(startBaseline + i * actualSpacing);
      svgContent += `
        <text
          x="${S / 2}"
          y="${y}"
          text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif"
          font-size="${fontSize}"
          font-weight="bold"
          fill="white"
        >${this.escapeXml(lines[i])}</text>
      `;
    }

    return svgContent;
  }

  /**
   * Format wind string into display lines
   * e.g., "22003KT" → ["220°", "03KT"]
   */
  private formatWindLines(wind: string): string[] {
    if (wind === 'N/A') return ['N/A'];
    // Parse METAR wind: 22003KT, 22003G15KT, VRB03KT
    const match = wind.match(/^(\d{3}|VRB)(\d{2,3}(?:G\d{2,3})?)(KT|MPS)$/);
    if (match) {
      const dir = match[1] === 'VRB' ? 'VRB' : match[1] + '°';
      return [dir, match[2] + match[3]];
    }
    // Fallback: split long text
    if (wind.length > 6) {
      const mid = Math.ceil(wind.length / 2);
      return [wind.substring(0, mid), wind.substring(mid)];
    }
    return [wind];
  }

  /**
   * Format cloud layers into display lines
   * e.g., "FEW040 SCT080 BKN120" → ["FEW040", "SCT080", "BKN120"]
   */
  private formatCloudLines(clouds: string): string[] {
    if (clouds === 'N/A' || clouds === 'CLR' || clouds === 'SKC') return [clouds];
    const layers = clouds.split(/[\s\n]+/).filter(s => s.length > 0);
    if (layers.length === 0) return ['CLR'];
    return layers;
  }

  /**
   * Format altimeter for display
   * e.g., "A2994" → "29.94"
   */
  private formatAltimeter(alt: string): string {
    if (!alt || alt === 'N/A') return 'N/A';
    // Remove leading 'A' if present
    const digits = alt.replace(/^A/, '');
    // If 4 digits, insert decimal after first 2
    if (/^\d{4}$/.test(digits)) {
      return digits.substring(0, 2) + '.' + digits.substring(2);
    }
    return digits;
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
