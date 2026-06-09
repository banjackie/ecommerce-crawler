const { chromium } = require('playwright');
const db = require('./db');

let isRunning = false;

// ──────────────────── Subcategory extraction from category page ────────────────────

function extractSubcategories() {
    const results = [];
    const seen = new Set();

    // Primary: Navigation pill links (use /h/ URLs for subcategory product listings)
    const navSection = document.querySelector('.APageRoot__SectionWrapper--HasNavigationPill');
    if (navSection) {
        navSection.querySelectorAll('a[href*="/h/"]').forEach(a => {
            const href = a.href;
            const text = a.textContent.trim();
            if (href && text && !seen.has(href)) {
                seen.add(href);
                results.push({ name: text, url: href });
            }
        });
    }

    // Fallback: Content tile links with /h/ URLs
    if (results.length === 0) {
        document.querySelectorAll('.APageRoot__SectionWrapper--CONTENT_TILE a[href*="/h/"]').forEach(a => {
            const href = a.href;
            const text = a.textContent.trim();
            if (href && text && !seen.has(href)) {
                seen.add(href);
                results.push({ name: text, url: href });
            }
        });
    }

    // Last resort: any /h/ link not in header/footer
    if (results.length === 0) {
        document.querySelectorAll('a[href*="/h/"]').forEach(a => {
            const href = a.href;
            const text = a.textContent.trim();
            const inNav = a.closest('header, footer, .n-header, nav');
            if (href && text && !seen.has(href) && !inNav) {
                seen.add(href);
                results.push({ name: text, url: href });
            }
        });
    }

    return results;
}

// ──────────────────── Product extraction from listing page ────────────────────

function extractProductsFromList() {
    const items = [];
    const seen = new Set();
    const tiles = document.querySelectorAll('.odsc-tile');

    tiles.forEach(tile => {
        // Skip skeleton (unloaded) tiles
        if (tile.querySelector('.s-grid-box-skeleton')) return;

        const linkEl = tile.querySelector('a[href*="/p/"]');
        if (!linkEl) return;

        const href = linkEl.href;
        const match = href.match(/\/p(\d{6,})/);
        const externalId = match ? match[1] : '';
        if (!externalId || seen.has(externalId)) return;
        seen.add(externalId);

        const titleEl = tile.querySelector('.product-grid-box__title, [class*="product-grid-box__title"]');
        const name = titleEl ? titleEl.textContent.trim() : '';

        const imgEl = tile.querySelector('img');
        const imageUrl = imgEl ? (imgEl.src || imgEl.dataset.src || '') : '';
        // Skip tiny placeholder images
        const isPlaceholder = imageUrl.includes('1x1') || imageUrl.includes('placeholder') || imageUrl.endsWith('.svg');

        const priceEl = tile.querySelector('.ods-price__value');
        const price = priceEl ? priceEl.textContent.trim() : '';

        const oldPriceEl = tile.querySelector('.ods-price__info, [class*="strikethrough" i], .ods-price--old');
        const oldPrice = oldPriceEl ? oldPriceEl.textContent.trim() : '';

        let brand = '';
        let rating = null;
        const impressionEl = tile.querySelector('[data-gridbox-impression]');
        if (impressionEl) {
            try {
                const data = JSON.parse(decodeURIComponent(impressionEl.dataset.gridboxImpression));
                brand = data.brand || '';
                rating = data.ratingAverage || null;
            } catch (e) { /* ignore */ }
        }
        if (!brand) {
            const brandEl = tile.querySelector('.product-grid-box__brand');
            if (brandEl) brand = brandEl.textContent.trim();
        }

        if (name || externalId) {
            items.push({
                name, imageUrl: isPlaceholder ? '' : imageUrl,
                externalId, price, oldPrice, brand, rating, detailUrl: href
            });
        }
    });

    return items;
}

// ──────────────────── Cookie consent ────────────────────

async function acceptCookies(page) {
    const btnSelectors = [
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Akzeptieren")',
        'button:has-text("Accept all")',
        '#onetrust-accept-btn-handler',
    ];
    for (const sel of btnSelectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                const visible = await btn.isVisible().catch(() => false);
                if (visible) {
                    await btn.click({ timeout: 3000 });
                    await page.waitForTimeout(500);
                    return true;
                }
            }
        } catch (e) { /* try next */ }
    }
    return false;
}

// ──────────────────── Scroll to load all products ────────────────────

async function scrollToLoadAll(page, maxScrolls = 40) {
    let prevCount = 0;
    let noChangeCount = 0;

    for (let i = 0; i < maxScrolls; i++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(1200);

        const count = await page.evaluate(() => {
            let real = 0;
            document.querySelectorAll('.odsc-tile').forEach(t => {
                if (!t.querySelector('.s-grid-box-skeleton')) real++;
            });
            return real;
        });

        if (count === prevCount) {
            noChangeCount++;
            if (noChangeCount >= 4) break;
        } else {
            noChangeCount = 0;
            prevCount = count;
        }
    }
}

// ──────────────────── Crawl a single subcategory ────────────────────

