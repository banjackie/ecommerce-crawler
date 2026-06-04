const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to https://www.lidl.de/c/baumarkt-garten/s10067761');
  await page.goto('https://www.lidl.de/c/baumarkt-garten/s10067761', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(5000);

  const title = await page.title();
  console.log('\nPage title:', title);

  // Check for subcategory links
  const categoryLinks = await page.$$eval('a[href*="/c/"]', links =>
    links.map(l => ({ text: l.innerText.trim().slice(0, 60), href: l.href }))
  );
  console.log('\n=== Category links (first 15) ===');
  [...new Set(categoryLinks.map(JSON.stringify))].map(JSON.parse).slice(0, 15)
    .forEach(c => console.log(c.text, '->', c.href));

  // Check for product elements with various selectors
  const selectors = [
    '[data-testid*="product"]',
    '.product',
    '[class*="product"]',
    '.ods-tile',
    '[data-testid="product-grid"]',
    'article',
    '.tile',
    '[class*="tile"]'
  ];

  console.log('\n=== Product element counts ===');
  for (const sel of selectors) {
    const count = await page.locator(sel).count();
    if (count > 0) console.log(`${sel}: ${count}`);
  }

  // Check if there's a "load more" or pagination
  const loadMore = await page.locator('text=/Mehr anzeigen|Load more|Weitere|Alle anzeigen/i').count();
  console.log('\nLoad more buttons:', loadMore);

  // Body text preview
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('\n=== Page text preview (first 2500 chars) ===');
  console.log(bodyText);

  await browser.close();
})();
