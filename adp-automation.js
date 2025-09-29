const puppeteer = require('puppeteer');

/**
 * Enhancement: Skips automation on holidays/leaves/weekends.
 * - Edit CONFIG.leaves below.
 * - Supports:
 *    - Specific dates: 'YYYY-MM-DD' (IST)
 *    - Date ranges: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } (inclusive)
 *    - Weekends: 'WEEKENDS' sentinel
 *    - Specific weekdays: 'MON','TUE','WED','THU','FRI','SAT','SUN'
 * - Override skip (force run) with env: FORCE_RUN=1
 */

const CONFIG = {
  location: {
    latitude: 17.4661607,
    longitude: 78.2846192,
    accuracy: 50
  },
  urls: {
    login: 'https://infoservices.securtime.adp.com/login?redirectUrl=%2Fwelcome',
    welcome: 'https://infoservices.securtime.adp.com/welcome'
  },
  timeout: 30000,
  delay: 2000,
  maxRetries: 2,

  // >>> Edit this leave/holiday list <<<
  // Examples shown; keep items you need and delete the rest.
  leaves: [
    // Skip all Saturdays & Sundays:
    'WEEKENDS',
    '2025-08-25',
    '2025-08-27',
    '2025-08-28',

    // Specific weekdays (optional): 'MON','TUE','WED','THU','FRI','SAT','SUN'
    // 'SAT', 'SUN',

    // One-off holidays/leaves (IST dates):
    // '2025-08-15',                      // Independence Day (example)
    // '2025-08-25', '2025-08-28',        // Individual leave days (examples)

    // Date ranges (inclusive):
    // { start: '2025-12-24', end: '2025-12-26' }, // Example: 3-day range
  ]
};

// ---- Time helpers (IST aware) ----
const IST_OFFSET_MINUTES = 330; // +05:30

function nowInIST() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + IST_OFFSET_MINUTES * 60000);
}

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }

function formatIST_YMD(dIST) {
  const y = dIST.getFullYear();
  const m = pad2(dIST.getMonth() + 1);
  const d = pad2(dIST.getDate());
  return `${y}-${m}-${d}`;
}

function istDayOfWeek(dIST) {
  // 0=Sun ... 6=Sat
  return dIST.getDay();
}

const DOW_NAME = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

// ---- Skip logic ----
function shouldSkipToday(leaves) {
  const todayIST = nowInIST();
  const todayYMD = formatIST_YMD(todayIST);
  const todayDOW = istDayOfWeek(todayIST);
  const todayDOWName = DOW_NAME[todayDOW];

  // Normalize list into a single pass check
  let reason = null;

  for (const item of leaves || []) {
    if (typeof item === 'string') {
      if (item === 'WEEKENDS' && (todayDOW === 0 || todayDOW === 6)) {
        reason = `Weekend (${todayDOWName})`;
        break;
      }
      if (/^(MON|TUE|WED|THU|FRI|SAT|SUN)$/.test(item) && item === todayDOWName) {
        reason = `Configured weekday skip (${item})`;
        break;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(item) && item === todayYMD) {
        reason = `Configured date skip (${item})`;
        break;
      }
    } else if (item && typeof item === 'object' && item.start && item.end) {
      // Lexicographic compare works for YYYY-MM-DD format
      if (item.start <= todayYMD && todayYMD <= item.end) {
        reason = `Configured range skip (${item.start}..${item.end})`;
        break;
      }
    }
  }

  return {
    skip: !!reason,
    reason: reason || ''
  };
}

async function setupBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setViewport({ width: 1366, height: 768 });
  await page.setGeolocation(CONFIG.location);
  const context = browser.defaultBrowserContext();
  await context.overridePermissions('https://infoservices.securtime.adp.com', ['geolocation']);
  return { browser, page };
}

async function checkPageState(page) {
  const pageInfo = await page.evaluate(() => {
    return {
      url: window.location.href,
      allButtons: Array.from(document.querySelectorAll('button')).map(btn => ({
        text: btn.textContent.trim(),
        visible: btn.offsetParent !== null
      }))
    };
  });
  const hasSignIn = pageInfo.allButtons.some(btn => btn.text.includes('Sign In'));
  const hasPunchIn = pageInfo.allButtons.some(btn => btn.text.includes('Punch In'));
  const hasPunchOut = pageInfo.allButtons.some(btn => btn.text.includes('Punch Out'));
  const isOnWelcome = pageInfo.url.includes('/welcome') && !hasSignIn;
  return {
    ...pageInfo,
    pageState: {
      needsLogin: hasSignIn,
      onWelcomePage: isOnWelcome,
      hasPunchIn,
      hasPunchOut,
      readyToPunch: (hasPunchIn || hasPunchOut) && !hasSignIn
    }
  };
}

async function performLogin(page) {
  console.log('Performing login...');
  await page.waitForSelector('input[type="email"]', { timeout: CONFIG.timeout });
  await page.click('input[type="email"]', { clickCount: 3 });
  await page.type('input[type="email"]', process.env.ADP_USERNAME);
  await page.waitForSelector('input[type="password"]');
  await page.click('input[type="password"]', { clickCount: 3 });
  await page.type('input[type="password"]', process.env.ADP_PASSWORD);
  await page.click('st-button[type="submit"] button.mybtn');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Login completed');
}

