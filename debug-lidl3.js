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

  // Try clicking "Mehr anzeigen" buttons to load more content
  let loadMoreCount = 0;
  while (loadMoreCount < 5) {
    const btns = await page.locator('button:has-text("Mehr anzeigen"), a:has-text("Mehr anzeigen")').all();
    if (btns.length === 0) break;
    for (const btn of btns.slice(0, 3)) {
      try {
        await btn.click();
        await page.waitForTimeout(1500);
      } catch(e) {}
    }
    loadMoreCount++;
  }
  console.log(`Clicked "Mehr anzeigen" ${loadMoreCount} times`);

  // Now look for actual product cards with prices
  const productCards = await page.evaluate(() => {
    const results = [];

    // Look for elements containing prices (€ symbol)
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.children.length === 0 && el.textContent.includes('€')) {
        const card = el.closest('article, .tile, [class*="product"], [class*="Product"], [class*="tile"], li, a');
        if (card) {
          const text = card.innerText.slice(0, 300);
          if (!results.find(r => r.text === text)) {
            results.push({ text, tag: card.tagName, class: card.className.slice(0, 100) });
          }
        }
      }
    }
    return results.slice(0, 10);
  });

  console.log('\n=== Product cards with prices (first 10) ===');
  productCards.forEach((p, i) => {
    console.log(`\n--- Card ${i+1} ---`);
    console.log('Tag:', p.tag);
    console.log('Class:', p.class);
    console.log('Text:', p.text);
  });

  // Look for actual product grid/list containers
  const grids = await page.evaluate(() => {
    const results = [];
    const selectors = ['[class*="grid"]', '[class*="list"]', '[class*="products"]', '[class*="Produkte"]', 'section', 'ul'];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const links = el.querySelectorAll('a[href*="/p/"]');
        if (links.length > 2) {
          results.push({
            selector: sel,
            class: el.className.slice(0, 100),
            productLinks: links.length,
            sampleLinks: Array.from(links).slice(0, 3).map(a => ({ href: a.href, text: a.innerText.slice(0, 100) }))
          });
        }
      }
    }
    return results.slice(0, 10);
  });

  console.log('\n=== Containers with /p/ product links ===');
  console.log(JSON.stringify(grids, null, 2));

  await browser.close();
})();
