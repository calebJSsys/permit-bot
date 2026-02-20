const express = require('express');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'permits.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS permits (
    id TEXT PRIMARY KEY,
    city TEXT,
    address TEXT,
    permit_type TEXT,
    estimated_value REAL,
    contractor_name TEXT,
    permit_date TEXT,
    status TEXT,
    zip_code TEXT,
    description TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS risk_scores (
    zip_code TEXT PRIMARY KEY,
    poverty_rate REAL,
    median_build_year INTEGER,
    crime_score INTEGER,
    fire_score INTEGER,
    risk_level TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_city ON permits(city);
  CREATE INDEX IF NOT EXISTS idx_date ON permits(permit_date);
  CREATE INDEX IF NOT EXISTS idx_zip ON permits(zip_code);
  CREATE INDEX IF NOT EXISTS idx_value ON permits(estimated_value);
`);
try { db.exec(`ALTER TABLE permits ADD COLUMN description TEXT`); } catch(_) {}

// ─── Risk Scoring via US Census ACS ──────────────────────────────
// Crime proxy: poverty rate per ZIP (B17001)
// Fire proxy:  median building age per ZIP (B25037)
async function fetchRiskScores() {
  console.log('[risk] Fetching risk scores from Census ACS...');
  const zips = db.prepare(
    `SELECT DISTINCT zip_code FROM permits WHERE zip_code != '' AND length(zip_code) = 5`
  ).all().map(r => r.zip_code);
  if (!zips.length) return;

  const BATCH = 50;
  const currentYear = new Date().getFullYear();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO risk_scores
      (zip_code, poverty_rate, median_build_year, crime_score, fire_score, risk_level, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (let i = 0; i < zips.length; i += BATCH) {
    const batch = zips.slice(i, i + BATCH).join(',');
    try {
      const res = await axios.get('https://api.census.gov/data/2022/acs/acs5', {
        params: { get: 'B17001_002E,B17001_001E,B25037_001E', for: `zip code tabulation area:${batch}` },
        timeout: 15000,
      });
      db.transaction((rows) => {
        for (const [poor, total, buildYear, zip] of rows) {
          const povertyRate = total > 0 ? (parseFloat(poor) / parseFloat(total)) * 100 : null;
          const medBuildYear = parseInt(buildYear) || null;
          if (!povertyRate && !medBuildYear) continue;
          const crimeScore = povertyRate != null
            ? Math.min(10, Math.max(1, Math.round((povertyRate / 25) * 9) + 1)) : 5;
          const buildingAge = medBuildYear ? currentYear - medBuildYear : 50;
          const fireScore = Math.min(10, Math.max(1, Math.round((buildingAge / 100) * 9) + 1));
          const combined = (crimeScore + fireScore) / 2;
          const riskLevel = combined >= 7 ? 'HIGH' : combined >= 4.5 ? 'MEDIUM' : 'LOW';
          insert.run(zip, povertyRate, medBuildYear, crimeScore, fireScore, riskLevel);
        }
      })(res.data.slice(1));
      console.log(`[risk] Batch ${Math.floor(i / BATCH) + 1} scored`);
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error('[risk] Census error:', err.message);
    }
  }
  console.log(`[risk] Done — ${db.prepare('SELECT COUNT(*) as n FROM risk_scores').get().n} ZIPs scored`);
}

// ─── City Data Sources ────────────────────────────────────────────
// Focus: South of I-70 corridor + specified states
// Socrata open data APIs (free, no auth required)
// To add a city: add entry to SOCRATA_CITIES with url + normalize function
// For ArcGIS cities (Houston, Phoenix, Atlanta etc.) see README for pattern
const SOCRATA_CITIES = {
  austin: {
    url: 'https://data.austintexas.gov/resource/3syk-w9eu.json',
    normalize: (r) => ({
      id: `austin-${r.permit_num || Math.random()}`,
      city: 'austin',
      address: r.original_address1 || '',
      permit_type: r.permit_type_desc || r.work_class || '',
      estimated_value: parseFloat(r.job_value) || 0,
      contractor_name: r.contractor_company_name || '',
      permit_date: r.issue_date ? r.issue_date.split('T')[0] : '',
      status: r.status_current || 'issued',
      zip_code: r.zip || '',
      description: r.description || '',
    }),
  },
  san_francisco: {
    // SF is ~37.7°N — south of the I-70 corridor latitude
    url: 'https://data.sfgov.org/resource/i98e-djp9.json',
    normalize: (r) => ({
      id: `sf-${r.permit_number || Math.random()}`,
      city: 'san_francisco',
      address: r.street_address || `${r.house_num || ''} ${r.street_name || ''}`.trim(),
      permit_type: r.permit_type_definition || r.permit_type || '',
      estimated_value: parseFloat(r.revised_cost) || parseFloat(r.estimated_cost) || 0,
      contractor_name: r.contractor || '',
      permit_date: r.issued_date ? r.issued_date.split('T')[0] : '',
      status: r.status || 'issued',
      zip_code: r.zipcode || '',
      description: r.description || '',
    }),
  },
  kansas_city: {
    // data.kcmo.org — CPD Permits dataset, verified 2025
    url: 'https://data.kcmo.org/resource/ntw8-aacc.json',
    order: 'issueddate DESC',
    normalize: (r) => ({
      id: `kc-${r.permitnum || Math.random()}`,
      city: 'kansas_city',
      address: r.originaladdress1 || '',
      permit_type: r.permittypedesc || r.permittype || '',
      estimated_value: parseFloat(r.estprojectcost) || 0,
      contractor_name: r.contractorcompanyname || '',
      permit_date: r.issueddate ? r.issueddate.split('T')[0] : '',
      status: r.statuscurrent || 'issued',
      zip_code: r.originalzip || '',
      description: r.description || '',
    }),
  },
  san_diego: {
    // San Diego County open data — publicly accessible Socrata portal
    url: 'https://internal-sandiegocounty.data.socrata.com/resource/dyzh-7eat.json',
    order: 'open_date DESC',
    normalize: (r) => ({
      id: `sandiego-${r.record_id || Math.random()}`,
      city: 'san_diego',
      address: r.street_address || '',
      permit_type: r.record_category || r.record_type || '',
      estimated_value: 0,
      contractor_name: r.contractor_name || '',
      permit_date: r.open_date ? r.open_date.split('T')[0] : '',
      status: r.record_status || 'issued',
      zip_code: r.zip_code || '',
      description: (r.use || '').substring(0, 500),
    }),
  },
  // ── CITIES NEEDING ARCGIS FETCHER (not Socrata) ──
  // houston:    cohgis-mycity.opendata.arcgis.com
  // nashville:  data.nashville.gov → ArcGIS Hub
  // phoenix:    opendata.phoenix.gov → ArcGIS Hub
  // charlotte:  data.charlottenc.gov → ArcGIS Hub
};

// Philadelphia uses CartoDB SQL API instead of Socrata
async function fetchPhiladelphia() {
  try {
    const sql = `SELECT permitnumber, address, zip, permittype, typeofwork, approvedscopeofwork, permitissuedate, status, contractorname FROM permits ORDER BY permitissuedate DESC LIMIT 1000`;
    const res = await axios.get('https://phl.carto.com/api/v2/sql', {
      params: { q: sql, format: 'json' }, timeout: 20000,
    });
    const insert = db.prepare(`
      INSERT OR REPLACE INTO permits
        (id, city, address, permit_type, estimated_value, contractor_name, permit_date, status, zip_code, description, fetched_at)
      VALUES (@id, @city, @address, @permit_type, @estimated_value, @contractor_name, @permit_date, @status, @zip_code, @description, datetime('now'))
    `);
    const count = db.transaction((rows) => {
      let n = 0;
      for (const r of rows) {
        try {
          const rec = {
            id: `philly-${r.permitnumber || Math.random()}`, city: 'philadelphia',
            address: r.address || '', permit_type: r.permittype || r.typeofwork || '',
            estimated_value: 0, contractor_name: r.contractorname || '',
            permit_date: r.permitissuedate ? r.permitissuedate.split('T')[0] : '',
            status: r.status || 'issued', zip_code: r.zip || '',
            description: r.approvedscopeofwork || '',
          };
          if (rec.id && rec.address) { insert.run(rec); n++; }
        } catch(_) {}
      }
      return n;
    })(res.data.rows || []);
    console.log(`[philadelphia] ${count} permits stored`);
    return { city: 'philadelphia', inserted: count };
  } catch (err) {
    console.error('[philadelphia] error:', err.message);
    return { city: 'philadelphia', inserted: 0 };
  }
}

async function fetchCity(cityKey) {
  const city = SOCRATA_CITIES[cityKey];
  try {
    const res = await axios.get(city.url, {
      params: { $limit: 1000, $order: city.order || ':created_at DESC' }, timeout: 20000,
    });
    const insert = db.prepare(`
      INSERT OR REPLACE INTO permits
        (id, city, address, permit_type, estimated_value, contractor_name, permit_date, status, zip_code, description, fetched_at)
      VALUES (@id, @city, @address, @permit_type, @estimated_value, @contractor_name, @permit_date, @status, @zip_code, @description, datetime('now'))
    `);
    const count = db.transaction((rows) => {
      let n = 0;
      for (const r of rows) {
        try { const rec = city.normalize(r); if (rec.id && rec.address) { insert.run(rec); n++; } } catch(_) {}
      }
      return n;
    })(res.data);
    console.log(`[${cityKey}] ${count} permits stored`);
    return { city: cityKey, inserted: count };
  } catch (err) {
    console.error(`[${cityKey}] error:`, err.message);
    return { city: cityKey, inserted: 0 };
  }
}

async function fetchAll() {
  console.log('[fetch] Refreshing all cities...');
  await Promise.allSettled([
    ...Object.keys(SOCRATA_CITIES).map(fetchCity),
    fetchPhiladelphia(),
  ]);
  await fetchRiskScores();
  const counts = db.prepare('SELECT city, COUNT(*) as n FROM permits GROUP BY city').all();
  console.log('[fetch] Done:', counts.map(c => `${c.city}:${c.n}`).join(', '));
}

// ─── API Routes ───────────────────────────────────────────────────
app.get('/api', (req, res) => res.json({
  name: 'PermitBot API',
  version: '1.0.0',
  cities: [...Object.keys(SOCRATA_CITIES), 'philadelphia'],
  endpoints: ['/health', '/stats', '/permits'],
}));

app.get('/health', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as n FROM permits').get();
  const riskCount = db.prepare('SELECT COUNT(*) as n FROM risk_scores').get();
  res.json({ status: 'ok', permits_in_db: count.n, risk_scores: riskCount.n, uptime_seconds: Math.floor(process.uptime()) });
});

app.get('/stats', (req, res) => {
  const byCity = db.prepare('SELECT city, COUNT(*) as count FROM permits GROUP BY city ORDER BY count DESC').all();
  const total = db.prepare('SELECT COUNT(*) as n FROM permits').get();
  const riskCounts = db.prepare('SELECT risk_level, COUNT(*) as count FROM risk_scores GROUP BY risk_level').all();
  const newest = db.prepare('SELECT MAX(fetched_at) as last FROM permits').get();
  res.json({ total: total.n, by_city: byCity, risk_distribution: riskCounts, last_refresh: newest.last });
});

app.get('/permits', (req, res) => {
  const { city, type, min_value, days, zip, risk, limit = 100 } = req.query;
  let sql = `
    SELECT p.*, r.crime_score, r.fire_score, r.risk_level, r.poverty_rate, r.median_build_year
    FROM permits p LEFT JOIN risk_scores r ON p.zip_code = r.zip_code WHERE 1=1
  `;
  const params = [];
  if (city) { sql += ' AND p.city = ?'; params.push(city.toLowerCase()); }
  if (type) { sql += ' AND p.permit_type LIKE ?'; params.push(`%${type}%`); }
  if (min_value) { sql += ' AND p.estimated_value >= ?'; params.push(parseFloat(min_value)); }
  if (zip) { sql += ' AND p.zip_code = ?'; params.push(zip); }
  if (days) { sql += ` AND p.permit_date >= date('now', '-${parseInt(days)} days')`; }
  if (risk === 'high') { sql += ` AND r.risk_level = 'HIGH'`; }
  else if (risk === 'medium') { sql += ` AND r.risk_level IN ('HIGH','MEDIUM')`; }
  sql += ' ORDER BY p.permit_date DESC, p.estimated_value DESC LIMIT ?';
  params.push(Math.min(parseInt(limit) || 100, 500));
  try {
    res.json({ count: 0, results: db.prepare(sql).all(...params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PermitBot API running on port ${PORT}`);
  fetchAll();
});

// Permits refresh daily at 2am, risk scores refresh weekly Sunday 3am
cron.schedule('0 2 * * *', async () => {
  await Promise.allSettled([...Object.keys(SOCRATA_CITIES).map(fetchCity), fetchPhiladelphia()]);
});
cron.schedule('0 3 * * 0', fetchRiskScores);
