#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const BASE_URL = 'https://chatgpt.com/backend-api';
const REFRESH_ENDPOINT =
  process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || 'https://auth.openai.com/oauth/token';
const REFRESH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_SCOPE = 'openid profile email';
const EXP_SKEW_SECONDS = 60;
const KEY_COLOR = '\x1b[36m';
const VALUE_COLOR = '\x1b[97m';
const RESET_COLOR = '\x1b[0m';
const REFRESH_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const DEFAULT_AUTH_PATH = path.join(
  process.env.HOME || os.homedir() || '.',
  '.codex',
  'auth.json',
);

async function main() {
  const { authPaths: parsedPaths, tailMode } = parseArgs(process.argv.slice(2));
  let authPaths = parsedPaths;
  if (authPaths.length === 0) {
    if (!(await fileExists(DEFAULT_AUTH_PATH))) {
      console.error(
        `Default auth file ${DEFAULT_AUTH_PATH} not found. Please pass --auth=/path/to/auth.json.`,
      );
      process.exit(1);
    }
    authPaths = [DEFAULT_AUTH_PATH];
  }

  const abortController = new AbortController();

  const renderOnce = async (signal) => {
    ensureNotAborted(signal);
    const results = [];
    for (const authArg of authPaths) {
      ensureNotAborted(signal);
      const authPath = path.resolve(authArg);
      try {
        const result = await collectUsageForAuth(authPath, signal);
        results.push(result);
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        results.push({
          authFile: authPath,
          error: err?.message || String(err),
        });
      }
    }
    ensureNotAborted(signal);
    return results;
  };

  if (!tailMode) {
    const results = await renderOnce(abortController.signal);
    renderResults(results, { clearFirst: false });
    return;
  }

  const { quitPromise, cleanup } = setupTailInput(() => abortController.abort());
  try {
    await runTailLoop(renderOnce, quitPromise, abortController.signal);
  } finally {
    cleanup();
  }
}

async function runTailLoop(renderOnce, quitPromise, signal) {
  let lastRenderAt = 0;

  const renderStep = async () => {
    const results = await renderOnce(signal);
    renderResults(results, { clearFirst: true });
    lastRenderAt = Date.now();
  };

  while (true) {
    const now = Date.now();
    const due = lastRenderAt === 0 || now - lastRenderAt >= REFRESH_INTERVAL_MS;

    if (due) {
      const outcome = await Promise.race([
        renderStep()
          .then(() => ({ kind: 'rendered' }))
          .catch((error) => (isAbortError(error) ? { kind: 'quit' } : { kind: 'error', error })),
        quitPromise.then(() => ({ kind: 'quit' })),
      ]);
      if (outcome.kind === 'quit') break;
      if (outcome.kind === 'error') {
        console.error(outcome.error?.message || outcome.error);
        break;
      }
      continue;
    }

    const remaining = Math.max(0, REFRESH_INTERVAL_MS - (now - lastRenderAt));
    const waitDuration = Math.min(POLL_INTERVAL_MS, remaining);
    const waitOutcome = await Promise.race([
      sleep(waitDuration).then(() => ({ kind: 'tick' })),
      quitPromise.then(() => ({ kind: 'quit' })),
    ]);
    if (waitOutcome.kind === 'quit') break;
  }
}

function parseArgs(args) {
  const authPaths = [];
  let tailMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--tail') {
      tailMode = true;
    } else if (arg.startsWith('--auth=')) {
      const value = arg.slice('--auth='.length).trim();
      if (!value) throw new Error('--auth requires a file path');
      authPaths.push(value);
    } else if (arg === '--auth') {
      const value = args[++i];
      if (!value) throw new Error('--auth requires a file path');
      authPaths.push(value);
    } else {
      throw new Error(`Unknown argument: ${arg}. Only --auth=<path> and --tail are supported.`);
    }
  }
  return { authPaths, tailMode };
}