async function ensureCorrectPage(page) {
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts++;
    console.log(`Page check attempt ${attempts}/${maxAttempts}`);
    const state = await checkPageState(page);
    console.log(`Available buttons: ${state.allButtons.map(b => b.text).join(', ')}`);
    if (state.pageState.needsLogin) {
      console.log('Detected login page - performing login...');
      await performLogin(page);
      await new Promise(resolve => setTimeout(resolve, 3000));
      continue;
    }
    if (state.pageState.readyToPunch) {
      console.log('Page is ready for punching!');
      return state;
    }
    if (state.pageState.onWelcomePage || state.url.includes('/welcome')) {
      console.log('On welcome page but no punch buttons visible, waiting...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      continue;
    }
    console.log('Not on correct page, attempting navigation to welcome...');
    try {
      await page.goto(CONFIG.urls.welcome, { waitUntil: 'networkidle2' });
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.log('Navigation failed:', error.message);
    }
  }
  throw new Error('Could not get to the correct page state after multiple attempts');
}

async function punchInOut(page, type) {
  console.log(`Attempting to punch ${type}...`);
  const state = await ensureCorrectPage(page);
  const buttonText = type === 'IN' ? 'Punch In' : 'Punch Out';
  console.log(`Looking for button: "${buttonText}"`);
  const hasRequiredButton = state.allButtons.some(btn =>
    btn.text.includes('Punch') && btn.text.includes(type === 'IN' ? 'In' : 'Out')
  );
  if (!hasRequiredButton) {
    throw new Error(`Required button "${buttonText}" not found. Available: ${state.allButtons.map(b => b.text).join(', ')}`);
  }
  page.on('dialog', async dialog => {
    console.log('Dialog detected:', dialog.message());
    await dialog.accept();
  });
  const result = await page.evaluate((text) => {
    const allButtons = Array.from(document.querySelectorAll('button'));
    // Exact match
    let targetButton = allButtons.find(button => button.textContent.trim() === text);
    if (targetButton) {
      targetButton.click();
      return { success: true, method: 'exact' };
    }
    // Partial match
    const searchTerm = text.split(' ')[1];
    targetButton = allButtons.find(button =>
      button.textContent.trim().includes('Punch') &&
      button.textContent.trim().includes(searchTerm)
    );
    if (targetButton) {
      targetButton.click();
      return { success: true, method: 'partial' };
    }
    return { success: false, buttonTexts: allButtons.map(b => b.textContent.trim()) };
  }, buttonText);
  if (!result.success) {
    throw new Error(`Could not click button "${buttonText}". Available: ${result.buttonTexts.join(', ')}`);
  }
  console.log(`Clicked ${buttonText} button using ${result.method} method`);
  await new Promise(resolve => setTimeout(resolve, 3000));
  const success = await page.evaluate(() => {
    return document.body.textContent.toLowerCase().includes('success');
  });
  if (success) {
    console.log(`Punch ${type} successful!`);
  } else {
    console.log(`Punch ${type} completed (button clicked)`);
  }
}

async function runAutomationWithRetry() {
  // --- New: Skip check before doing anything heavy ---
  if (process.env.FORCE_RUN === '1') {
    console.log('FORCE_RUN=1 detected → ignoring leave/holiday skip.');
  } else {
    const { skip, reason } = shouldSkipToday(CONFIG.leaves);
    if (skip) {
      const todayIST = nowInIST();
      console.log(`Skipping automation on ${formatIST_YMD(todayIST)} (IST) → ${reason}`);
      process.exitCode = 0; // graceful no-op
      return;
    }
  }

  const punchType = process.env.PUNCH_TYPE || determinePunchType();
  let browser;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      console.log(`Starting ADP automation attempt ${attempt}/${CONFIG.maxRetries} for punch ${punchType}...`);
      console.log(`Using location: ${CONFIG.location.latitude}, ${CONFIG.location.longitude}`);
      const { browser: br, page } = await setupBrowser();
      browser = br;

      // Belt & suspenders: override geolocation getter too
      await page.evaluateOnNewDocument(() => {
        navigator.geolocation.getCurrentPosition = function(success, error) {
          success({
            coords: {
              latitude: 17.4661607,
              longitude: 78.2846192,
              accuracy: 50
            }
          });
        };
      });
      await page.goto(CONFIG.urls.login, { waitUntil: 'networkidle2' });
      await punchInOut(page, punchType);
      console.log('Automation completed successfully!');
      await browser.close();
      return;
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error.message);
      if (browser) {
        try {
          const page = (await browser.pages())[0];
          await page.screenshot({
            path: `error-attempt-${attempt}.png`,
            fullPage: true
          });
          console.log(`Error screenshot saved: error-attempt-${attempt}.png`);
        } catch (e) {
          console.log('Could not take error screenshot');
        }
        await browser.close();
        browser = null;
      }
      if (attempt < CONFIG.maxRetries) {
        console.log(`Waiting 10 seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      } else {
        console.error('All retry attempts failed!');
        process.exit(1);
      }
    }
  }
}

function determinePunchType() {
  if (process.env.PUNCH_TYPE) {
    console.log(`Using environment PUNCH_TYPE: ${process.env.PUNCH_TYPE}`);
    return process.env.PUNCH_TYPE;
  }
  const istTime = nowInIST();
  const istHour = istTime.getHours();
  console.log(`Current IST time: ${istHour}:${istTime.getMinutes().toString().padStart(2, '0')}`);
  if (istHour < 12) {
    console.log('IST time is before noon - defaulting to Punch IN');
    return 'IN';
  } else {
    console.log('IST time is after noon - defaulting to Punch OUT');
    return 'OUT';
  }
}

// Keep your existing behavior of defaulting PUNCH_TYPE if not set:
process.env.PUNCH_TYPE = process.env.PUNCH_TYPE || determinePunchType();
runAutomationWithRetry();
