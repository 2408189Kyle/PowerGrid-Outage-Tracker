# PowerGrid Outage Tracker

## Run locally

Use the Express server for both the frontend and API; VS Code Live Server does not provide the authentication routes.

1. Install dependencies:
   ```powershell
   npm install
   ```
2. Make sure `.env` exists. If needed, copy `.env.example` to `.env`, then set a private, random `JWT_SECRET` of at least 32 characters and keep `POSTGRES_PASSWORD` consistent with `DATABASE_URL`.
3. Start PostgreSQL/PostGIS, Mosquitto, and MinIO:
   ```powershell
   docker compose up -d
   ```
   On a new database volume, Docker initializes the schema and sample data from `migrations/`. For a database volume created before the local-demo integration, apply the new migration once:
   ```powershell
   docker compose exec -T db psql -U postgres -d powergrid -f /docker-entrypoint-initdb.d/005_local_demo_integrations.sql
   ```
4. Start the app:
   ```powershell
   npm run dev
   ```
5. Open <http://localhost:3002/Login.html> for resident sign-in and registration, or <http://localhost:3002/StaffLogin.html> for staff sign-in. Do not open either page directly as a file or with Live Server; authentication and barangay options require the Express API. The VS Code **Open Login.html** launch configuration starts the backend and opens the resident page.

The local demo staff account is `staff@powergrid.ph` / `PowerGrid123`; use it only on the staff sign-in page. To create or reset it in the local database:

```powershell
npm run admin:create -- staff@powergrid.ph PowerGrid123 "PowerGrid Staff"
```

Public registration creates resident-only accounts in PostgreSQL. To onboard staff, have them create an account on the resident page, then an existing administrator can open **System management → Manage users** and select **Make staff** for that account. The staff member can then use the same email and password on `StaffLogin.html`; if they were already signed in, they can open the staff page and sign in again after promotion. The sign-in API requires a resident or staff audience and rejects accounts whose role does not match the selected portal. Public registration never grants staff access. The signup barangay list is loaded from `GET /api/barangays`; local setup includes six sample barangays with approximate map markers and estimated household counts. These are demo locations, not official service-area boundaries. The two existing sample polygons are also approximate and should be replaced with verified GIS data before deployment.

Outage reports, announcements, barangay management, user roles/status, and community feedback are stored in PostgreSQL. Report photos are limited to 8 MB and served only to logged-in users. New uploads use the MinIO S3-compatible service by default; the bucket is created on first upload. The MinIO console is at <http://localhost:9001>. Since the original public MinIO image is no longer available without registry access, this local-only setup pins Bitnami's archived MinIO image; it is not supported for production. Local development credentials are defined in `.env.example` and can be overridden in `.env`; do not reuse them outside a local demo. Existing unprefixed photo paths continue to read from the ignored `storage/report-photos/` folder, and `PHOTO_STORAGE=local` is available for disk-only development. Production must use a supported, maintained S3-compatible service with private credentials and persistent storage/backups.

The MQTT adapter is prepared but disabled by default. To enable it locally, set `MQTT_ENABLED=true` and configure `MQTT_URL` and `MQTT_TOPIC_PREFIX` in `.env`. Registered nodes accept heartbeat messages on `powergrid/nodes/<node-name>/heartbeat` with JSON payload `{"seq":42,"latency_ms":18,"packet_loss_pct":0}`. `seq` must be a non-negative integer, latency is limited to 60,000 ms, and packet loss must be between 0 and 100. Unknown nodes and invalid payloads are ignored and logged. Heartbeats update node telemetry only; they do not automatically create outage incidents. The browser's feeder fault controls remain simulated, no physical sensors are connected, and the bundled Mosquitto broker allows anonymous access only for its loopback-bound local demo.

Run backend tests with `npm test -- --runInBand`.
