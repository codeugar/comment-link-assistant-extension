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

  // Site origins are granted at install, so the batch never prompts. The run
  // uses the shipped manifest verbatim and fails loudly if that stops being
  // true, rather than quietly patching the permission in and testing something
  // the user never gets.
  const manifest = JSON.parse(await fsp.readFile(path.join(extDir, 'manifest.json'), 'utf8'));
  const host = new Set(manifest.host_permissions ?? []);
  const missing = ['http://*/*', 'https://*/*'].filter((pattern) => !host.has(pattern));
  if (missing.length > 0) {
    throw new Error(
      `Build declares no install-time access to ${missing.join(', ')}; the batch would need a runtime permission prompt.`
    );
  }
  return { extDir, hostPermissions: [...host] };
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
  await waitForToastsToClear(page);
  await page.click('dialog.settings-drawer button[type="submit"]');
  await page.waitForSelector('.toast-region .toast-success', { timeout: 15_000 });
  const toast = (await page.locator('.toast-region .toast-success').first().innerText()).trim();
  const formError = await page.locator('dialog.settings-drawer .form-error').count();
  assertEqual(formError, 0, 'Settings drawer reported a form error while saving');
  return toast;
}

/**
 * Toasts linger for a few seconds, so a save that follows an earlier one has to
 * start from an empty region or it would read the previous toast back.
 */
async function waitForToastsToClear(page) {
  await page
    .waitForFunction(() => document.querySelectorAll('.toast-region .toast-success').length === 0, null, {
      timeout: 10_000,
      polling: 100,
    })
    .catch(() => undefined);
}

async function openSitesPage(page) {
  await closeSettingsDrawer(page);
  await waitForDashboardReady(page);
  await page.click('nav.main-navigation button:has-text("网站管理")');
  await page.waitForSelector('main.sites-page', { timeout: 20_000 });
  await page.waitForSelector('#site-label', { timeout: 10_000 });
}

