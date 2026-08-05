#!/usr/bin/env node
/**
 * End-to-end smoke harness for the built Chrome MV3 extension.
 *
 * Browser MCP tooling cannot reach `chrome-extension://` URLs, so this script
 * loads the production build in a real Chromium (fresh persistent profile) and
 * drives the extension pages with Playwright.
 *
 * Usage: `npm run e2e` (requires `npm run build` first).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUILD_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const ARTIFACTS = path.join(HERE, 'artifacts');

const SETTINGS = {
  siteLabel: 'e2e测试站',
  websiteUrl: 'https://example-promo.test',
  displayName: 'E2E',
  provider: 'deepseek',
  // Throwaway placeholder written into a disposable profile. Never a real key,
  // and the batch below never reaches a provider call.
  apiKey: 'test-key-e2e',
};

const BATCH_TARGETS = [
  'https://example.com/page-a',
  'https://example.com/page-b',
  'https://example.com/page-c',
];

const IMPORT_CSV = [
  'url,dofollow',
  'https://example-one.test/post,true',
  'https://example-two.test/article,false',
  ',true',
  '',
].join('\n');

/* -------------------------------------------------------------------------- */
/* tiny assertion helpers                                                      */
/* -------------------------------------------------------------------------- */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message}\n  missing: ${JSON.stringify(needle)}\n  in: ${JSON.stringify(String(haystack).slice(0, 800))}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* test-build preparation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Copies the production build to a temp dir and promotes the broad host
 * patterns from `optional_host_permissions` into `host_permissions`. Unpacked
 * installs auto-grant manifest host permissions, so the batch test never hits a
 * native permission prompt. `.output` itself is never touched.
 */
async function prepareTestBuild(tempRoot) {
  const manifestPath = path.join(BUILD_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Missing build at ${BUILD_DIR}.\nRun \`npm run build\` (and \`npx wxt prepare\` if .wxt types are missing) first.`
    );
  }
  const extDir = path.join(tempRoot, 'extension');
  await fsp.cp(BUILD_DIR, extDir, { recursive: true });

  const manifest = JSON.parse(await fsp.readFile(path.join(extDir, 'manifest.json'), 'utf8'));
  const promote = ['http://*/*', 'https://*/*'];
  const optional = new Set(manifest.optional_host_permissions ?? []);
  const host = new Set(manifest.host_permissions ?? []);
  for (const pattern of promote) {
    optional.delete(pattern);
    host.add(pattern);
  }
  manifest.host_permissions = [...host];
  manifest.optional_host_permissions = [...optional];
  await fsp.writeFile(path.join(extDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { extDir, hostPermissions: manifest.host_permissions };
}

/** Chrome derives an unpacked extension id from the SHA-256 of its absolute path. */
function derivedExtensionId(absolutePath) {
  const hash = crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 32);
  return [...hash].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join('');
}

async function discoverExtensionId(context, extDir, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.url());
      if (match) return { id: match[1], source: 'serviceWorker' };
    }
    await sleep(150);
  }
  // Fallback: the MV3 worker can stay dormant; the id is still deterministic.
  return { id: derivedExtensionId(extDir), source: 'derivedFromPath' };
}

/* -------------------------------------------------------------------------- */
/* promo site used by the batch test                                           */
/* -------------------------------------------------------------------------- */

/**
 * The promoted-site preview step fetches the site's <title>/<meta description>
 * before a batch can start. `example-promo.test` is intentionally unresolvable,
 * so the batch test points the site at this local stub instead.
 */
function startPromoServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<title>E2E Promo Site</title>' +
        '<meta name="description" content="Local stub promoted site for the e2e smoke harness.">' +
        '</head><body><h1>E2E Promo Site</h1></body></html>'
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* console collection                                                          */
/* -------------------------------------------------------------------------- */

const consoleRecords = [];
let currentTest = 'setup';

function attachConsole(page) {
  page.on('console', (message) => {
    consoleRecords.push({
      test: currentTest,
      at: new Date().toISOString(),
      where: page.url(),
      type: message.type(),
      text: message.text(),
    });
  });
  page.on('pageerror', (error) => {
    consoleRecords.push({
      test: currentTest,
      at: new Date().toISOString(),
      where: page.url(),
      type: 'pageerror',
      text: `${error.message}\n${error.stack ?? ''}`.trim(),
    });
  });
}

