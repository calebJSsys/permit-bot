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
  new_orleans: {
    // data.nola.gov — verified current (2026 data)
    url: 'https://data.nola.gov/resource/rcm3-fn58.json',
    order: 'issuedate DESC',
    normalize: (r) => ({
      id: `nola-${r.numstring || Math.random()}`,
      city: 'new_orleans',
      address: r.address || '',
      permit_type: r.type || '',
      estimated_value: parseFloat(r.constrval) || 0,
      contractor_name: r.contractors || '',
      permit_date: r.issuedate ? r.issuedate.split('T')[0] : '',
      status: r.currentstatus || 'issued',
      zip_code: '',
      description: r.description || '',
    }),
  },
  baton_rouge: {
    // data.brla.gov — EBR Building Permits, verified current (2026 data)
    url: 'https://data.brla.gov/resource/7fq7-8j7r.json',
    order: 'issueddate DESC',
    normalize: (r) => ({
      id: `br-${r.permitnumber || Math.random()}`,
      city: 'baton_rouge',
      address: r.streetaddress || '',
      permit_type: r.permittype || '',
      estimated_value: parseFloat(r.projectvalue) || 0,
      contractor_name: r.contractorname || '',
      permit_date: r.issueddate ? r.issueddate.split('T')[0] : '',
      status: 'issued',
      zip_code: r.zip || '',
      description: r.projectdescription || '',
    }),
  },
};

