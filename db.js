const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'crawler.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;
let dbIntegrityOk = true;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        applyPragmas(db);
    }
    return db;
}

function applyPragmas(database) {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    database.pragma('wal_autocheckpoint = 1000');
    database.pragma('temp_store = MEMORY');
    database.pragma('cache_size = -64000');
    database.pragma('mmap_size = 268435456');

    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
        dbIntegrityOk = false;
        console.error('[db] integrity_check FAILED:', integrity);
    } else {
        dbIntegrityOk = true;
    }
}

function isIntegrityOk() {
    return dbIntegrityOk;
}

function init() {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const database = getDb();

    if (!dbIntegrityOk) {
        throw new Error('Database integrity check failed. Run `npm run db:repair` to recover.');
    }

    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const lines = schema.split('\n');
    let stmt = '';
    for (const line of lines) {
        stmt += line + '\n';
        if (line.trim().endsWith(';')) {
            const trimmed = stmt.trim();
            if (trimmed) {
                try { database.exec(trimmed); } catch (e) {
                    if (!e.message.includes('duplicate column') &&
                        !e.message.includes('already exists')) {
                        console.warn('DB exec warning:', e.message);
                    }
                }
            }
            stmt = '';
        }
    }

    // Idempotent migrations: only add columns that don't already exist
    runMigrations(database);

    console.log('Database initialized at', DB_PATH);
}

function runMigrations(database) {
    const migrations = [
        ['products', 'brand', 'TEXT'],
        ['products', 'old_price', 'TEXT'],
        ['products', 'rating', 'REAL'],
        ['products', 'rating_count', 'INTEGER'],
        ['products', 'description', 'TEXT'],
        ['products', 'detail_url', 'TEXT'],
        ['products', 'subcategory', 'TEXT'],
        ['crawl_sessions', 'subcategories_found', 'INTEGER DEFAULT 0'],
        ['crawl_sessions', 'price_changes', 'INTEGER DEFAULT 0'],
    ];
    for (const [table, col, type] of migrations) {
        const cols = database.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.some(c => c.name === col)) {
            database.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
        }
    }
}

// Settings helpers
function getSetting(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
}