const NOISE_PATTERNS = [
  /net::ERR_/i,
  /Failed to load resource/i,
  /ERR_NAME_NOT_RESOLVED/i,
  /ERR_CONNECTION/i,
  /favicon/i,
];
const NOISE_HOSTS = [/example-one\.test/i, /example-two\.test/i, /example-promo\.test/i, /example\.com/i];

function isExtensionOrigin(url) {
  return typeof url === 'string' && url.startsWith('chrome-extension://');
}

function isNoise(record) {
  if (NOISE_PATTERNS.some((pattern) => pattern.test(record.text))) return true;
  return NOISE_HOSTS.some((pattern) => pattern.test(record.text)) && /error|fail/i.test(record.text);
}

function extensionErrorsFor(testId) {
  return consoleRecords.filter(
    (record) =>
      (testId === undefined || record.test === testId) &&
      isExtensionOrigin(record.where) &&
      (record.type === 'pageerror' || record.type === 'error') &&
      !isNoise(record)
  );
}

/* -------------------------------------------------------------------------- */
/* runner scaffolding                                                          */
/* -------------------------------------------------------------------------- */

const results = [];

async function runTest(id, name, fn) {
  currentTest = id;
  const startedAt = Date.now();
  process.stdout.write(`\n▶ ${id} ${name}\n`);
  try {
    const detail = await fn();
    const ms = Date.now() - startedAt;
    results.push({ id, name, status: 'PASS', ms, detail: detail ?? null });
    process.stdout.write(`  ✔ PASS (${ms}ms)${detail ? ` — ${detail}` : ''}\n`);
  } catch (error) {
    const ms = Date.now() - startedAt;
    results.push({ id, name, status: 'FAIL', ms, error: error?.stack ?? String(error) });
    process.stdout.write(`  ✘ FAIL (${ms}ms)\n${String(error?.stack ?? error).replace(/^/gm, '    ')}\n`);
  } finally {
    currentTest = 'between-tests';
  }
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: true });
  } catch (error) {
    process.stdout.write(`  (screenshot ${name} failed: ${error.message})\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* page helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The settings drawer seeds its draft once, when it opens, so it must not be
 * opened before the dashboard finished loading settings from storage.
 */
async function waitForDashboardReady(page) {
  await page.waitForSelector('nav.main-navigation', { timeout: 20_000 });
  // Real page content replaces the spinner only once the initial
  // settings/API-key load resolved.
  await page.waitForFunction(
    () => {
      const content = document.querySelector('.app-content');
      return Boolean(content) && content.children.length > 0 && !content.querySelector('.page-loading');
    },
    null,
    { timeout: 30_000, polling: 50 }
  );
}

/**
 * The drawer commits its DOM before the effect that copies the saved settings
 * into the draft state runs, so every field is blank for a frame. Wait until the
 * field values stop changing before reading or typing.
 */
async function waitForDrawerSettled(page) {
  const readValues = () =>
    page.$$eval('dialog.settings-drawer input, dialog.settings-drawer select', (fields) =>
      fields.map((field) => field.value).join(' ')
    );
  let previous = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await readValues();
    if (previous !== null && current === previous) return;
    previous = current;
    await sleep(80);
  }
}

async function openSettingsDrawer(page) {
  await waitForDashboardReady(page);
  await page.click('button.settings-navigation');
  await page.waitForSelector('dialog.settings-drawer', { state: 'visible', timeout: 10_000 });
  await waitForDrawerSettled(page);
}

async function closeSettingsDrawer(page) {
  if ((await page.locator('.drawer-backdrop').count()) === 0) return;
  await page.keyboard.press('Escape');
  await page.waitForSelector('.drawer-backdrop', { state: 'detached', timeout: 10_000 }).catch(() => undefined);
}

async function saveSettingsDrawer(page) {
  await page.click('dialog.settings-drawer button[type="submit"]');
  await page.waitForSelector('.toast-region .toast-success', { timeout: 15_000 });
  const toast = (await page.locator('.toast-region .toast-success').first().innerText()).trim();
  const formError = await page.locator('dialog.settings-drawer .form-error').count();
  assertEqual(formError, 0, 'Settings drawer reported a form error while saving');
  return toast;
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  await fsp.rm(ARTIFACTS, { recursive: true, force: true });
  await fsp.mkdir(ARTIFACTS, { recursive: true });

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cla-e2e-'));
  const { extDir, hostPermissions } = await prepareTestBuild(tempRoot);
  process.stdout.write(`Extension copy: ${extDir}\nhost_permissions: ${hostPermissions.join(', ')}\n`);

  const { server, url: promoUrl } = await startPromoServer();
  process.stdout.write(`Local promo site: ${promoUrl}\n`);

  const launchArgs = [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ];

  let context = null;
  let mode = '';
  // Extensions need the full Chromium build; the new headless mode supports
  // them, so try that first and fall back to headful.
  for (const attempt of [
    { label: 'headless(channel:chromium)', options: { channel: 'chromium', headless: true } },
    { label: 'headful', options: { headless: false } },
  ]) {
    const profileDir = path.join(tempRoot, `profile-${attempt.label.replace(/\W+/g, '-')}`);
    await fsp.mkdir(profileDir, { recursive: true });
    try {
      const candidate = await chromium.launchPersistentContext(profileDir, {
        ...attempt.options,
        args: launchArgs,
        viewport: { width: 1440, height: 1000 },
      });
      const found = await discoverExtensionId(candidate, extDir, 12_000);
      if (found.source !== 'serviceWorker') {
        await candidate.close();
        process.stdout.write(`  ${attempt.label}: no MV3 service worker appeared, retrying\n`);
        continue;
      }
      context = candidate;
      mode = attempt.label;
      context.__extensionId = found.id;
      break;
    } catch (error) {
      process.stdout.write(`  ${attempt.label} launch failed: ${error.message}\n`);
    }
  }
  if (!context) {
    server.close();
    throw new Error('Could not launch Chromium with the extension loaded (headless and headful both failed).');
  }

  const extensionId = context.__extensionId;
  process.stdout.write(`Launched ${mode}; extension id ${extensionId}\n`);

  context.on('page', attachConsole);
  for (const page of context.pages()) attachConsole(page);

  const dashboardUrl = `chrome-extension://${extensionId}/dashboard.html`;
  const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;

  const dashboard = await context.newPage();
  let sidepanel = null;

  /* ---------------------------------------------------------------- T1 ---- */
  await runTest('T1', 'dashboard.html loads with navigation', async () => {
    await dashboard.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
    await dashboard.waitForSelector('nav.main-navigation', { timeout: 20_000 });
    await dashboard.waitForSelector('.app-sidebar', { timeout: 20_000 });
    const navText = await dashboard.locator('nav.main-navigation').innerText();
    // Actual zh-CN nav labels shipped by the dashboard.
    for (const label of ['运营看板', '计划管理', '定时复查', '过滤列表', '外链库']) {
      assertIncludes(navText, label, `Navigation is missing the "${label}" item`);
    }
    assert(
      (await dashboard.locator('button.settings-navigation').count()) === 1,
      'Settings button missing from the sidebar'
    );
    await shot(dashboard, 'T1-dashboard');
    const errors = extensionErrorsFor('T1');
    assertEqual(errors.length, 0, `Uncaught page errors on dashboard:\n${JSON.stringify(errors, null, 2)}`);
    return `nav items: ${navText.split('\n').filter(Boolean).join(' / ')}`;
  });

  /* ---------------------------------------------------------------- T2 ---- */
  await runTest('T2', 'settings drawer is editable and persists', async () => {
    try {
      return await settingsDrawerTest();
    } finally {
      await closeSettingsDrawer(dashboard).catch(() => undefined);
    }
  });

  async function settingsDrawerTest() {
    await openSettingsDrawer(dashboard);
    const required = [
      '#settings-provider',
      '#settings-deepseek-key',
      '#settings-site-select',
      '#settings-site-label',
      '#settings-site-url',
      '#settings-site-display-name',
      '#settings-site-email',
      '#settings-site-link-mode',
      '#settings-locale',
      'dialog.settings-drawer button[type="submit"]',
    ];
    for (const selector of required) {
      assertEqual(await dashboard.locator(selector).count(), 1, `Settings drawer is missing ${selector}`);
    }
    assertEqual(
      await dashboard.locator('#settings-deepseek-key').getAttribute('type'),
      'password',
      'API key field should be a password input'
    );

    await dashboard.selectOption('#settings-provider', SETTINGS.provider);
    await dashboard.fill('#settings-deepseek-key', SETTINGS.apiKey);
    await dashboard.fill('#settings-site-label', SETTINGS.siteLabel);
    await dashboard.fill('#settings-site-url', SETTINGS.websiteUrl);
    await dashboard.fill('#settings-site-display-name', SETTINGS.displayName);
    await dashboard.fill('#settings-site-email', 'e2e@example.com');
    await dashboard.selectOption('#settings-site-link-mode', 'a-tag-newline');
    await shot(dashboard, 'T2a-settings-filled');

    const toast = await saveSettingsDrawer(dashboard);
    assertIncludes(toast, '设置已保存', 'Save did not produce the success toast');
    await shot(dashboard, 'T2b-settings-saved');
    await closeSettingsDrawer(dashboard);

    await dashboard.reload({ waitUntil: 'domcontentloaded' });
    await openSettingsDrawer(dashboard);
    const persisted = await dashboard.evaluate(() => ({
      provider: document.querySelector('#settings-provider')?.value ?? null,
      apiKey: document.querySelector('#settings-deepseek-key')?.value ?? null,
      label: document.querySelector('#settings-site-label')?.value ?? null,
      websiteUrl: document.querySelector('#settings-site-url')?.value ?? null,
      displayName: document.querySelector('#settings-site-display-name')?.value ?? null,
      email: document.querySelector('#settings-site-email')?.value ?? null,
      locale: document.querySelector('#settings-locale')?.value ?? null,
    }));
    await shot(dashboard, 'T2c-settings-after-reload');
    assertEqual(persisted.provider, SETTINGS.provider, 'Provider did not persist');
    assertEqual(persisted.apiKey, SETTINGS.apiKey, 'API key did not persist');
    assertEqual(persisted.label, SETTINGS.siteLabel, 'Site label did not persist');
    assertEqual(persisted.websiteUrl, SETTINGS.websiteUrl, 'Website URL did not persist');
    assertEqual(persisted.displayName, SETTINGS.displayName, 'Display name did not persist');
    assertEqual(persisted.email, 'e2e@example.com', 'Email did not persist');
    assertEqual(persisted.locale, 'zh-CN', 'Locale did not persist');
    return `persisted after reload: ${JSON.stringify(persisted)}`;
  }

  /* ---------------------------------------------------------------- T3 ---- */
  await runTest('T3', 'sidepanel is slimmed down', async () => {
    sidepanel = await context.newPage();
    await sidepanel.goto(sidepanelUrl, { waitUntil: 'domcontentloaded' });
    await sidepanel.waitForSelector('main.shell:not(.loading)', { timeout: 20_000 });

    assertEqual(await sidepanel.locator('#settings-provider').count(), 0, 'Sidepanel still renders a provider select');
    assertEqual(
      await sidepanel.locator('select option[value="deepseek"], select option[value="kie-gemini"]').count(),
      0,
      'Sidepanel still renders provider options'
    );
    assertEqual(await sidepanel.locator('input[type="password"]').count(), 0, 'Sidepanel still renders an API key input');
    assertEqual(
      await sidepanel.locator('#settings-deepseek-key, #settings-kie-key').count(),
      0,
      'Sidepanel still renders API key fields'
    );

    const dashboardButton = sidepanel.locator('button.dashboard-link');
    assertEqual(await dashboardButton.count(), 1, 'Sidepanel is missing the open-dashboard button');
    assertIncludes(await dashboardButton.innerText(), '打开看板', 'Open-dashboard button text unexpected');
    assertEqual(await sidepanel.locator('textarea.target-editor').count(), 1, 'Sidepanel is missing the batch target textarea');

    await shot(sidepanel, 'T3-sidepanel');
    const errors = extensionErrorsFor('T3');
    assertEqual(errors.length, 0, `Uncaught page errors on sidepanel:\n${JSON.stringify(errors, null, 2)}`);
    return 'no provider select / api key input; has open-dashboard + target textarea';
  });

  /* ---------------------------------------------------------------- T4 ---- */
  await runTest('T4', 'outbound link library import preview', async () => {
    const csvPath = path.join(tempRoot, 'outbound-links.csv');
    await fsp.writeFile(csvPath, IMPORT_CSV, 'utf8');

    await dashboard.bringToFront();
    await closeSettingsDrawer(dashboard);
    await waitForDashboardReady(dashboard);
    await dashboard.click('nav.main-navigation button:has-text("外链库")');
    await dashboard.waitForSelector('main.outbound-library-page', { timeout: 20_000 });

    const fileInput = dashboard.locator('main.outbound-library-page label.file-button input[type="file"]');
    assertEqual(await fileInput.count(), 1, 'Import file input not found on the outbound library page');
    await fileInput.setInputFiles(csvPath);

    await dashboard.waitForSelector('section.outbound-import-preview', { timeout: 20_000 });
    const previewText = await dashboard.locator('section.outbound-import-preview').innerText();
    await shot(dashboard, 'T4a-import-preview');

    const tableText = await dashboard.locator('table.outbound-import-preview-table').innerText();
    assertIncludes(tableText, 'https://example-one.test/post', 'Preview table missing the first URL');
    assertIncludes(tableText, 'https://example-two.test/article', 'Preview table missing the second URL');

    const errorItems = await dashboard.locator('section.outbound-import-preview ul.form-messages li').allInnerTexts();
    assert(errorItems.length > 0, 'Preview showed no invalid-row message for the URL-less row');
    const joined = errorItems.join(' | ');
    assertIncludes(joined, '缺少', 'Invalid-row message is not the friendly zh copy');
    assert(!/URL_REQUIRED/.test(previewText), `Raw error code URL_REQUIRED leaked into the UI: ${joined}`);

    await dashboard.click('section.outbound-import-preview button:has-text("取消")');
    await dashboard.waitForSelector('section.outbound-import-preview', { state: 'detached', timeout: 10_000 });
    assertEqual(await dashboard.locator('section.outbound-import-preview').count(), 0, 'Preview did not clear after 取消');
    await shot(dashboard, 'T4b-import-cleared');
    return `invalid row copy: ${joined}`;
  });

  /* ---------------------------------------------------------------- T5 ---- */
  await runTest('T5', 'batch stop is immediate', async () => {
    // The batch cannot start until the promoted site's meta can be fetched, and
    // example-promo.test is deliberately unresolvable. Point the site at the
    // local stub for this test only.
    await dashboard.bringToFront();
    await closeSettingsDrawer(dashboard);
    await waitForDashboardReady(dashboard);
    await dashboard.click('nav.main-navigation button:has-text("运营看板")');
    await openSettingsDrawer(dashboard);
    await dashboard.fill('#settings-site-url', promoUrl);
    await saveSettingsDrawer(dashboard);
    await closeSettingsDrawer(dashboard);

    await sidepanel.bringToFront();
    await sidepanel.reload({ waitUntil: 'domcontentloaded' });
    await sidepanel.waitForSelector('main.shell:not(.loading)', { timeout: 20_000 });

    await sidepanel.fill('textarea.target-editor', BATCH_TARGETS.join('\n'));
    await sidepanel.click('section.workspace-panel button.primary-button');

    // Step 02 (review/confirm) appears once the promoted site's meta is read.
    await Promise.race([
      sidepanel.waitForSelector('section.review-panel', { timeout: 45_000 }),
      sidepanel.waitForSelector('p.error-toast', { timeout: 45_000 }).then(async () => {
        const message = await sidepanel.locator('p.error-toast').innerText();
        throw new Error(`Batch preview failed: ${message}`);
      }),
    ]);
    await shot(sidepanel, 'T5a-review');
    await sidepanel.click('section.review-panel button.publish-button');

    await sidepanel.waitForSelector('section.batch-panel .stop-button', { timeout: 45_000 });
    // Let the first item actually start before stopping.
    await sidepanel
      .waitForFunction(
        () => {
          const first = document.querySelector('.site-flow-list .site-flow-card');
          return Boolean(first) && !first.classList.contains('status-queued');
        },
        null,
        { timeout: 8_000, polling: 50 }
      )
      .catch(() => undefined);

    const headingBefore = await sidepanel.locator('.batch-heading h2').innerText();
    assert(
      !headingBefore.includes('批次已停止') && !headingBefore.includes('批次已完成'),
      `Batch reached a terminal state (${headingBefore}) before the stop click could be measured`
    );
    await shot(sidepanel, 'T5b-running');

    const stopButton = sidepanel.locator('section.batch-panel .stop-button').first();
    assertEqual(await stopButton.isDisabled(), false, 'Stop button was disabled while the batch was running');

    const t0 = Date.now();
    await stopButton.click();
    await sidepanel.waitForFunction(
      () => document.querySelector('.batch-heading h2')?.textContent?.includes('批次已停止') ?? false,
      null,
      { timeout: 30_000, polling: 25 }
    );
    const stopLatencyMs = Date.now() - t0;
    await shot(sidepanel, 'T5c-stopped');

    // The stop control must not stay stuck in a disabled/busy state.
    const controlReadyAt = Date.now();
    await sidepanel.waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll('section.batch-panel button')];
        return buttons.length > 0 && buttons.some((button) => !button.disabled);
      },
      null,
      { timeout: 10_000, polling: 50 }
    );
    const controlsEnabledMs = Date.now() - controlReadyAt;

    const snapshot = async () => ({
      heading: (await sidepanel.locator('.batch-heading h2').innerText()).trim(),
      progress: (await sidepanel.locator('.batch-heading strong').innerText()).trim(),
      statuses: await sidepanel.$$eval('.site-flow-list .site-flow-card', (cards) =>
        cards.map((card) => [...card.classList].filter((name) => name.startsWith('status-')).join(','))
      ),
    });
    const afterStop = await snapshot();
    await sleep(10_000);
    const tenSecondsLater = await snapshot();
    await shot(sidepanel, 'T5d-after-10s');

    assertEqual(
      JSON.stringify(tenSecondsLater),
      JSON.stringify(afterStop),
      'Batch kept progressing after the stop'
    );
    assert(
      stopLatencyMs < 5_000,
      `Stop took ${stopLatencyMs}ms to reach 已停止 (budget 5000ms)`
    );
    assert(
      controlsEnabledMs < 5_000,
      `Batch controls stayed disabled for ${controlsEnabledMs}ms after the stop`
    );
    return `stop latency ${stopLatencyMs}ms; controls re-enabled in ${controlsEnabledMs}ms; state ${JSON.stringify(afterStop)}`;
  });

  /* ---------------------------------------------------------------- T6 ---- */
  await runTest('T6', 'console sweep on extension pages', async () => {
    const all = consoleRecords.filter((record) => isExtensionOrigin(record.where));
    const errors = extensionErrorsFor(undefined);
    const ignored = all.filter(
      (record) => (record.type === 'error' || record.type === 'pageerror') && isNoise(record)
    );
    await fsp.writeFile(path.join(ARTIFACTS, 'console.json'), JSON.stringify(consoleRecords, null, 2));
    process.stdout.write(
      `  extension console records: ${all.length}, ignored network noise: ${ignored.length}, real errors: ${errors.length}\n`
    );
    for (const record of errors) process.stdout.write(`    [${record.test}] ${record.type}: ${record.text}\n`);
    assertEqual(errors.length, 0, `Uncaught extension errors:\n${JSON.stringify(errors, null, 2)}`);
    return `${all.length} extension console records, ${ignored.length} ignored as network noise`;
  });

  /* ---------------------------------------------------------------- done -- */
  await fsp.writeFile(
    path.join(ARTIFACTS, 'results.json'),
    JSON.stringify({ mode, extensionId, ranAt: new Date().toISOString(), results }, null, 2)
  );

  await context.close().catch(() => undefined);
  server.close();
  await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);

  const failed = results.filter((result) => result.status === 'FAIL');
  process.stdout.write('\n──────── summary ────────\n');
  for (const result of results) {
    process.stdout.write(`${result.status === 'PASS' ? '✔' : '✘'} ${result.id} ${result.name} (${result.ms}ms)\n`);
  }
  process.stdout.write(`Artifacts: ${ARTIFACTS}\n`);
  if (failed.length > 0) {
    process.stdout.write(`${failed.length} test(s) failed.\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
