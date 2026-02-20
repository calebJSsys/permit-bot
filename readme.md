# PermitBot

Construction permit lead intelligence tool for the security trailer, equipment rental, and construction services industry.

Scrapes public city permit databases, scores each permit's location by crime and fire risk using US Census data, and surfaces high-value leads in a searchable web UI and REST API.

**Current focus:** Cities south of the I-70 corridor — Texas, Oklahoma, Kansas, Missouri, Arizona, New Mexico, Tennessee, the Carolinas, Florida, Georgia, Arkansas, Alabama, and West Coast California.

---

## What It Does

- Pulls active building permits from city open data APIs (Socrata, CartoDB) daily
- Scores each ZIP code by **crime risk** (Census poverty rate) and **fire risk** (median building age)
- Serves a dark-mode web UI with filters, risk badges, clickable permit details, and CSV export
- Exposes a REST API for integration with CRMs or sales tools

### Who Uses This

- **Security trailer companies** — target high-crime construction sites before competitors
- **Temp fencing / equipment rental** — filter by project value + risk level
- **Portable restroom / toilet services** — find active large construction sites
- **Construction supply vendors** — identify active job sites in your territory

---

## Architecture

```
index.js          Express API + SQLite + cron jobs
public/index.html Single-page web UI (vanilla JS, no framework)
permits.db        SQLite database (gitignored — generated at runtime)
```

**Data flow:**
1. On startup and daily at 2am: fetch 1,000 latest permits per city from open data APIs
2. After each permit refresh: query US Census ACS API for poverty rate + median build year per ZIP
3. Calculate `crime_score` (1-10) and `fire_score` (1-10) per ZIP, store in `risk_scores` table
4. UI and API join permits with risk scores on ZIP code

**Risk scoring methodology:**

| Score | Crime (poverty rate) | Fire (median build year) |
|-------|---------------------|--------------------------|
| 1-3 Low | < 7% poverty | Built after 2000 |
| 4-6 Medium | 7-15% poverty | Built 1970-2000 |
| 7-10 High | > 15% poverty | Built before 1970 |

