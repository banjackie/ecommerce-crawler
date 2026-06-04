const express = require('express');
const path = require('path');
const db = require('./db');
const crawler = require('./crawler');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 47823;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== API Routes ====================

// Get all sessions
app.get('/api/sessions', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const sessions = db.getSessions(limit, offset);

    const enriched = sessions.map(s => {
        const stats = db.getSessionCategoryStats(s.id);
        return { ...s, category_stats: stats };
    });

    res.json({ sessions: enriched });
});

// Get single session with products and changes
app.get('/api/sessions/:id', (req, res) => {
    const session = db.getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const stats = db.getSessionCategoryStats(session.id);
    const products = db.getSessionProducts(session.id);
    const changes = db.getProductChanges(session.id);
    res.json({ ...session, category_stats: stats, products, changes });
});

// Get products for a session
app.get('/api/sessions/:id/products', (req, res) => {
    const products = db.getSessionProducts(req.params.id);
    res.json({ products });
});

// Get changes for a session
app.get('/api/sessions/:id/changes', (req, res) => {
    const changes = db.getProductChanges(req.params.id);
    res.json({ changes });
});

// Get all products
app.get('/api/products', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search || '';
    const category = req.query.category || '';
    const subcategory = req.query.subcategory || '';
    const products = db.getProducts(limit, offset, search, category, subcategory);
    const categories = db.getAllCategories();
    const subcategories = db.getAllSubcategoryNames();
    res.json({ products, categories, subcategories });
});

// Get subcategories for a parent URL
app.get('/api/subcategories', (req, res) => {
    const parentUrl = req.query.parent_url || db.getSetting('source_url');
    const subcats = db.getSubcategories(parentUrl);
    res.json({ subcategories: subcats });
});

// Get all subcategories
app.get('/api/subcategories/all', (req, res) => {
    const subcats = db.getAllSubcategories();
    res.json({ subcategories: subcats });
});

// Get recent product changes
app.get('/api/changes', (req, res) => {
    const days = parseInt(req.query.days) || 7;
    const changes = db.getRecentChanges(days);
    res.json({ changes });
});

// Get trend data
app.get('/api/stats/trend', (req, res) => {
    const days = parseInt(req.query.days) || 7;
    const trend = db.getTrend(days);
    res.json({ trend });
});

// Get overview stats
app.get('/api/stats/overview', (req, res) => {
    const totalProducts = db.getProductCount();
    const sessions = db.getSessions(1, 0);
    const todayNew = sessions.length > 0 ? sessions[0].new_products : 0;
    const totalSessions = db.getDb().prepare('SELECT COUNT(*) as count FROM crawl_sessions WHERE status = ?').get('success').count;
    const subcats = db.getAllSubcategories();
    const recentChanges = db.getRecentChanges(1);
    res.json({
        totalProducts,
        todayNew,
        totalSessions,
        totalSubcategories: subcats.length,
        recentChanges: recentChanges.length
    });
});

// Trigger crawl manually
app.post('/api/crawl', async (req, res) => {
    const status = crawler.getCrawlStatus();
    if (status.isRunning) {
        return res.status(409).json({ error: 'Crawl already running' });
    }
    res.json({ message: 'Crawl started' });
    crawler.runCrawl().catch(err => console.error('Background crawl error:', err));
});

// Get crawl status
app.get('/api/crawl/status', (req, res) => {
    res.json(crawler.getCrawlStatus());
});

// Get settings
app.get('/api/settings', (req, res) => {
    const sourceUrl = db.getSetting('source_url');
    const cronSchedule = db.getSetting('cron_schedule');
    res.json({ source_url: sourceUrl, cron_schedule: cronSchedule });
});

// Update settings
app.post('/api/settings', (req, res) => {
    const { source_url, cron_schedule } = req.body;
    if (source_url) db.setSetting('source_url', source_url);
    if (cron_schedule) {
        db.setSetting('cron_schedule', cron_schedule);
        rescheduleCrawl(cron_schedule);
    }
    res.json({ message: 'Settings updated' });
});

// Image proxy
app.get('/api/proxy/image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Missing url');

    try {
        const response = await fetch(imageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const contentType = response.headers.get('content-type');
        const buffer = await response.arrayBuffer();
        res.set('Content-Type', contentType || 'image/jpeg');
        res.send(Buffer.from(buffer));
    } catch (e) {
        res.status(500).send('Failed to fetch image');
    }
});

// ==================== Scheduled Crawler ====================

let cronJob = null;

function scheduleCrawl() {
    const cronExpr = db.getSetting('cron_schedule') || '0 4 * * *';
    console.log('Scheduling crawl with cron:', cronExpr);

    if (cronJob) cronJob.stop();
    cronJob = cron.schedule(cronExpr, async () => {
        console.log('Running scheduled crawl at', new Date().toISOString());
        await crawler.runCrawl();
    });
}

function rescheduleCrawl(newCronExpr) {
    if (cronJob) cronJob.stop();
    console.log('Rescheduling crawl with cron:', newCronExpr);
    cronJob = cron.schedule(newCronExpr, async () => {
        console.log('Running scheduled crawl at', new Date().toISOString());
        await crawler.runCrawl();
    });
}

// ==================== Start Server ====================

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    try {
        db.init();
    } catch (e) {
        console.log('DB already initialized');
    }
    scheduleCrawl();
});
