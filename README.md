# Stream Deck ATIS Display Plugin

Real-time ATIS (Automatic Terminal Information Service) display for Elgato Stream Deck with flight category color coding.

## Features

- **Large ATIS Letter Display** - Current ATIS information letter in large, visible font
- **Flight Category Colors** - Background color indicates conditions:
  - 🟢 **Green** = VFR (Visual Flight Rules)
  - 🔵 **Blue** = MVFR (Marginal VFR)
  - 🔴 **Red** = IFR (Instrument Flight Rules)
  - 🟣 **Magenta** = LIFR (Low IFR)
- **Three Button Modes**:
  1. Cycle through multiple airports
  2. Cycle through ATIS details (wind, visibility, clouds, temp, pressure)
  3. Open atis.info in browser for current airport
- **Configurable Display** - Optional airport identifier and effective time
- **Time Format** - Zulu or local time display

## Development Setup

### Prerequisites

1. **Node.js v20+** - Use [nvm](https://github.com/nvm-sh/nvm) or [nvm-windows](https://github.com/coreybutler/nvm-windows)
2. **Stream Deck v6.6+** - Required for SDK v2
3. **VS Code** - Recommended IDE
4. **Git** - Version control

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/streamdeck-atis.git
cd streamdeck-atis

# Install dependencies
npm install

# Install Stream Deck CLI globally
npm install -g @elgato/cli

# Link plugin for development (run from project root)
streamdeck link com.starkenburg.atis.sdPlugin
```

### Development Workflow

```bash
# Start development with hot-reload
npm run watch

# Build once
npm run build

# Restart plugin in Stream Deck
streamdeck restart com.starkenburg.atis
```

### Debugging

1. Open VS Code
2. Press `Ctrl+P` / `Cmd+P`
3. Type `> Debug: Attach to Node Process`
4. Select the `node20` process

Debug logs are written to:
- **Windows**: `%APPDATA%\Elgato\StreamDeck\Plugins\com.starkenburg.atis.sdPlugin\logs`
- **macOS**: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.starkenburg.atis.sdPlugin/logs`

## Project Structure

```
streamdeck-atis/
├── src/
│   ├── plugin.ts              # Entry point
│   ├── types.ts               # TypeScript interfaces
│   ├── atis-service.ts        # API communication
│   └── actions/
│       └── atis-display.ts    # Main action logic
├── com.starkenburg.atis.sdPlugin/
│   ├── manifest.json          # Plugin manifest
│   ├── bin/                   # Compiled JS
│   ├── ui/
│   │   └── atis-settings.html # Property Inspector
│   └── static/imgs/           # Icons
├── package.json
├── tsconfig.json
└── rollup.config.mjs
```

## API Integration

This plugin uses the **atis.info** API. Key endpoints:

- `GET /api/stations` - List available airports
- `GET /api/{ICAO}` - Get ATIS for specific airport

**NOTE**: Verify the exact API response structure at https://atis.info/api before deployment. The service implementation includes adapters for common response formats but may need adjustment.

### Flight Category Calculation

FAA definitions:
| Category | Ceiling | Visibility |
|----------|---------|------------|
| VFR | > 3,000 ft | > 5 SM |
| MVFR | 1,000-3,000 ft | 3-5 SM |
| IFR | 500-999 ft | 1-3 SM |
| LIFR | < 500 ft | < 1 SM |

## Git & GitHub Workflow

### Initial Repository Setup

```bash
# Initialize git (if not cloned)
git init

# Add all files
git add .

# Initial commit
git commit -m "Initial ATIS plugin implementation"

# Create GitHub repository (via GitHub CLI or web)
gh repo create streamdeck-atis --public --source=. --remote=origin --push

# Or manually
git remote add origin https://github.com/YOUR_USERNAME/streamdeck-atis.git
git branch -M main
git push -u origin main
```

### Development Branches

```bash
# Create feature branch
git checkout -b feature/multi-airport-support

# Make changes...
git add .
git commit -m "Add multi-airport cycling support"

# Push and create PR
git push origin feature/multi-airport-support
```

### Version Tagging

```bash
# Update version in manifest.json and package.json
# Then tag release
git tag v1.0.0
git push origin v1.0.0
```

## Publishing to Elgato Marketplace

### 1. Validate Plugin

```bash
streamdeck validate com.starkenburg.atis.sdPlugin
```

### 2. Package for Distribution

```bash
streamdeck pack com.starkenburg.atis.sdPlugin
```

This creates `com.starkenburg.atis.streamDeckPlugin` installer.

### 3. Prepare Submission Assets

**Required:**
- **Plugin Icon** - 288x288 PNG (convert from marketplace.svg)
- **Category Icon** - 28x28 PNG
- **Preview Images** - Screenshots showing plugin in action
- **Description** - Clear, accurate description of functionality

**Convert SVGs to PNG:**
```bash
# Using ImageMagick
convert static/imgs/plugin/marketplace.svg -resize 288x288 marketplace.png
convert static/imgs/plugin/category-icon.svg -resize 28x28 category-icon.png
```

### 4. Submit to Marketplace

1. Go to [Elgato Maker Console](https://marketplace.elgato.com/maker)
2. Create Maker account if needed
3. Click "Submit New Product"
4. Upload `.streamDeckPlugin` file
5. Add metadata, icons, and preview images
6. Submit for review

### Marketplace Guidelines Checklist

- [ ] Name is unique and descriptive
- [ ] Description accurately describes functionality
- [ ] Author name matches Marketplace organization
- [ ] Version follows numeric format (e.g., 1.0.0.0)
- [ ] URL points to GitHub repo or documentation
- [ ] Icons meet size requirements
- [ ] At least 1 preview image included
- [ ] Plugin passes validation
- [ ] Tested on both Windows and macOS

### DRM Protection (Optional)

Plugins built with CLI 1.6+ have DRM enabled by default. This:
- Encrypts plugin files
- Verifies file integrity
- Enables Marketplace-only features

## GitHub Actions CI/CD (Optional)

Create `.github/workflows/build.yml`:

```yaml
name: Build Plugin

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build
      
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: plugin
          path: com.starkenburg.atis.sdPlugin/
```

## Troubleshooting

### Plugin Not Appearing
- Ensure Stream Deck v6.6+
- Check `streamdeck link` was run
- Restart Stream Deck app

### API Errors
- Verify atis.info API is accessible
- Check console logs for detailed errors
- Ensure network connectivity

### Build Errors
- Run `npm install` to update dependencies
- Verify Node.js v20+
- Check TypeScript errors in VS Code

## License

MIT License - See LICENSE file

## Contributing

1. Fork the repository
2. Create feature branch
3. Make changes with tests
4. Submit pull request

## Acknowledgments

- [Elgato Stream Deck SDK](https://docs.elgato.com/streamdeck/sdk)
- [atis.info](https://atis.info) API
- Aviation community