// ─── ArcGIS City Data Sources ─────────────────────────────────────
// Nearly all southern/southwest US cities use ArcGIS Hub instead of Socrata.
//
// To activate a city:
//   1. Go to the portal URL in the comment
//   2. Search "building permits", open the dataset
//   3. Click "I want to use this" → copy the FeatureServer URL
//      e.g. https://services1.arcgis.com/[ORG]/arcgis/rest/services/[NAME]/FeatureServer
//   4. Test in browser: [url]/0/query?where=1=1&outFields=*&resultRecordCount=1&f=json
//   5. Replace [VERIFY-FEATURESERVER-URL] below and fill in the real field names
//   6. Uncomment the block and restart
//
// ArcGIS date fields are Unix timestamps (ms):
//   r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : ''
const ARCGIS_CITIES = {

  // ── Texas ──────────────────────────────────────────────────────
  // houston: {
  //   // Portal: https://cohgis-mycity.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `houston-${r.PermitNumber || Math.random()}`,
  //     city: 'houston',
  //     address: r.SiteAddress || r.Address || '',
  //     permit_type: r.PermitType || r.WorkType || '',
  //     estimated_value: parseFloat(r.DeclaredValuation || r.ProjectCost) || 0,
  //     contractor_name: r.ContractorName || r.Contractor || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.ZipCode || r.Zip || '',
  //     description: r.ProjectDescription || r.Description || '',
  //   }),
  // },
  // fort_worth: {
  //   // Portal: https://data.fortworthtexas.gov → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `fortworth-${r.PermitNum || r.PermitNumber || Math.random()}`,
  //     city: 'fort_worth',
  //     address: r.Address || r.SiteAddress || '',
  //     permit_type: r.PermitType || r.PermitDesc || '',
  //     estimated_value: parseFloat(r.JobValue || r.EstimatedCost) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || r.ZipCode || '',
  //     description: r.Description || r.WorkDesc || '',
  //   }),
  // },
  // san_antonio: {
  //   // Portal: https://sanantonio.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `satx-${r.PermitNum || Math.random()}`,
  //     city: 'san_antonio',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue || r.EstCost) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // el_paso: {
  //   // Portal: https://opendata.elpasotexas.gov → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `elpaso-${r.PermitNum || Math.random()}`,
  //     city: 'el_paso',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // mcallen: {
  //   // Portal: https://mcallen-tx.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `mcallen-${r.PermitNum || Math.random()}`,
  //     city: 'mcallen',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Florida ────────────────────────────────────────────────────
  // miami: {
  //   // Portal: https://gis-mdc.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `miami-${r.PermitNum || Math.random()}`,
  //     city: 'miami',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || r.WorkType || '',
  //     estimated_value: parseFloat(r.JobValue || r.EstCost) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // fort_lauderdale: {
  //   // Portal: https://gis-broward-county-fl-broward.hub.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `ftlaud-${r.PermitNum || Math.random()}`,
  //     city: 'fort_lauderdale',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // west_palm_beach: {
  //   // Portal: https://pbcgis-pbcgov.hub.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `wpb-${r.PermitNum || Math.random()}`,
  //     city: 'west_palm_beach',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // tampa: {
  //   // Portal: https://city-tampa.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `tampa-${r.PermitNum || Math.random()}`,
  //     city: 'tampa',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || r.PermitDesc || '',
  //     estimated_value: parseFloat(r.JobValue || r.EstCost) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // st_petersburg: {
  //   // Portal: https://stpete.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `stpete-${r.PermitNum || Math.random()}`,
  //     city: 'st_petersburg',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // jacksonville: {
  //   // Portal: https://coj-cogis.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `jax-${r.PermitNum || Math.random()}`,
  //     city: 'jacksonville',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Georgia ────────────────────────────────────────────────────
  // atlanta: {
  //   // Portal: https://atlantaga.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'ISSUE_DATE DESC',
  //   normalize: (r) => ({
  //     id: `atl-${r.PERMIT_NUM || r.PermitNumber || Math.random()}`,
  //     city: 'atlanta',
  //     address: r.ADDRESS || r.SITE_ADDRESS || '',
  //     permit_type: r.PERMIT_TYPE || r.WORK_TYPE || '',
  //     estimated_value: parseFloat(r.COST || r.JOB_VALUE) || 0,
  //     contractor_name: r.CONTRACTOR || r.CONTRACTOR_NAME || '',
  //     permit_date: r.ISSUE_DATE ? new Date(r.ISSUE_DATE).toISOString().split('T')[0] : '',
  //     status: r.STATUS || 'issued',
  //     zip_code: r.ZIP || '',
  //     description: r.DESCRIPTION || r.WORK_DESC || '',
  //   }),
  // },
  // savannah: {
  //   // Portal: https://cosavannahga.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `savannah-${r.PermitNum || Math.random()}`,
  //     city: 'savannah',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Alabama ────────────────────────────────────────────────────
  // huntsville: {
  //   // Portal: https://huntsvilleal.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `huntsville-${r.PermitNum || Math.random()}`,
  //     city: 'huntsville',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // birmingham: {
  //   // Portal: https://birmingham-al.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `birmingham-${r.PermitNum || Math.random()}`,
  //     city: 'birmingham',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Tennessee ──────────────────────────────────────────────────
  // nashville: {
  //   // Portal: https://data.nashville.gov → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'date_issued DESC',
  //   normalize: (r) => ({
  //     id: `nashville-${r.permit_number || Math.random()}`,
  //     city: 'nashville',
  //     address: r.mapped_location_address || r.address || '',
  //     permit_type: r.permit_type || r.permit_subtype || '',
  //     estimated_value: parseFloat(r.const_cost) || 0,
  //     contractor_name: r.contractor_name || '',
  //     permit_date: r.date_issued ? new Date(r.date_issued).toISOString().split('T')[0] : '',
  //     status: r.status || 'issued',
  //     zip_code: r.zip || '',
  //     description: r.description || '',
  //   }),
  // },
  // memphis: {
  //   // Portal: https://data.memphistn.gov → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `memphis-${r.PermitNum || Math.random()}`,
  //     city: 'memphis',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // chattanooga: {
  //   // Portal: https://data.chattanooga.gov → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `chat-${r.PermitNum || Math.random()}`,
  //     city: 'chattanooga',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── North Carolina ─────────────────────────────────────────────
  // charlotte: {
  //   // Portal: https://data.charlottenc.gov → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'ISSUED_DATE DESC',
  //   normalize: (r) => ({
  //     id: `charlotte-${r.PERMIT_NUM || Math.random()}`,
  //     city: 'charlotte',
  //     address: r.SITE_ADDRESS || '',
  //     permit_type: r.PERMIT_TYPE || r.WORK_TYPE || '',
  //     estimated_value: parseFloat(r.COST) || 0,
  //     contractor_name: r.CONTRACTOR || '',
  //     permit_date: r.ISSUED_DATE ? new Date(r.ISSUED_DATE).toISOString().split('T')[0] : '',
  //     status: r.STATUS || 'issued',
  //     zip_code: r.ZIP || '',
  //     description: r.DESCRIPTION || '',
  //   }),
  // },
  // raleigh: {
  //   // Portal: https://data.raleighnc.gov → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `raleigh-${r.PermitNum || Math.random()}`,
  //     city: 'raleigh',
  //     address: r.Address || r.SiteAddress || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // durham: {
  //   // Portal: https://live-durhamnc.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `durham-${r.PermitNum || Math.random()}`,
  //     city: 'durham',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── South Carolina ─────────────────────────────────────────────
  // charleston: {
  //   // Portal: https://charleston-sc-gis.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `charleston-${r.PermitNum || Math.random()}`,
  //     city: 'charleston',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // greenville_sc: {
  //   // Portal: https://greenville-sc.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `greenville-${r.PermitNum || Math.random()}`,
  //     city: 'greenville_sc',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Oklahoma ───────────────────────────────────────────────────
  // oklahoma_city: {
  //   // Portal: https://okc-maps.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `okc-${r.PermitNum || Math.random()}`,
  //     city: 'oklahoma_city',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue || r.Valuation) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // tulsa: {
  //   // Portal: https://cityoftulsa.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `tulsa-${r.PermitNum || Math.random()}`,
  //     city: 'tulsa',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Kansas ─────────────────────────────────────────────────────
  // wichita: {
  //   // Portal: https://wichita-gis.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `wichita-${r.PermitNum || Math.random()}`,
  //     city: 'wichita',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Missouri ───────────────────────────────────────────────────
  // st_louis: {
  //   // Portal: https://stlouis-mo-stlouis-mo.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `stl-${r.PermitNum || Math.random()}`,
  //     city: 'st_louis',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Colorado ───────────────────────────────────────────────────
  // denver: {
  //   // Portal: https://opendata-geospatialdenver.hub.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssuedDate DESC',
  //   normalize: (r) => ({
  //     id: `denver-${r.PermitNum || Math.random()}`,
  //     city: 'denver',
  //     address: r.Address || r.SiteAddress || '',
  //     permit_type: r.PermitType || r.WorkType || '',
  //     estimated_value: parseFloat(r.JobValue || r.TotalCost) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssuedDate ? new Date(r.IssuedDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // colorado_springs: {
  //   // Portal: https://coloradosprings.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `cos-${r.PermitNum || Math.random()}`,
  //     city: 'colorado_springs',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── Arizona ────────────────────────────────────────────────────
  // phoenix: {
  //   // Portal: https://phoenix-az.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'AppliedDate DESC',
  //   normalize: (r) => ({
  //     id: `phoenix-${r.PermitNum || Math.random()}`,
  //     city: 'phoenix',
  //     address: r.OriginalAddress1 || r.Address || '',
  //     permit_type: r.PermitTypeDesc || r.PermitType || '',
  //     estimated_value: parseFloat(r.EstProjectCost) || 0,
  //     contractor_name: r.ContractorCompanyName || '',
  //     permit_date: r.IssuedDate ? new Date(r.IssuedDate).toISOString().split('T')[0] : '',
  //     status: r.StatusCurrent || 'issued',
  //     zip_code: r.OriginalZip || '',
  //     description: r.Description || '',
  //   }),
  // },
  // tucson: {
  //   // Portal: https://tucson-opendata.hub.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `tucson-${r.PermitNum || Math.random()}`,
  //     city: 'tucson',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── New Mexico ─────────────────────────────────────────────────
  // albuquerque: {
  //   // Portal: https://cabq.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `abq-${r.PermitNum || Math.random()}`,
  //     city: 'albuquerque',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },

  // ── California ─────────────────────────────────────────────────
  // san_jose: {
  //   // Portal: https://sanjose.opendata.arcgis.com → search "building permits"
  //   url: 'https://[VERIFY-FEATURESERVER-URL]/0/query',
  //   orderBy: 'IssueDate DESC',
  //   normalize: (r) => ({
  //     id: `sanjose-${r.PermitNum || Math.random()}`,
  //     city: 'san_jose',
  //     address: r.Address || '',
  //     permit_type: r.PermitType || '',
  //     estimated_value: parseFloat(r.JobValue) || 0,
  //     contractor_name: r.ContractorName || '',
  //     permit_date: r.IssueDate ? new Date(r.IssueDate).toISOString().split('T')[0] : '',
  //     status: r.Status || 'issued',
  //     zip_code: r.Zip || '',
  //     description: r.Description || '',
  //   }),
  // },
};

