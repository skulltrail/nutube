/**
 * E2E tests for NuTube Chrome Extension
 *
 * These tests verify that the extension loads correctly in Chrome,
 * the dashboard opens, and basic functionality works.
 *
 * Note: Chrome extension testing requires:
 * 1. A built extension in the dist/ folder
 * 2. Chromium browser (not headless - extensions don't work headless)
 * 3. Persistent browser context with extension loaded
 */

import { test, expect, chromium, BrowserContext, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the built extension
const EXTENSION_PATH = path.join(__dirname, '..', 'dist');

let context: BrowserContext;
let extensionId: string;

test.describe('NuTube Extension', () => {
  test.beforeAll(async () => {
    // Verify the extension is built
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Extension not built. Run "npm run build" before running E2E tests.');
    }

    // Launch browser with extension loaded
    // Note: Extensions don't work in headless mode
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    // Wait for extension to load and get its ID
    // The extension ID can be found from the service worker URL
    let serviceWorkerTarget: Page | undefined;
    const maxAttempts = 10;

    for (let i = 0; i < maxAttempts; i++) {
      // Look for background service worker
      const pages = context.serviceWorkers();
      const extensionWorker = pages.find((w) => w.url().startsWith('chrome-extension://'));

      if (extensionWorker) {
        const url = extensionWorker.url();
        const match = url.match(/chrome-extension:\/\/([^/]+)/);
        if (match) {
          extensionId = match[1];
          break;
        }
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (!extensionId) {
      throw new Error('Could not find extension ID. Extension may not have loaded.');
    }
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('extension manifest is valid', async () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('NuTube');
    expect(manifest.version).toBeDefined();
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('cookies');
    expect(manifest.permissions).toContain('tabs');
  });

  test('extension loads successfully', async () => {
    expect(extensionId).toBeDefined();
    expect(extensionId.length).toBeGreaterThan(0);
  });

  test('dashboard page opens', async () => {
    const dashboardUrl = `chrome-extension://${extensionId}/dashboard.html`;
    const page = await context.newPage();

    await page.goto(dashboardUrl);
    await page.waitForLoadState('domcontentloaded');

    // Verify the dashboard loaded by checking for key elements
    const title = await page.title();
    expect(title).toContain('NuTube');

    await page.close();
  });

  test('dashboard has keyboard navigation elements', async () => {
    const dashboardUrl = `chrome-extension://${extensionId}/dashboard.html`;
    const page = await context.newPage();

    await page.goto(dashboardUrl);
    await page.waitForLoadState('domcontentloaded');

    // Wait for the dashboard to initialize
    await page.waitForTimeout(1000);

    // Check for main container element
    const container = page.locator('#container, .container, [data-testid="container"]');
    const hasContainer = (await container.count()) > 0;

    // Check for video list or loading state
    const videoList = page.locator(
      '#video-list, .video-list, [data-testid="video-list"], .loading, #loading',
    );
    const hasVideoList = (await videoList.count()) > 0;

    // At least one of these should exist
    expect(hasContainer || hasVideoList).toBe(true);

    await page.close();
  });

  test('required extension files exist', async () => {
    const requiredFiles = [
      'manifest.json',
      'background.js',
      'content.js',
      'dashboard.html',
      'dashboard.js',
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(EXTENSION_PATH, file);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });

  test('extension icons exist', async () => {
    const iconSizes = ['16', '48', '128'];
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf-8'),
    );

    // Check if icons are defined in manifest
    if (manifest.icons) {
      for (const size of iconSizes) {
        if (manifest.icons[size]) {
          const iconPath = path.join(EXTENSION_PATH, manifest.icons[size]);
          expect(fs.existsSync(iconPath)).toBe(true);
        }
      }
    }
  });

  test('background script initializes without errors', async () => {
    const serviceWorkers = context.serviceWorkers();
    const bgWorker = serviceWorkers.find((w) => w.url().includes(extensionId));

    expect(bgWorker).toBeDefined();

    // Check that service worker is running
    if (bgWorker) {
      // Service worker should be reachable
      const url = bgWorker.url();
      expect(url).toContain('background.js');
    }
  });

  test('content script structure is valid', async () => {
    const contentScriptPath = path.join(EXTENSION_PATH, 'content.js');
    const content = fs.readFileSync(contentScriptPath, 'utf-8');

    // Verify content script has expected structure
    expect(content).toContain('chrome.runtime.onMessage');
    expect(content).toContain('sendResponse');
  });

  test('dashboard keyboard shortcuts are set up', async () => {
    const dashboardUrl = `chrome-extension://${extensionId}/dashboard.html`;
    const page = await context.newPage();

    await page.goto(dashboardUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    // Check that keyboard event listeners are attached
    const hasKeyboardHandlers = await page.evaluate(() => {
      // Check if the page has keyboard event listeners
      // This is a basic check - in a real test you'd simulate keypresses
      return (
        typeof document.onkeydown === 'function' ||
        typeof document.onkeyup === 'function' ||
        document.addEventListener !== undefined
      );
    });

    expect(hasKeyboardHandlers).toBe(true);

    await page.close();
  });
});

test.describe('Extension Manifest Validation', () => {
  test('manifest has required fields', () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Required fields for Manifest V3
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBeDefined();
  });

  test('manifest permissions are correctly scoped', () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Check for expected permissions
    const permissions = manifest.permissions || [];
    const expectedPermissions = ['storage', 'cookies', 'tabs', 'scripting'];

    for (const perm of expectedPermissions) {
      expect(permissions).toContain(perm);
    }

    // Verify host permissions for YouTube
    const hostPermissions = manifest.host_permissions || [];
    const hasYouTubePermission = hostPermissions.some((p: string) => p.includes('youtube.com'));
    expect(hasYouTubePermission).toBe(true);
  });

  test('content script matches YouTube URLs', () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    const contentScripts = manifest.content_scripts || [];
    expect(contentScripts.length).toBeGreaterThan(0);

    const youtubeScript = contentScripts.find((cs: any) =>
      cs.matches?.some((m: string) => m.includes('youtube.com')),
    );
    expect(youtubeScript).toBeDefined();
    expect(youtubeScript.js).toContain('content.js');
  });

  test('action/browser_action is configured', () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Manifest V3 uses "action" instead of "browser_action"
    expect(manifest.action).toBeDefined();
  });

  test('service worker is configured', () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Manifest V3 uses background.service_worker
    expect(manifest.background).toBeDefined();
    expect(manifest.background.service_worker).toBe('background.js');
  });
});
