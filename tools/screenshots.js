#!/usr/bin/env node
/**
 * Screenshot driver.
 *
 * Connects to a demo server (default http://127.0.0.1:55557) that has been
 * pre-seeded with a believable class state (PIN 1234), then captures:
 *   - student-desktop.png        Student page, garden full of trees
 *   - student-mobile.png         Same but mobile viewport
 *   - student-pin.png            PIN modal first-visit
 *   - teacher-desktop.png        Teacher overview (long page)
 *   - teacher-schedule.png       Teacher schedule editor only
 *   - teacher-mobile.png         Teacher page on phone
 *   - teacher-call-mobile.png    Remote-camera card on phone
 *
 * Uses puppeteer-core with the system chromium binary — no extra download.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.DEMO_URL || 'http://127.0.0.1:55557';
const PIN  = '1234';
const OUT  = path.resolve(__dirname, '..', 'docs', 'screenshots');
const CHROMIUM = '/usr/bin/chromium';

fs.mkdirSync(OUT, { recursive: true });

async function shoot(page, name, opts = {}) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, ...opts });
  const size = fs.statSync(file).size;
  console.log('  ✔', name + '.png', '(' + (size/1024).toFixed(1) + ' KB)');
}

async function elementShot(page, selector, name) {
  const el = await page.$(selector);
  if (!el) throw new Error('no such element: ' + selector);
  const file = path.join(OUT, name + '.png');
  await el.screenshot({ path: file });
  console.log('  ✔', name + '.png (element)');
}

async function settle(page, ms = 800) {
  await new Promise(r => setTimeout(r, ms));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
    ],
  });

  try {
    // --- 1. Student PIN modal (no localStorage yet) ---
    {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: 1100, height: 720, deviceScaleFactor: 2 });
      await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 15000 });
      await settle(page, 600);
      await shoot(page, 'student-pin');
      await ctx.close();
    }

    // --- 2. Student desktop (PIN seeded into localStorage) ---
    {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: 1100, height: 1100, deviceScaleFactor: 2 });
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(p => localStorage.setItem('quiet-tree-pin', p), PIN);
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page, 1500);   // let SSE arrive + tree-grow animations finish
      await shoot(page, 'student-desktop', { fullPage: true });
      await ctx.close();
    }

    // --- 3. Student mobile ---
    {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true });
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(p => localStorage.setItem('quiet-tree-pin', p), PIN);
      await page.reload({ waitUntil: 'networkidle2' });
      await settle(page, 1500);
      await shoot(page, 'student-mobile', { fullPage: true });
      await ctx.close();
    }

    // --- 4. Teacher desktop (full page) ---
    {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
      await page.goto(BASE + '/teacher/' + PIN, { waitUntil: 'networkidle2', timeout: 15000 });
      await settle(page, 1500);
      await shoot(page, 'teacher-desktop', { fullPage: true });

      // also capture just the schedule card
      const cards = await page.$$('main .card');
      // schedule is the 4th card (status, garden(no padding), threshold, bark, schedule, webrtc)
      // count from DOM order
      let scheduleCard = null;
      for (const c of cards) {
        const title = await c.$eval('.card-title', el => el.textContent).catch(() => '');
        if (title.includes('监听时段')) { scheduleCard = c; break; }
      }
      if (scheduleCard) {
        const file = path.join(OUT, 'teacher-schedule.png');
        await scheduleCard.screenshot({ path: file });
        console.log('  ✔ teacher-schedule.png (card)');
      }
      await ctx.close();
    }

    // --- 5. Teacher mobile (full page) ---
    {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true });
      await page.goto(BASE + '/teacher/' + PIN, { waitUntil: 'networkidle2', timeout: 15000 });
      await settle(page, 1500);
      await shoot(page, 'teacher-mobile', { fullPage: true });

      // crop to remote-camera card only
      const cards = await page.$$('main .card');
      let webrtcCard = null;
      for (const c of cards) {
        const title = await c.$eval('.card-title', el => el.textContent).catch(() => '');
        if (title.includes('远程摄像头')) { webrtcCard = c; break; }
      }
      if (webrtcCard) {
        const file = path.join(OUT, 'teacher-call-mobile.png');
        await webrtcCard.screenshot({ path: file });
        console.log('  ✔ teacher-call-mobile.png (card)');
      }
      await ctx.close();
    }

  } finally {
    await browser.close();
  }
  console.log('\nDone. Output: ' + OUT);
})();