async function crawlSubcategory(context, subcat) {
    console.log(`  Crawling: ${subcat.name} -> ${subcat.url}`);
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    try {
        await page.goto(subcat.url, { waitUntil: 'networkidle', timeout: 45000 });
        await acceptCookies(page);
        await page.waitForTimeout(3000);

        const h1 = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() || '');
        const displayName = h1 || subcat.name;

        // Scroll to load all products
        await scrollToLoadAll(page);

        // Extract products
        const products = await page.evaluate(extractProductsFromList);
        console.log(`    "${displayName}": ${products.length} products`);

        return { subcategory: displayName, products };
    } catch (e) {
        console.log(`    Error: ${e.message}`);
        return { subcategory: subcat.name, products: [] };
    } finally {
        await page.close();
    }
}

// ──────────────────── Main crawl function ────────────────────

async function runCrawl() {
    if (isRunning) {
        console.log('Crawl already running, skipping...');
        return { success: false, error: 'Already running' };
    }

    isRunning = true;
    const sourceUrl = db.getSetting('source_url') || 'https://www.lidl.de/c/baumarkt-garten/s10067761';
    const sessionId = db.createSession(sourceUrl);
    console.log(`[${sessionId}] Starting two-level crawl: ${sourceUrl}`);

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            locale: 'de-DE',
        });

        // ═══════ Level 1: Extract subcategories from category page ═══════
        console.log(`[${sessionId}] Level 1: Fetching category page...`);
        const catPage = await context.newPage();
        catPage.setDefaultTimeout(60000);
        await catPage.goto(sourceUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await acceptCookies(catPage);
        await catPage.waitForTimeout(3000);

        const categoryName = await catPage.evaluate(() => document.querySelector('h1')?.textContent?.trim() || 'Unknown');
        const subcategories = await catPage.evaluate(extractSubcategories);
        console.log(`[${sessionId}] Category: "${categoryName}", ${subcategories.length} subcategories found`);

        const now = new Date().toISOString();
        for (const sub of subcategories) {
            db.upsertSubcategory(sourceUrl, sub.name, sub.url, now);
        }

        await catPage.close();

        if (subcategories.length === 0) {
            console.log(`[${sessionId}] No subcategories found, treating source URL as listing page...`);
            subcategories.push({ name: categoryName, url: sourceUrl });
        }

        // ═══════ Level 2: Crawl each subcategory ═══════
        let allProducts = [];
        let totalNew = 0;
        let totalChanged = 0;
        const categoryCounts = {};
        const seenExternalIds = new Set();

        for (let i = 0; i < subcategories.length; i++) {
            const sub = subcategories[i];
            console.log(`[${sessionId}] Level 2.${i + 1}/${subcategories.length}: ${sub.name}`);

            const result = await crawlSubcategory(context, sub);

            for (const p of result.products) {
                if (seenExternalIds.has(p.externalId)) continue;
                seenExternalIds.add(p.externalId);

                const extra = {
                    brand: p.brand,
                    oldPrice: p.oldPrice,
                    rating: p.rating,
                    detailUrl: p.detailUrl,
                    subcategory: result.subcategory,
                };
                const upsertResult = db.upsertProduct(
                    p.externalId, p.name, p.imageUrl, categoryName, p.price, sourceUrl, extra
                );

                if (upsertResult.isNew) totalNew++;
                if (upsertResult.isChanged) totalChanged++;

                db.addSessionProduct(sessionId, upsertResult.id, upsertResult.isNew, result.subcategory);

                if (upsertResult.changes && upsertResult.changes.length > 0) {
                    for (const change of upsertResult.changes) {
                        db.addProductChange(sessionId, upsertResult.id, change.change_type, change.field_name, change.old_value, change.new_value);
                    }
                }

                categoryCounts[result.subcategory] = (categoryCounts[result.subcategory] || 0) + 1;
            }

            allProducts = allProducts.concat(result.products);

            db.updateSubcategoryProductCount(sub.url, result.products.length, now);

            // Rate limiting between subcategories
            if (i < subcategories.length - 1) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        // Mark products not seen in this crawl as unavailable
        const unavailableCount = db.markDisappearedProducts(sessionId, seenExternalIds, sourceUrl);

        for (const [cat, count] of Object.entries(categoryCounts)) {
            db.addSessionCategoryStats(sessionId, cat, count);
        }

        db.completeSession(sessionId, seenExternalIds.size, totalNew, 'success', { subcategoriesFound: subcategories.length, priceChanges: totalChanged });
        console.log(`[${sessionId}] Done. Unique: ${seenExternalIds.size}, New: ${totalNew}, Changed: ${totalChanged}, Unavailable: ${unavailableCount}, Subcats: ${subcategories.length}`);

        await browser.close();
        isRunning = false;
        return {
            success: true, sessionId,
            total: seenExternalIds.size, new: totalNew, changed: totalChanged,
            unavailable: unavailableCount, subcategories: subcategories.length
        };

    } catch (error) {
        console.error(`[${sessionId}] Crawl failed:`, error.message);
        db.completeSession(sessionId, 0, 0, 'failed', {});
        if (browser) await browser.close().catch(() => {});
        isRunning = false;
        return { success: false, error: error.message };
    }
}

function getCrawlStatus() {
    return { isRunning };
}

module.exports = { runCrawl, getCrawlStatus };
