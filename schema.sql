-- 产品表：存储爬取到的所有产品
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    image_url TEXT,
    category TEXT,
    subcategory TEXT,
    brand TEXT,
    price TEXT,
    old_price TEXT,
    rating REAL,
    rating_count INTEGER,
    description TEXT,
    detail_url TEXT,
    source_url TEXT,
    first_seen_at TEXT,
    last_seen_at TEXT
);

-- 子分类表：从品类页提取的子分类链接
CREATE TABLE IF NOT EXISTS subcategories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_url TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    product_count INTEGER DEFAULT 0,
    first_seen_at TEXT,
    last_seen_at TEXT
);

-- 产品变更表：追踪每次爬取的产品变化
CREATE TABLE IF NOT EXISTS product_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    change_type TEXT NOT NULL,  -- 'new', 'removed', 'price_changed', 'restocked'
    field_name TEXT,            -- Which field changed (for price_changed)
    old_value TEXT,
    new_value TEXT,
    detected_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES crawl_sessions(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);

-- 检测会话表：每次爬取产生一条记录
CREATE TABLE IF NOT EXISTS crawl_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT DEFAULT 'running',
    source_url TEXT NOT NULL,
    total_products INTEGER DEFAULT 0,
    new_products INTEGER DEFAULT 0,
    subcategories_found INTEGER DEFAULT 0,
    price_changes INTEGER DEFAULT 0
);

-- 会话分类统计表
CREATE TABLE IF NOT EXISTS session_category_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES crawl_sessions(id)
);

-- 会话产品关联表
CREATE TABLE IF NOT EXISTS session_products (
    session_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    is_new BOOLEAN DEFAULT 0,
    subcategory TEXT,
    PRIMARY KEY (session_id, product_id)
);

-- 配置表
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- 插入默认配置
INSERT OR IGNORE INTO settings (key, value) VALUES ('source_url', 'https://www.lidl.de/c/baumarkt-garten/s10067761');
INSERT OR IGNORE INTO settings (key, value) VALUES ('cron_schedule', '0 4 * * *');
