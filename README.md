# PowerGrid Outage Tracker

## Run locally

Use the Express server for both the frontend and API; VS Code Live Server does not provide the authentication routes.

1. Install dependencies:
   ```powershell
   npm install
   ```
2. Make sure `.env` exists. If needed, copy `.env.example` to `.env`, then set a private, random `JWT_SECRET` of at least 32 characters and keep `POSTGRES_PASSWORD` consistent with `DATABASE_URL`.
3. Start PostgreSQL/PostGIS and Mosquitto:
   ```powershell
   docker compose up -d
   ```
   On a new database volume, Docker initializes the schema and sample data from `migrations/`.
4. Start the app:
   ```powershell
   npm run dev
   ```
5. Open <http://localhost:3002/Login.html>.

The login page's demo staff account is `staff@powergrid.ph` / `PowerGrid123`. To create or reset it in the local database:

```powershell
npm run admin:create -- staff@powergrid.ph PowerGrid123 "PowerGrid Staff"
```

Public registration creates resident accounts in PostgreSQL. The signup barangay list is loaded from `GET /api/barangays`; the current migration seeds test barangays, which should be replaced with real data before deployment.