> Data source: [US Census ACS 5-Year Estimates](https://api.census.gov/) — free, no API key required for typical usage.

---

## Setup

### Requirements
- Node.js 18+
- npm

### Install

```bash
git clone https://github.com/calebJSsys/permit-bot.git
cd permit-bot
npm install
npm start
```

Open `http://localhost:8080`

On first start it will fetch permits (~30 sec) then score ZIP codes via Census API (~1-2 min).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port to listen on |

---

## API Reference

### `GET /permits`

**Query params:**

| Param | Example | Description |
|-------|---------|-------------|
| `city` | `austin` | Filter by city key |
| `type` | `electrical` | Keyword match on permit type |
| `min_value` | `100000` | Minimum estimated project value |
| `days` | `30` | Issued within last N days |
| `zip` | `78701` | Filter by ZIP code |
| `risk` | `high` | `high`, `medium`, or omit for all |
| `limit` | `100` | Max results (max 500) |

**Example:**
```
GET /permits?city=austin&risk=high&min_value=500000&days=30
```

**Response includes:** `crime_score`, `fire_score`, `risk_level`, `poverty_rate`, `median_build_year` joined from the risk_scores table.

### `GET /stats`
Permit counts by city + risk distribution (HIGH/MEDIUM/LOW counts).

### `GET /health`
Server status, permit count, scored ZIP count, uptime.

---

## City Coverage

### Currently Active

| City | State | API Type | Notes |
|------|-------|----------|-------|
| Austin | TX | Socrata | Full data |
| San Francisco | CA | Socrata | Full data |
| Philadelphia | PA | CartoDB | No value field |

### Adding New Cities

Most US cities use either Socrata or ArcGIS for open data.

#### Socrata (add to `SOCRATA_CITIES` in index.js)

```js
your_city: {
  url: 'https://data.yourcity.gov/resource/XXXX-XXXX.json',
  normalize: (r) => ({
    id: `yourcity-${r.permit_number || Math.random()}`,
    city: 'your_city',
    address: r.address_field || '',
    permit_type: r.permit_type_field || '',
    estimated_value: parseFloat(r.cost_field) || 0,
    contractor_name: r.contractor_field || '',
    permit_date: r.date_field ? r.date_field.split('T')[0] : '',
    status: r.status_field || 'issued',
    zip_code: r.zip_field || '',
    description: r.description_field || '',
  }),
},
```

Find the resource ID: go to `data.[city].gov`, search "building permits", copy the 9-char ID from the API URL.

#### ArcGIS (Houston, Phoenix, Nashville, Atlanta, etc.)

Most southern cities use ArcGIS instead of Socrata. Fetch pattern:

```js
const res = await axios.get('https://[city-arcgis-server]/arcgis/rest/services/.../FeatureServer/0/query', {
  params: {
    where: '1=1',
    outFields: 'permit_num,address,zip,permit_type,job_value,contractor,issue_date,status',
    resultRecordCount: 1000,
    orderByFields: 'issue_date DESC',
    f: 'json',
  },
});
// records are at res.data.features[].attributes
```

#### Priority Cities to Add (south of I-70)

| City | State | Platform | Notes |
|------|-------|----------|-------|
| Houston | TX | ArcGIS | cohgis-mycity.opendata.arcgis.com |
| Dallas | TX | ArcGIS | dallasopendata.com |
| San Antonio | TX | ? | Check data.sanantonio.gov |
| Phoenix | AZ | ArcGIS | phoenixopendata.com |
| Tucson | AZ | ArcGIS | |
| Nashville | TN | ArcGIS | data.nashville.gov redirects |
| Charlotte | NC | ArcGIS | |
| Raleigh | NC | ? | |
| Atlanta | GA | ArcGIS | gis.atlantaga.gov |
| Miami | FL | ArcGIS | |
| Tampa | FL | ArcGIS | |
| Jacksonville | FL | ? | |
| Kansas City | MO | ? | data.kcmo.org |
| Oklahoma City | OK | ? | |
| Denver | CO | OpenDataSoft | Old Socrata endpoint broken |
| Colorado Springs | CO | ? | |
| Albuquerque | NM | ? | |
| Birmingham | AL | ? | |
| Los Angeles | CA | Socrata | 403 without app token |
| San Diego | CA | ArcGIS | |

---

## Deployment Options

### Current: Conway Cloud
Running at `https://permitbot.life.conway.tech`
- Sandbox: `b7f74dac57506c9ce613b4a9e92b838e`
- Cost: ~$8/month (1 vCPU, 1GB RAM, 10GB disk)
- Process manager: pm2

Redeploy to new Conway sandbox:
```bash
git clone https://github.com/calebJSsys/permit-bot.git /root/permit-bot
cd /root/permit-bot && npm install
pm2 start index.js --name permit-bot && pm2 save
```

### Oracle Cloud Free Tier (recommended)
Permanently free — no charges if you stay in free tier:
- 2x AMD VMs (1 OCPU, 1GB RAM) OR 1x ARM VM (4 OCPU, 24GB RAM)
- 200GB block storage

Setup: [cloud.oracle.com](https://cloud.oracle.com) → Create Always Free VM → Ubuntu 22.04 → SSH in → install Node.js → clone + run.

Best option for zero cost self-hosting.

### Railway
- $5/month free credit, auto-deploy from GitHub
- Persistent volumes for SQLite
- `railway up` to deploy

### Fly.io
- 3 free shared VMs, but needs paid persistent volume for SQLite (~$1.50/month for 10GB)
- Good DX: `fly deploy`

### DigitalOcean Droplet
- $6/month (1 vCPU, 1GB RAM, 25GB SSD)
- Reliable, straightforward SSH setup

### Self-Hosted (Mini PC / Raspberry Pi)
- One-time cost: $50-200 hardware
- Zero ongoing cost
- Needs: DuckDNS (free) for dynamic DNS + port forwarding
- Best for internal use only

---

## Conway Automation Notes

The Conway Automaton (https://github.com/Conway-Research/automaton) was tested during development.

Key findings:
- Use `gpt-4o-mini` — Conway proxy doesn't support Anthropic models without a separate API key
- The automaton loops on setup tasks without a very tight, focused genesis prompt
- Better for maintenance tasks than initial build

### Simpler Automation Test Ideas

For testing x402 payments and autonomous operation cleanly:

**1. ZIP Code Risk API (x402-gated)**
One endpoint: `GET /risk/:zip` — returns crime score, fire score, recent permit count.
Charge $0.05/lookup via x402. Simple, useful, directly extends this codebase.

**2. Daily Permit Digest Bot**
Cron job that posts new high-risk/high-value permits to a Slack webhook or email daily.
No payment needed — just tests autonomous operation and monitoring.

**3. Contractor Lookup**
Many states publish contractor license databases. Simple scraper that checks if a contractor name is licensed and bonded. Charge per lookup via x402.

The pattern for x402 on Conway: use the `x402-express` middleware or check the Conway automaton repo for the payment verification flow.

---

## Development Notes

- `permits.db` is gitignored — created on first run
- The `description` column is added via `ALTER TABLE` on startup (safe/idempotent)
- Risk scores refresh weekly (Sunday 3am) — Census data doesn't change often
- Permits refresh daily (2am) — adjust cron strings in `index.js` as needed
- `/permits` caps at 500 results to protect memory on small VMs

---

## License

Internal use only.