async function saveSitesPage(page) {
  await waitForToastsToClear(page);
  await page.click('main.sites-page button[type="submit"]');
  await page.waitForSelector('.toast-region .toast-success', { timeout: 15_000 });
  const toast = (await page.locator('.toast-region .toast-success').first().innerText()).trim();
  const formError = await page.locator('main.sites-page .form-error').count();
  assertEqual(formError, 0, 'Websites page reported a form error while saving');
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
    for (const label of ['运营看板', '计划管理', '网站管理', '定时复查', '过滤列表', '外链库']) {
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
      '#settings-locale',
      'dialog.settings-drawer button[type="submit"]',
    ];
    for (const selector of required) {
      assertEqual(await dashboard.locator(selector).count(), 1, `Settings drawer is missing ${selector}`);
    }
    // Site profiles and the anchor mix live on the websites page now.
    for (const selector of [
      '#settings-site-select',
      '#settings-site-label',
      '#settings-site-url',
      '#settings-site-display-name',
      '#settings-site-email',
      '#settings-site-link-mode',
      '.anchor-mix',
    ]) {
      assertEqual(await dashboard.locator(selector).count(), 0, `Settings drawer still renders ${selector}`);
    }
    assertEqual(
      await dashboard.locator('#settings-deepseek-key').getAttribute('type'),
      'password',
      'API key field should be a password input'
    );

    await dashboard.selectOption('#settings-provider', SETTINGS.provider);
    await dashboard.fill('#settings-deepseek-key', SETTINGS.apiKey);
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
      locale: document.querySelector('#settings-locale')?.value ?? null,
    }));
    await shot(dashboard, 'T2c-settings-after-reload');
    assertEqual(persisted.provider, SETTINGS.provider, 'Provider did not persist');
    assertEqual(persisted.apiKey, SETTINGS.apiKey, 'API key did not persist');
    assertEqual(persisted.locale, 'zh-CN', 'Locale did not persist');
    return `persisted after reload: ${JSON.stringify(persisted)}`;
  }

  /* --------------------------------------------------------------- T2S ---- */
  await runTest('T2S', 'websites page owns the site profile', async () => {
    await closeSettingsDrawer(dashboard).catch(() => undefined);
    await openSitesPage(dashboard);

    assertEqual(
      await dashboard.locator('dialog.settings-drawer').count(),
      0,
      'Opening the websites page left the settings drawer up'
    );
    for (const selector of ['#site-label', '#site-url', '#site-display-name', '#site-email', '#site-link-mode']) {
      assertEqual(await dashboard.locator(selector).count(), 1, `Websites page is missing ${selector}`);
    }
    assertEqual(await dashboard.locator('.sites-list button').count(), 1, 'Websites page should list exactly one site');

    await dashboard.fill('#site-label', SETTINGS.siteLabel);
    await dashboard.fill('#site-url', SETTINGS.websiteUrl);
    await dashboard.fill('#site-display-name', SETTINGS.displayName);
    await dashboard.fill('#site-email', 'e2e@example.com');
    await dashboard.selectOption('#site-link-mode', 'a-tag-newline');
    // Unsaved edits are called out before the save lands.
    await dashboard.waitForSelector('.sites-save-bar:has-text("有未保存的修改")', { timeout: 5_000 });
    await shot(dashboard, 'T2Sa-sites-filled');

    const toast = await saveSitesPage(dashboard);
    assertIncludes(toast, '设置已保存', 'Saving the websites page did not produce the success toast');
    await shot(dashboard, 'T2Sb-sites-saved');

    await dashboard.reload({ waitUntil: 'domcontentloaded' });
    await openSitesPage(dashboard);
    const persisted = await dashboard.evaluate(() => ({
      label: document.querySelector('#site-label')?.value ?? null,
      websiteUrl: document.querySelector('#site-url')?.value ?? null,
      displayName: document.querySelector('#site-display-name')?.value ?? null,
      email: document.querySelector('#site-email')?.value ?? null,
      linkMode: document.querySelector('#site-link-mode')?.value ?? null,
    }));
    await shot(dashboard, 'T2Sc-sites-after-reload');
    assertEqual(persisted.label, SETTINGS.siteLabel, 'Site label did not persist');
    assertEqual(persisted.websiteUrl, SETTINGS.websiteUrl, 'Website URL did not persist');
    assertEqual(persisted.displayName, SETTINGS.displayName, 'Display name did not persist');
    assertEqual(persisted.email, 'e2e@example.com', 'Email did not persist');
    assertEqual(persisted.linkMode, 'a-tag-newline', 'Link mode did not persist');

    const errors = extensionErrorsFor('T2S');
    assertEqual(errors.length, 0, `Uncaught page errors on the websites page:\n${JSON.stringify(errors, null, 2)}`);
    return `persisted after reload: ${JSON.stringify(persisted)}`;
  });

  /* --------------------------------------------------------------- T2X ---- */
  await runTest('T2X', 'anchor mix editor persists a site anchor plan', async () => {
    return await anchorMixTest();
  });

  async function anchorMixTest() {
    await openSitesPage(dashboard);
    // T2S left the site on a-tag-newline, the mode whose comment body carries
    // the anchor, so the mix editor must be present.
    await dashboard.waitForSelector('.anchor-mix', { timeout: 10_000 });

    const defaults = await dashboard.evaluate(() =>
      ['brand', 'naked', 'exact', 'partial', 'generic', 'natural'].map(
        (bucket) => document.querySelector(`#anchor-target-${bucket}`)?.value ?? null
      )
    );
    assertEqual(defaults.join(','), '30,20,20,15,10,5', 'Default anchor shares are wrong');

    // A share that breaks the 100% total surfaces the normalize affordance.
    await dashboard.fill('#anchor-target-brand', '40');
    await dashboard.waitForSelector('.anchor-mix-total-invalid', { timeout: 5_000 });
    await dashboard.click('.anchor-mix button:has-text("归一化到 100%")');
    await dashboard.waitForSelector('.anchor-mix-total-invalid', { state: 'detached', timeout: 5_000 });
    const normalized = await dashboard.evaluate(() =>
      ['brand', 'naked', 'exact', 'partial', 'generic', 'natural'].reduce(
        (sum, bucket) => sum + Number(document.querySelector(`#anchor-target-${bucket}`)?.value ?? 0),
        0
      )
    );
    assertEqual(normalized, 100, 'Normalize did not bring the shares back to 100');

    await dashboard.fill('#anchor-pool-brand', 'E2E 品牌\nE2E Brand');
    await dashboard.fill('#anchor-pool-exact', 'AI video generator');

    // Typed one key at a time, not set in one shot: a pool that re-renders its
    // parsed form on every keystroke eats the space that has not become a word
    // yet and the newline that has not become a line yet.
    await dashboard.locator('#anchor-pool-partial').click();
    await dashboard.locator('#anchor-pool-partial').pressSequentially('seedance 2.5\nseedance 2.5 model');
    assertEqual(
      await dashboard.locator('#anchor-pool-partial').inputValue(),
      'seedance 2.5\nseedance 2.5 model',
      'Typing a multi-word anchor into the pool did not survive keystroke by keystroke'
    );
    await dashboard.locator('#anchor-pool-exact').click();
    assertEqual(
      await dashboard.locator('#anchor-pool-partial').inputValue(),
      'seedance 2.5\nseedance 2.5 model',
      'Leaving the pool changed the wording that was typed'
    );
    await dashboard.click('.anchor-mix button:has-text("从网站链接填入")');
    await dashboard.click('.anchor-mix button:has-text("添加推荐词")');
    await shot(dashboard, 'T2X-anchor-mix');

    const beforeReload = await readAnchorMix(dashboard);
    assert(beforeReload.naked.includes(SETTINGS.websiteUrl), 'Bare URL fill did not add the website URL');
    assert(beforeReload.generic.length > 0, 'Generic suggestions added nothing');

    // The mix is stored outside the site profile form, so it must survive a
    // reload without that form ever being submitted.
    await dashboard.reload({ waitUntil: 'domcontentloaded' });
    await openSitesPage(dashboard);
    await dashboard.waitForSelector('.anchor-mix', { timeout: 10_000 });
    const afterReload = await readAnchorMix(dashboard);

    assertEqual(afterReload.brand, beforeReload.brand, 'Brand pool did not persist');
    assertEqual(afterReload.exact, beforeReload.exact, 'Exact keyword pool did not persist');
    assertEqual(afterReload.naked, beforeReload.naked, 'Bare URL pool did not persist');
    assertEqual(afterReload.partial, 'seedance 2.5\nseedance 2.5 model', 'Typed partial-match pool did not persist');
    assertEqual(afterReload.generic, beforeReload.generic, 'Generic pool did not persist');
    assertEqual(afterReload.total, 100, 'Shares did not persist as a whole mix');

    // Nothing has been published yet, so the tally must say so rather than
    // implying a 0% mix.
    const empty = await dashboard.locator('.anchor-mix-actual').first().innerText();
    assertIncludes(empty, '还没有已发布的外链', 'Empty tally is not reported');

    // Seed a tally the way the batch runner would, then confirm the editor
    // reports the mix those links actually produced.
    const siteId = await dashboard.evaluate(async () => {
      const stored = await chrome.storage.local.get('comment-link-assistant.settings');
      return stored['comment-link-assistant.settings'].activeSiteId;
    });
    await dashboard.evaluate(async (id) => {
      await chrome.storage.local.set({
        'comment-link-assistant.anchor-ledger': {
          [id]: {
            siteId: id,
            published: { brand: 6, naked: 4, exact: 4, partial: 3, generic: 2, natural: 1 },
            pending: [{ bucket: 'exact', targetUrl: 'https://blog.example/held', at: 1 }],
            texts: [
              { bucket: 'brand', text: 'E2E 品牌', count: 4, lastAt: 3 },
              { bucket: 'brand', text: 'E2E Brand', count: 1, lastAt: 2 },
              { bucket: 'exact', text: 'AI video generator', count: 4, lastAt: 4 },
            ],
            updatedAt: 1,
          },
        },
      });
    }, siteId);

    await dashboard.reload({ waitUntil: 'domcontentloaded' });
    await openSitesPage(dashboard);
    await dashboard.waitForSelector('.anchor-mix', { timeout: 10_000 });
    const tally = await dashboard.$$eval('.anchor-mix-actual', (nodes) =>
      nodes.map((node) => node.innerText.trim())
    );
    // 6 of 20 published links is 30%, matching the brand share exactly.
    assertIncludes(tally[0], '当前 30%（6 条）', 'Brand tally is wrong');
    assertIncludes(tally[2], '当前 20%（4 条）', 'Exact keyword tally is wrong');
    assertIncludes(tally[2], '另有 1 条待审核', 'A held comment is not reported alongside the tally');
    assertIncludes(tally[5], '当前 5%（1 条）', 'Natural tally is wrong');

    // The wording breakdown: ranked within its own bucket, bars scaled to the
    // busiest row, and honest about links whose wording was never recorded.
    const brandWords = await dashboard.$$eval(
      '.anchor-mix-row:has(#anchor-target-brand) .anchor-texts-row',
      (nodes) =>
        nodes.map((node) => ({
          text: node.querySelector('.anchor-texts-word')?.textContent ?? '',
          count: node.querySelector('.anchor-texts-count')?.textContent ?? '',
          share: node.style.getPropertyValue('--anchor-text-share'),
        }))
    );
    assertEqual(brandWords.length, 2, 'Brand wording breakdown did not render both rows');
    assertEqual(brandWords[0].text, 'E2E 品牌', 'Brand wording is not ranked by count');
    assertEqual(brandWords[0].count, '4 次', 'Brand wording count is wrong');
    assertEqual(brandWords[0].share, '100%', 'Busiest wording should fill the row');
    assertEqual(brandWords[1].share, '25%', 'Bar is not scaled against the busiest wording');
    const brandBlock = await dashboard
      .locator('.anchor-mix-row:has(#anchor-target-brand) .anchor-texts')
      .innerText();
    // 6 published against 5 with recorded wording.
    assertIncludes(brandBlock, '另有 1 条没有留下用词记录', 'Untracked wording is not reported');

    // A bucket whose links all predate the tally reports the gap and nothing
    // else; claiming it published nothing would contradict its own share.
    const nakedBlock = await dashboard
      .locator('.anchor-mix-row:has(#anchor-target-naked) .anchor-texts')
      .innerText();
    assertEqual(
      await dashboard.locator('.anchor-mix-row:has(#anchor-target-naked) .anchor-texts-row').count(),
      0,
      'Bare URL bucket should list no wording'
    );
    assertIncludes(nakedBlock, '另有 4 条没有留下用词记录', 'Untracked-only bucket is not explained');

    await dashboard.locator('.anchor-mix').scrollIntoViewIfNeeded();
    await shot(dashboard, 'T2X-anchor-mix-tally');

    const errors = extensionErrorsFor('T2X');
    assertEqual(errors.length, 0, `Uncaught page errors in the anchor mix editor:\n${JSON.stringify(errors, null, 2)}`);
    return `persisted pools: ${JSON.stringify(afterReload)}`;
  }

  async function readAnchorMix(page) {
    return page.evaluate(() => {
      const pool = (bucket) => document.querySelector(`#anchor-pool-${bucket}`)?.value ?? '';
      const buckets = ['brand', 'naked', 'exact', 'partial', 'generic', 'natural'];
      return {
        brand: pool('brand'),
        naked: pool('naked'),
        exact: pool('exact'),
        partial: pool('partial'),
        generic: pool('generic'),
        total: buckets.reduce(
          (sum, bucket) => sum + Number(document.querySelector(`#anchor-target-${bucket}`)?.value ?? 0),
          0
        ),
      };
    });
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
    await openSitesPage(dashboard);
    await dashboard.fill('#site-url', promoUrl);
    await saveSitesPage(dashboard);

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