function setSetting(key, value) {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// Session helpers
function createSession(sourceUrl) {
    const startedAt = new Date().toISOString();
    const result = getDb().prepare(
        'INSERT INTO crawl_sessions (started_at, source_url, status) VALUES (?, ?, ?)'
    ).run(startedAt, sourceUrl, 'running');
    return result.lastInsertRowid;
}

function completeSession(sessionId, totalProducts, newProducts, status = 'success', extra = {}) {
    const endedAt = new Date().toISOString();
    getDb().prepare(
        `UPDATE crawl_sessions SET ended_at = ?, status = ?, total_products = ?, new_products = ?,
         subcategories_found = ?, price_changes = ? WHERE id = ?`
    ).run(endedAt, status, totalProducts, newProducts,
        (extra && extra.subcategoriesFound) || 0, (extra && extra.priceChanges) || 0, sessionId);
}

function getSessions(limit = 50, offset = 0) {
    return getDb().prepare(
        'SELECT * FROM crawl_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset);
}

function getSessionById(id) {
    return getDb().prepare('SELECT * FROM crawl_sessions WHERE id = ?').get(id);
}

function getSessionCategoryStats(sessionId) {
    return getDb().prepare(
        'SELECT category, count FROM session_category_stats WHERE session_id = ? ORDER BY count DESC'
    ).all(sessionId);
}

function addSessionCategoryStats(sessionId, category, count) {
    getDb().prepare(
        'INSERT INTO session_category_stats (session_id, category, count) VALUES (?, ?, ?)'
    ).run(sessionId, category, count);
}

// Subcategory helpers
function upsertSubcategory(parentUrl, name, url) {
    const now = new Date().toISOString();
    const existing = getDb().prepare('SELECT id FROM subcategories WHERE url = ?').get(url);
    if (existing) {
        getDb().prepare(
            'UPDATE subcategories SET name = ?, last_seen_at = ? WHERE url = ?'
        ).run(name, now, url);
        return existing.id;
    } else {
        const result = getDb().prepare(
            'INSERT INTO subcategories (parent_url, name, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
        ).run(parentUrl, name, url, now, now);
        return result.lastInsertRowid;
    }
}

function updateSubcategoryProductCount(url, count) {
    getDb().prepare('UPDATE subcategories SET product_count = ? WHERE url = ?').run(count, url);
}

function getSubcategories(parentUrl) {
    return getDb().prepare(
        'SELECT * FROM subcategories WHERE parent_url = ? ORDER BY name'
    ).all(parentUrl);
}

function getAllSubcategories() {
    return getDb().prepare('SELECT * FROM subcategories ORDER BY parent_url, name').all();
}

// Product helpers
function getProductByExternalId(externalId) {
    return getDb().prepare('SELECT * FROM products WHERE external_id = ?').get(externalId);
}

function upsertProduct(externalId, name, imageUrl, category, price, sourceUrl, extra = {}) {
    const now = new Date().toISOString();
    const existing = getProductByExternalId(externalId);
    const changes = [];

    if (existing) {
        let isChanged = false;

        // Detect price change
        if (price && existing.price && price !== existing.price) {
            isChanged = true;
            changes.push({
                product_id: existing.id,
                change_type: 'price_changed',
                field_name: 'price',
                old_value: existing.price,
                new_value: price
            });
        }

        // Detect re-appearance (last seen on a previous date — compare YYYY-MM-DD)
        const today = now.slice(0, 10);
        const lastSeenDay = (existing.last_seen_at || '').slice(0, 10);
        if (lastSeenDay && lastSeenDay < today) {
            isChanged = true;
            changes.push({
                product_id: existing.id,
                change_type: 'restocked',
                field_name: 'last_seen_at',
                old_value: existing.last_seen_at,
                new_value: now
            });
        }

        // Keep existing image if we already have one (don't re-download for existing SKU)
        const newImage = existing.image_url ? existing.image_url : imageUrl;

        getDb().prepare(
            `UPDATE products SET name = ?, image_url = ?, category = ?, price = ?,
             subcategory = ?, brand = COALESCE(?, brand), old_price = COALESCE(?, old_price),
             rating = COALESCE(?, rating), rating_count = COALESCE(?, rating_count),
             description = COALESCE(?, description), detail_url = COALESCE(?, detail_url),
             last_seen_at = ? WHERE id = ?`
        ).run(name, newImage, category, price,
             extra.subcategory || null,
             extra.brand || null, extra.oldPrice || null,
             extra.rating || null, extra.ratingCount || null,
             extra.description || null, extra.detailUrl || null,
             now, existing.id);
        return { id: existing.id, isNew: false, isChanged, changes };
    } else {
        const result = getDb().prepare(
            `INSERT INTO products (external_id, name, image_url, category, subcategory, brand, price, old_price,
             rating, rating_count, description, detail_url, source_url, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(externalId, name, imageUrl, category, extra.subcategory || null,
              extra.brand || null, price, extra.oldPrice || null,
              extra.rating || null, extra.ratingCount || null,
              extra.description || null, extra.detailUrl || null,
              sourceUrl, now, now);
        changes.push({
            product_id: result.lastInsertRowid,
            change_type: 'new',
            field_name: null,
            old_value: null,
            new_value: null
        });
        return { id: result.lastInsertRowid, isNew: true, isChanged: true, changes };
    }
}

function addSessionProduct(sessionId, productId, isNew, subcategory) {
    getDb().prepare(
        'INSERT OR IGNORE INTO session_products (session_id, product_id, is_new, subcategory) VALUES (?, ?, ?, ?)'
    ).run(sessionId, productId, isNew ? 1 : 0, subcategory || null);
}

function addProductChange(sessionId, productId, changeType, fieldName, oldValue, newValue) {
    const now = new Date().toISOString();
    getDb().prepare(
        'INSERT INTO product_changes (session_id, product_id, change_type, field_name, old_value, new_value, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(sessionId, productId, changeType, fieldName, oldValue, newValue, now);
}

function getProductChanges(sessionId) {
    return getDb().prepare(
        `SELECT pc.*, p.name, p.external_id, p.image_url, p.category, p.subcategory
         FROM product_changes pc
         JOIN products p ON p.id = pc.product_id
         WHERE pc.session_id = ?
         ORDER BY pc.detected_at DESC`
    ).all(sessionId);
}

function getRecentChanges(days = 7) {
    return getDb().prepare(
        `SELECT pc.*, p.name, p.external_id, p.image_url, p.category, p.subcategory
         FROM product_changes pc
         JOIN products p ON p.id = pc.product_id
         WHERE pc.detected_at >= datetime('now', ? || ' days')
         ORDER BY pc.detected_at DESC
         LIMIT 100`
    ).all(`-${parseInt(days)}`);
}

function getRecentChangesCount(days = 7) {
    return getDb().prepare(
        `SELECT COUNT(*) as count FROM product_changes
         WHERE detected_at >= datetime('now', ? || ' days')`
    ).get(`-${parseInt(days)}`).count;
}

function getTodayNewCount() {
    return getDb().prepare(
        `SELECT COUNT(*) as count FROM products
         WHERE date(first_seen_at) = date('now')`
    ).get().count;
}

// Detect products that disappeared (present in previous crawl but not current)
function markDisappearedProducts(sessionId, currentExternalIds, sourceUrl) {
    if (!currentExternalIds || currentExternalIds.size === 0) return 0;

    const ids = [...currentExternalIds];
    const placeholders = ids.map(() => '?').join(',');

    const previous = getDb().prepare(
        `SELECT id, external_id, name FROM products
         WHERE source_url = ? AND external_id NOT IN (${placeholders})`
    ).all(sourceUrl, ...ids);

    const now = new Date().toISOString();
    for (const p of previous) {
        addProductChange(sessionId, p.id, 'removed', null, null, null);
        getDb().prepare('UPDATE products SET last_seen_at = ? WHERE id = ?').run(now, p.id);
    }
    return previous.length;
}

function getSessionProducts(sessionId) {
    return getDb().prepare(
        `SELECT p.*, sp.is_new, sp.subcategory as session_subcategory FROM products p
         JOIN session_products sp ON p.id = sp.product_id
         WHERE sp.session_id = ?
         ORDER BY sp.is_new DESC, p.name`
    ).all(sessionId);
}

function getProducts(limit = 100, offset = 0, search = '', category = '', subcategory = '', brand = '', sort = 'last_seen_at', order = 'DESC') {
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];
    if (search) {
        sql += ' AND (name LIKE ? OR external_id LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    if (category) {
        sql += ' AND category = ?';
        params.push(category);
    }
    if (subcategory) {
        sql += ' AND subcategory = ?';
        params.push(subcategory);
    }
    if (brand) {
        sql += ' AND brand = ?';
        params.push(brand);
    }
    const allowedSort = ['price', 'name', 'first_seen_at', 'last_seen_at'];
    const sortCol = allowedSort.includes(sort) ? sort : 'last_seen_at';
    const sortOrder = order === 'ASC' ? 'ASC' : 'DESC';
    if (sortCol === 'price') {
        sql += ` ORDER BY CAST(REPLACE(REPLACE(REPLACE(price, '*', ''), '€', ''), ',', '.') AS REAL) ${sortOrder} LIMIT ? OFFSET ?`;
    } else {
        sql += ` ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`;
    }
    params.push(limit, offset);
    return getDb().prepare(sql).all(...params);
}

function getAllCategories() {
    return getDb().prepare('SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category').all().map(r => r.category);
}

function getAllSubcategoryNames() {
    return getDb().prepare('SELECT DISTINCT subcategory FROM products WHERE subcategory IS NOT NULL ORDER BY subcategory').all().map(r => r.subcategory);
}

function getAllBrandNames() {
    return getDb().prepare('SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != \'\' ORDER BY brand').all().map(r => r.brand);
}

function getProductCount() {
    return getDb().prepare('SELECT COUNT(*) as count FROM products').get().count;
}

function getTrend(days = 7) {
    const daysInt = parseInt(days, 10);
    if (!Number.isInteger(daysInt) || daysInt < 1) days = 7;
    const sql = `
        SELECT date(started_at) as day,
               SUM(total_products) as total,
               SUM(new_products) as new_count,
               SUM(price_changes) as price_changes
        FROM crawl_sessions
        WHERE status = 'success'
          AND date(started_at) >= date('now', ? || ' days')
        GROUP BY date(started_at)
        ORDER BY day
    `;
    return getDb().prepare(sql).all(`-${daysInt}`);
}

module.exports = {
    init,
    getDb,
    getSetting,
    setSetting,
    createSession,
    completeSession,
    getSessions,
    getSessionById,
    getSessionCategoryStats,
    addSessionCategoryStats,
    upsertSubcategory,
    updateSubcategoryProductCount,
    getSubcategories,
    getAllSubcategories,
    getProductByExternalId,
    upsertProduct,
    addSessionProduct,
    addProductChange,
    getProductChanges,
    getRecentChanges,
    getRecentChangesCount,
    getTodayNewCount,
    markDisappearedProducts,
    getSessionProducts,
    getProducts,
    getAllCategories,
    getAllSubcategoryNames,
    getAllBrandNames,
    getProductCount,
    getTrend,
    close,
    isIntegrityOk
};

let shutdownRegistered = false;
function close() {
    if (!db) return;
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
        db = null;
    } catch (e) {
        console.error('[db] error during close:', e.message);
    }
}

if (!shutdownRegistered) {
    shutdownRegistered = true;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => {
            console.log(`[db] received ${sig}, closing database...`);
            close();
            process.exit(0);
        });
    }
    process.on('exit', () => { if (db) close(); });
}
