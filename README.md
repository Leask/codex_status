# codex_status

A simple tool to check Codex usage and monitor ChatGPT/Codex rate limits from Codex CLI `auth.json` files.

## Features

- Display rate-limit windows with progress bars.
- Auto-refresh every 30 seconds with `--tail` (press `q` to exit).
- Raw JSON output with `--json` for integration.
- Supports multiple auth files in a single run.

## Installation

```bash
npm install -g codex_status
```

Or run directly without installing:

```bash
npx codex_status --auth ~/.codex/auth.json
```

## Usage

```bash
codex_status --auth ~/.codex/auth.json [--auth /path/to/other.json] [--tail] [--json]
```

### Options

- `--auth <path>`: Path to a Codex `auth.json` file. Repeat for multiple accounts. Defaults to `~/.codex/auth.json`.
- `--tail`: Refresh output every 30 seconds, updating in-place. Press `q` or `Ctrl+C` to exit.
- `--json`: Print raw JSON data once and exit (disables `--tail`).
- `-h`, `--help`: Show CLI help.

### Examples

```bash
codex_status --auth ~/.codex/auth.json
codex_status --tail --auth ~/.codex/auth.json --auth /tmp/team.json
codex_status --json --auth ~/.codex/auth.json > usage.json
```

## Development

```bash
npm install
npm start -- --auth ~/.codex/auth.json
```

## License

MIT
