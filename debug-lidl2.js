const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating...');
  await page.goto('https://www.lidl.de/c/baumarkt-garten/s10067761', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(5000);

  // Inspect product-like elements in detail
  const productData = await page.evaluate(() => {
    const results = [];
    // Try various selectors
    const selectors = [
      '[data-testid*="product"]',
      '[class*="product"]',
      'article',
      '.tile',
      '[class*="tile"]',
      '[class*="Product"]'
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        results.push(`\n--- Selector: ${sel} (${els.length} elements) ---`);
        for (let i = 0; i < Math.min(3, els.length); i++) {
          const el = els[i];
          const html = el.outerHTML.slice(0, 800);
          const text = el.innerText.slice(0, 200);
          results.push(`Element ${i+1} text: ${text}`);
          results.push(`Element ${i+1} HTML snippet: ${html}`);
        }
      }
    }
    return results.join('\n');
  });

  console.log(productData);

  // Also check for JSON-LD product data
  const jsonLd = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    return Array.from(scripts).map(s => {
      try {
        return JSON.parse(s.innerText);
      } catch(e) {
        return null;
      }
    }).filter(Boolean);
  });

  console.log('\n=== JSON-LD scripts ===');
  console.log(JSON.stringify(jsonLd.slice(0, 2), null, 2));

  // Check for any API/network requests that might contain product data
  // Not possible in evaluate, but we can check window.__INITIAL_STATE__ or similar
  const initialState = await page.evaluate(() => {
    return window.__INITIAL_STATE__ || window.__DATA__ || window.__PRELOADED_STATE__ || null;
  });

  if (initialState) {
    console.log('\n=== window.__INITIAL_STATE__ found ===');
    console.log(JSON.stringify(initialState).slice(0, 2000));
  } else {
    console.log('\nNo window.__INITIAL_STATE__ found');
  }

  await browser.close();
})();