async function collectUsageForAuth(authPath, signal) {
  ensureNotAborted(signal);
  const auth = await readAuth(authPath);
  if (!auth.tokens) auth.tokens = {};

  let tokens = auth.tokens;
  validateTokenBundle(tokens);

  const initialIdentity = decodeIdToken(tokens.id_token);
  let accountId = tokens.account_id || initialIdentity?.auth?.chatgpt_account_id || null;

  if (shouldRefreshNow(tokens.access_token) && tokens.refresh_token) {
    console.warn(
      `[${authPath}] Access token looks expired; attempting refresh before fetching usage.`,
    );
    ensureNotAborted(signal);
    tokens = await refreshTokensAndPersist(authPath, auth, tokens.refresh_token, signal);
  }

  let usagePayload;
  try {
    ensureNotAborted(signal);
    usagePayload = await fetchUsage(tokens.access_token, accountId, signal);
  } catch (err) {
    if (err?.status === 401 && tokens.refresh_token) {
      console.warn(
        `[${authPath}] Usage request returned 401 (${err.message}). Trying to refresh the access token...`,
      );
      tokens = await refreshTokensAndPersist(authPath, auth, tokens.refresh_token, signal);
      ensureNotAborted(signal);
      usagePayload = await fetchUsage(tokens.access_token, accountId, signal);
    } else {
      if (isAbortError(err)) throw err;
      throw err;
    }
  }

  const refreshedIdentity = decodeIdToken(tokens.id_token);
  const planFromToken = refreshedIdentity?.auth?.chatgpt_plan_type || null;
  const derivedAccountId = refreshedIdentity?.auth?.chatgpt_account_id || null;
  if (!accountId) {
    accountId = tokens.account_id || derivedAccountId || null;
  }

  const details = usagePayload?.rate_limit ?? null;
  return {
    authFile: authPath,
    baseUrl: BASE_URL,
    account: {
      email: refreshedIdentity.email || initialIdentity.email || null,
      accountId,
      planFromToken,
      planFromUsage: usagePayload?.plan_type || null,
    },
    allowed: details?.allowed ?? null,
    limitReached: details?.limit_reached ?? null,
    windows: {
      primary: mapWindow(details?.primary_window),
      secondary: mapWindow(details?.secondary_window),
    },
    fetchedAt: new Date().toISOString(),
    lastRefresh: auth.last_refresh || null,
  };
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readAuth(authPath) {
  const raw = await fs.readFile(authPath, 'utf8');
  return JSON.parse(raw);
}

async function fetchUsage(accessToken, accountId, signal) {
  ensureNotAborted(signal);
  const usageUrl = `${BASE_URL}/wham/usage`;
  const headers = {
    'User-Agent': 'codex-auth-rate-limit-script/1.1',
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  const res = await fetch(usageUrl, { headers, signal });
  if (!res.ok) {
    const body = await res.text();
    const error = new Error(`GET ${usageUrl} failed: ${res.status} ${res.statusText} => ${body}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return res.json();
}

function validateTokenBundle(tokens) {
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error(
      'auth.json does not contain ChatGPT tokens (expected tokens.access_token). Run `codex login --chatgpt` first.',
    );
  }
}

function shouldRefreshNow(accessToken) {
  try {
    const payload = decodeJwtPayload(accessToken);
    if (!payload || typeof payload.exp !== 'number') return false;
    const now = Math.floor(Date.now() / 1000);
    return now >= payload.exp - EXP_SKEW_SECONDS;
  } catch {
    return false;
  }
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const json = base64UrlDecode(parts[1]);
  return JSON.parse(json);
}

async function refreshTokensAndPersist(authPath, auth, refreshToken, signal) {
  if (!refreshToken) {
    throw new Error('Cannot refresh tokens: refresh_token is missing from auth.json.');
  }
  ensureNotAborted(signal);
  const refreshed = await requestTokenRefresh(refreshToken, signal);
  if (!refreshed.access_token) {
    throw new Error('Token refresh succeeded but no access_token was returned.');
  }

  if (!auth.tokens) auth.tokens = {};
  auth.tokens.access_token = refreshed.access_token;
  if (refreshed.id_token) {
    auth.tokens.id_token = refreshed.id_token;
  }
  if (refreshed.refresh_token) {
    auth.tokens.refresh_token = refreshed.refresh_token;
  }
  auth.last_refresh = new Date().toISOString();

  await fs.writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
  return auth.tokens;
}

async function requestTokenRefresh(refreshToken, signal) {
  const payload = {
    client_id: REFRESH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: REFRESH_SCOPE,
  };
  const res = await fetch(REFRESH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'codex-auth-rate-limit-script/1.1',
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    const error = new Error(
      `POST ${REFRESH_ENDPOINT} failed: ${res.status} ${res.statusText} => ${body}`,
    );
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return res.json();
}

function mapWindow(window) {
  if (!window) return null;
  const usedPercent = Number(window.used_percent ?? window.usedPercent ?? 0);
  const windowSeconds = window.limit_window_seconds ?? window.limitWindowSeconds ?? null;
  const windowMinutes = windowSeconds != null ? Math.ceil(windowSeconds / 60) : null;
  const label = windowMinutes != null ? humanizeWindow(windowMinutes) : 'unknown';
  const resetAtSeconds = window.reset_at ?? window.resetAt ?? null;
  return {
    label,
    percentUsed: usedPercent,
    percentRemaining: Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt: resetAtSeconds != null ? new Date(resetAtSeconds * 1000).toISOString() : null,
    raw: window,
  };
}

function humanizeWindow(minutes) {
  const MINUTES_PER_HOUR = 60;
  const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
  const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
  const MINUTES_PER_MONTH = 30 * MINUTES_PER_DAY;
  if (minutes == null) return 'unknown';
  if (minutes <= MINUTES_PER_DAY) {
    const hours = Math.max(1, Math.round(minutes / MINUTES_PER_HOUR));
    return `${hours}h`;
  }
  if (minutes <= MINUTES_PER_WEEK) return 'weekly';
  if (minutes <= MINUTES_PER_MONTH) return 'monthly';
  return 'annual';
}

function decodeIdToken(raw) {
  if (typeof raw !== 'string') return {};
  const parts = raw.split('.');
  if (parts.length < 2) return {};
  const payload = base64UrlDecode(parts[1]);
  try {
    const parsed = JSON.parse(payload);
    const authClaims = parsed['https://api.openai.com/auth'] || {};
    return { email: parsed.email || null, auth: authClaims };
  } catch (err) {
    console.warn('Unable to parse id_token payload:', err.message);
    return {};
  }
}

function base64UrlDecode(segment) {
  const padLength = (4 - (segment.length % 4)) % 4;
  const padded = segment + '='.repeat(padLength);
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function printUsage() {
  console.log(
    'Usage: node scripts/codex_status.js [--tail] --auth=/path/to/auth.json [--auth=/path/to/other.json]\n' +
      'Reads one or more Codex auth.json files, refreshes expired ChatGPT tokens when needed, and prints rate-limit stats for each.\n' +
      'When --tail is provided, the display refreshes every 30 seconds in place (press q to exit).',
  );
}

function renderResults(entries, { clearFirst }) {
  if (clearFirst) {
    clearScreen();
  }
  entries.forEach((entry, idx) => {
    if (idx > 0) console.log('');
    const lines = buildCardLines(entry);
    console.log(drawCard(lines));
  });
}

function buildCardLines(entry) {
  const lines = [];
  const summaryPairs = [
    ['Auth File', entry.authFile],
    ['Email', entry.account?.email || '-'],
    [
      'Account',
      entry.account
        ? `${entry.account.accountId || '-'}${
            formatPlan(entry.account.planFromUsage || entry.account.planFromToken || '')
              ? ` (${formatPlan(entry.account.planFromUsage || entry.account.planFromToken || '')})`
              : ''
          }`
        : '-',
    ],
    ['Allowed', formatBool(entry.allowed)],
    ['Limit Reached', formatBool(entry.limitReached)],
    ['Last Refresh', formatIso(entry.lastRefresh)],
    ['Fetched At', formatIso(entry.fetchedAt)],
  ];
  const formattedSummary = formatKeyValuePairs(summaryPairs);
  lines.push(formattedSummary.shift() || '');
  lines.push(...formattedSummary);
  if (entry.error) {
    lines.push('');
    lines.push(formatKeyValuePairs([['Error', entry.error]])[0]);
    return lines;
  }

  const primary = entry.windows.primary || null;
  const secondary = entry.windows.secondary || null;
  lines.push('');
  const limitPairs = [
    ['5h limit', `${formatPercent(primary?.percentUsed)} ${makeProgressBar(primary?.percentUsed)}`],
    ['5h resets', formatIso(primary?.resetsAt)],
    [
      'Weekly limit',
      `${formatPercent(secondary?.percentUsed)} ${makeProgressBar(secondary?.percentUsed)}`,
    ],
    ['Weekly resets', formatIso(secondary?.resetsAt)],
  ];
  lines.push(...formatKeyValuePairs(limitPairs));
  return lines;
}

function drawCard(lines) {
  const content = lines.map((line) => line ?? '');
  const width = Math.max(0, ...content.map((line) => visibleLength(line)));
  const padWidth = width;
  const top = `╭${'─'.repeat(padWidth + 2)}╮`;
  const bottom = `╰${'─'.repeat(padWidth + 2)}╯`;
  const body = content
    .map((line) => {
      const padding = padWidth - visibleLength(line);
      return `│ ${line}${' '.repeat(Math.max(0, padding))} │`;
    })
    .join('\n');
  return `${top}\n${body}\n${bottom}`;
}

function formatBool(value) {
  if (value === true) return 'YES';
  if (value === false) return 'NO';
  return '-';
}

function formatPercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'n/a';
  return `${value.toFixed(1)}%`;
}

function makeProgressBar(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'n/a';
  const width = 20;
  const clamped = Math.min(100, Math.max(0, value));
  const filled = Math.round((clamped / 100) * width);
  const bar = '#'.repeat(filled).padEnd(width, '.');
  return `[${bar}]`;
}

function formatIso(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '-';
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function formatPlan(value) {
  if (!value || value === '-') return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatKeyValuePairs(pairs) {
  if (!pairs.length) return [];
  const cleaned = pairs.map(([key, value]) => [key || '-', value ?? '-']);
  const width = Math.max(...cleaned.map(([key]) => key.length));
  return cleaned.map(([key, value]) => {
    const coloredKey = `${KEY_COLOR}${key.padEnd(width)}${RESET_COLOR}`;
    const coloredValue = `${VALUE_COLOR}${String(value)}${RESET_COLOR}`;
    return `${coloredKey}: ${coloredValue}`;
  });
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
function stripAnsi(str) {
  return String(str).replace(ANSI_REGEX, '');
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupTailInput(onQuit) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return {
      quitPromise: new Promise(() => {}),
      cleanup: () => {},
    };
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();

  let resolved = false;
  let resolveQuit;
  const quitPromise = new Promise((resolve) => {
    resolveQuit = resolve;
  });

  const handler = (chunk) => {
    const key = chunk.toString();
    if (key === 'q' || key === 'Q' || key === '\u0003') {
      if (!resolved) {
        resolved = true;
        if (typeof onQuit === 'function') onQuit();
        resolveQuit();
      }
    }
  };

  process.stdin.on('data', handler);

  const cleanup = () => {
    process.stdin.off('data', handler);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  return { quitPromise, cleanup };
}

function ensureNotAborted(signal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  return err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