async function fetchArcGIS(cityKey) {
  const city = ARCGIS_CITIES[cityKey];
  try {
    const res = await axios.get(city.url, {
      params: {
        where: city.where || '1=1',
        outFields: '*',
        resultRecordCount: city.limit || 1000,
        orderByFields: city.orderBy || 'IssueDate DESC',
        f: 'json',
      },
      timeout: 25000,
    });
    const features = res.data.features || [];
    if (res.data.error) throw new Error(JSON.stringify(res.data.error));
    const insert = db.prepare(`
      INSERT OR REPLACE INTO permits
        (id, city, address, permit_type, estimated_value, contractor_name, permit_date, status, zip_code, description, fetched_at)
      VALUES (@id, @city, @address, @permit_type, @estimated_value, @contractor_name, @permit_date, @status, @zip_code, @description, datetime('now'))
    `);
    const count = db.transaction((records) => {
      let n = 0;
      for (const feature of records) {
        try {
          const rec = city.normalize(feature.attributes);
          if (rec.id && rec.address) { insert.run(rec); n++; }
        } catch(_) {}
      }
      return n;
    })(features);
    console.log(`[${cityKey}] ${count} ArcGIS permits stored`);
    return { city: cityKey, inserted: count };
  } catch (err) {
    console.error(`[${cityKey}] ArcGIS error:`, err.message);
    return { city: cityKey, inserted: 0 };
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
    ...Object.keys(ARCGIS_CITIES).map(fetchArcGIS),
  ]);
  await fetchRiskScores();
  const counts = db.prepare('SELECT city, COUNT(*) as n FROM permits GROUP BY city').all();
  console.log('[fetch] Done:', counts.map(c => `${c.city}:${c.n}`).join(', '));
}

// ─── API Routes ───────────────────────────────────────────────────
app.get('/api', (req, res) => res.json({
  name: 'PermitBot API',
  version: '1.0.0',
  cities: [...Object.keys(SOCRATA_CITIES), ...Object.keys(ARCGIS_CITIES)],
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
  await Promise.allSettled([
    ...Object.keys(SOCRATA_CITIES).map(fetchCity),
    ...Object.keys(ARCGIS_CITIES).map(fetchArcGIS),
  ]);
});
cron.schedule('0 3 * * 0', fetchRiskScores);
