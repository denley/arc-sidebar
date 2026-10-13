// Development harness: boots a throwaway headless Chromium with the extension,
// opens the side panel UI in a popup sized like the real side panel, and runs
// a scenario script against it.
//
//   node tools/dev.mjs                 # screenshot to /tmp/arc-sidebar.png
//   node tools/dev.mjs scenario.mjs    # run a scenario module (default export)

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attach, launch, sleep, waitForTarget } from './cdp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function boot({ port = 9400 + Math.floor(Math.random() * 400), width = 320, height = 860 } = {}) {
  const chrome = await launch({ extDir: root, port });
  const swTarget = await waitForTarget(chrome.browser, (t) => t.type === 'service_worker' && t.url.includes('background.js'));
  const extId = new URL(swTarget.url).host;
  const sw = await attach(chrome.browser, swTarget.targetId);
  // Wait for the extension APIs and the engine.
  for (let i = 0; i < 50; i++) {
    try {
      if (await sw.evaluate('typeof engine !== "undefined" && !!chrome.tabs')) break;
    } catch {}
    await sleep(100);
  }
  await sw.evaluate('engine.ready.then(() => engine.chain)');

  const mainWindow = await sw.evaluate(`chrome.windows.getAll({windowTypes:['normal']}).then(w => w[0].id)`);

  const openPanel = async () => {
    const url = `chrome-extension://${extId}/src/panel/panel.html?window=${mainWindow}`;
    await sw.evaluate(`chrome.windows.create({ type: 'popup', url: ${JSON.stringify(url)}, width: ${width}, height: ${height} })`);
    const t = await waitForTarget(chrome.browser, (x) => x.type === 'page' && x.url.startsWith(url.split('?')[0]));
    const page = await attach(chrome.browser, t.targetId);
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    await sleep(600);
    return page;
  };

  const shot = async (page, path) => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  };

  // Wait for the engine queue to drain and the panel to re-render.
  const settle = async (ms = 400) => {
    await sw.evaluate('engine.chain');
    await sleep(ms);
    await sw.evaluate('engine.chain');
  };

  return { chrome, sw, extId, mainWindow, openPanel, shot, settle, close: chrome.close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = await boot();
  try {
    const scenario = process.argv[2] ? (await import(resolve(process.argv[2]))).default : null;
    if (scenario) {
      await scenario(env);
    } else {
      const page = await env.openPanel();
      await env.settle(800);
      console.log(await env.shot(page, '/tmp/arc-sidebar.png'));
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await Promise.race([env.close(), sleep(3000)]);
    process.exit();
  }
}
