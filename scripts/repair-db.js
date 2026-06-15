const path = require('path');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'crawler.db');
const BACKUP_SUFFIX = `.corrupt-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

function log(msg) {
    console.log(`[db:repair] ${msg}`);
}

function run(cmd) {
    return spawnSync('bash', ['-c', cmd], { encoding: 'utf-8' });
}

function fileExists(p) {
    try { return fs.existsSync(p); } catch { return false; }
}

function main() {
    if (!fileExists(DB_PATH)) {
        log(`No DB at ${DB_PATH}. Nothing to repair. Run \`npm run init\` to create one.`);
        return;
    }

    const integrity = run(`sqlite3 "${DB_PATH}" "PRAGMA integrity_check;"`);
    if (integrity.status === 0 && integrity.stdout.trim() === 'ok') {
        log('integrity_check ok. No repair needed.');
        return;
    }

    log('integrity_check FAILED. Backing up corrupt DB and attempting recovery...');
    for (const ext of ['', '-shm', '-wal']) {
        const src = `${DB_PATH}${ext}`;
        if (fileExists(src)) {
            fs.copyFileSync(src, `${src}${BACKUP_SUFFIX}`);
        }
    }

    const recoverSql = '/tmp/recover.sql';
    const rec = run(`sqlite3 "${DB_PATH}" ".recover" > ${recoverSql}`);
    if (rec.status !== 0) {
        log(`Recovery dump failed: ${rec.stderr}`);
        process.exit(1);
    }
    log(`Recovery dump written: ${recoverSql} (${fs.statSync(recoverSql).size} bytes)`);

    const recoveredPath = path.join(DATA_DIR, 'recovered.db');
    if (fileExists(recoveredPath)) fs.unlinkSync(recoveredPath);

    const apply = run(`sqlite3 "${recoveredPath}" < ${recoverSql}`);
    if (apply.status !== 0) {
        log(`Applying recovery failed: ${apply.stderr}`);
        process.exit(1);
    }

    const check = run(`sqlite3 "${recoveredPath}" "PRAGMA integrity_check;"`);
    if (check.status !== 0 || check.stdout.trim() !== 'ok') {
        log(`Recovered DB failed integrity check: ${check.stdout}`);
        process.exit(1);
    }

    log('Recovered DB passes integrity check. Replacing original...');
    for (const ext of ['', '-shm', '-wal']) {
        const target = `${DB_PATH}${ext}`;
        if (fileExists(target)) fs.unlinkSync(target);
    }
    fs.renameSync(recoveredPath, DB_PATH);

    log('Truncating WAL to ensure clean state...');
    run(`sqlite3 "${DB_PATH}" "PRAGMA wal_checkpoint(TRUNCATE);"`);

    log('Repair complete. Backup of corrupt files kept with suffix: ' + BACKUP_SUFFIX);
    log('Run `npm run init` to re-apply schema and migrations.');
}

main();
