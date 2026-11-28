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
   On a new database volume, Docker initializes the schema and sample data from `database/migrations/`. For a database volume created before the local-demo integration, apply the new migration once:
   ```powershell
   docker compose exec -T db psql -U postgres -d powergrid -f /docker-entrypoint-initdb.d/005_local_demo_integrations.sql
   ```
   To enable profile picture uploads on an existing database volume, also apply:
   ```powershell
   docker compose exec -T db psql -U postgres -d powergrid -f /docker-entrypoint-initdb.d/006_user_profiles.sql
   ```
4. Start the app:
   ```powershell
   npm run dev
   ```
5. Open <http://localhost:3002/Login.html> for resident sign-in and registration, or <http://localhost:3002/StaffLogin.html> for staff sign-in. These `localhost` addresses work only on the computer running the app; they are for local testing and cannot be shared with other people. Do not open either page directly as a file or with Live Server; authentication and barangay options require the Express API. The VS Code **Open Login.html** launch configuration starts the backend and opens the resident page. To give other people access, deploy the app and share its public HTTPS URL as described below.

The local demo staff account is `staff@powergrid.ph` / `PowerGrid123`; use it only on the staff sign-in page. To create or reset it in the local database:

```powershell
npm run admin:create -- staff@powergrid.ph PowerGrid123 "PowerGrid Staff"
```

Public registration creates resident-only accounts in PostgreSQL. To onboard staff, have them create an account on the resident page, then an existing administrator can open **System management → Manage users** and select **Make staff** for that account. The staff member can then use the same email and password on `StaffLogin.html`; if they were already signed in, they can open the staff page and sign in again after promotion. The sign-in API requires a resident or staff audience and rejects accounts whose role does not match the selected portal. Public registration never grants staff access. The signup barangay list is loaded from `GET /api/barangays`; local setup includes six sample barangays with approximate map markers and estimated household counts. These are demo locations, not official service-area boundaries. The two existing sample polygons are also approximate and should be replaced with verified GIS data before deployment.

Outage reports, announcements, barangay management, user roles/status, and community feedback are stored in PostgreSQL. Report photos are limited to 8 MB and served only to logged-in users. New uploads use the MinIO S3-compatible service by default; the bucket is created on first upload. The MinIO console is at <http://localhost:9001>. Since the original public MinIO image is no longer available without registry access, this local-only setup pins Bitnami's archived MinIO image; it is not supported for production. Local development credentials are defined in `.env.example` and can be overridden in `.env`; do not reuse them outside a local demo. Existing unprefixed photo paths continue to read from the ignored `storage/report-photos/` folder, and `PHOTO_STORAGE=local` is available for disk-only development. Production must use a supported, maintained S3-compatible service with private credentials and persistent storage/backups.

The MQTT adapter is prepared but disabled by default. To enable it locally, set `MQTT_ENABLED=true` and configure `MQTT_URL` and `MQTT_TOPIC_PREFIX` in `.env`. Registered nodes accept heartbeat messages on `powergrid/nodes/<node-name>/heartbeat` with JSON payload `{"seq":42,"latency_ms":18,"packet_loss_pct":0}`. `seq` must be a non-negative integer, latency is limited to 60,000 ms, and packet loss must be between 0 and 100. Unknown nodes and invalid payloads are ignored and logged. Heartbeats update node telemetry only; they do not automatically create outage incidents. The browser's feeder fault controls remain simulated, but their simulated outages are now stored by the backend and shared with resident outage views. No physical sensors are connected, and the bundled Mosquitto broker allows anonymous access only for its loopback-bound local demo.

Project files are grouped by role: the browser app is in `frontend/`, the Express API and its admin script are in `backend/`, and SQL migrations are in `database/migrations/`.

## Vercel deployment

The repository is prepared to connect to Vercel through GitHub. Vercel uses the root `index.js` as the Express entry point, while `npm run build` copies the frontend into `public/` for Vercel's static asset hosting. Deploying still requires a Vercel project and a PostgreSQL provider with PostGIS, such as Neon.

To publish the site:

1. Push the reviewed project changes to the GitHub repository.
2. Import that repository into a Vercel project, using the repository root as the project root and `npm run build` as the build command.
3. Configure the production environment variables below, provision the database, run its migrations, and create a new production administrator account.
4. Deploy and verify the site and sign-in/API routes. Vercel will show the project's public HTTPS domain when deployment succeeds.

Share that actual domain with visitors. For example, if Vercel assigns `https://your-project.vercel.app`, the resident sign-in is `https://your-project.vercel.app/Login.html`, staff sign-in is `https://your-project.vercel.app/StaffLogin.html`, and Lite is `https://your-project.vercel.app/lite.html`. Replace the example domain with the one shown in the Vercel dashboard. Do not share a `localhost` URL. There is no public deployment URL until these setup and deployment steps are complete.

Configure these values in Vercel's project environment settings; never commit production secrets:

- `DATABASE_URL`: the provider's pooled PostgreSQL connection string with SSL enabled and the PostGIS extension available.
- `JWT_SECRET`: a private random value of at least 32 characters.
- `PHOTO_STORAGE=minio`, plus `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_REGION` for a durable S3-compatible object store. The existing local MinIO service and local disk storage are not production storage.

Run the SQL files in `database/migrations/` in numeric order against the production database before first use, then create an administrator with a unique strong password. Keep `MQTT_ENABLED` false on Vercel; its function runtime does not run the project's persistent MQTT listener. The main site's existing 8 MB photo upload limit may exceed Vercel's request-size limit; use direct-to-object-storage uploads or adjust this before relying on photo reports in production.

This repository setup does not deploy or publish itself. Connect the GitHub repository in your own Vercel account, configure the environment variables there, and review the deployment before sharing its HTTPS URL.

## PowerGrid Lite

For local testing, open <http://localhost:3002/lite.html> while the Express app and database are running. For a deployed site, open `<your-vercel-domain>/lite.html` instead. The localhost address works only on the computer running the app. Lite reuses the authenticated `/api/incidents` and `/api/incidents/reports` endpoints. Sign in on the resident page while connected; reports require that saved resident session.

Lite saves the last manually refreshed outage snapshot and queued text reports in this browser's IndexedDB. It does not refresh or sync in the background: use **Refresh outage data** and **Sync queued reports** only when you choose. With no network, saved information and queued reports remain on that device; fresh outages and report uploads are unavailable until a connection returns. The first visit must be online to load and cache the app shell. On mobile, any refresh or sync uses the available connection and may consume data.

The Lite map is an approximate, offline schematic based on the main site's demo barangay coordinates and coverage extent. It is not a street-accurate basemap, official barangay boundary, or navigation aid. Lite reports are text-only to keep the manual sync queue small; use the full app for photo attachments.

Run backend tests with `npm test -- --runInBand`.
