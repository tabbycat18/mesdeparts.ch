// backend/db.js
import pg from "pg";
import { resolvePgApplicationName } from "./src/db/applicationName.js";

const { Pool } = pg;

// Neon requires a full connection string with sslmode=require.
// Example:
// export DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DB?sslmode=require"

const connectionString = process.env.DATABASE_URL;
const applicationName = resolvePgApplicationName();

if (!connectionString) {
  console.error("[DB] ERROR: DATABASE_URL is missing. Set it before running the server.");
  process.exit(1);
}

export const pool = new Pool({
  connectionString,
  application_name: applicationName,
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
  max: Math.max(2, Number(process.env.PG_POOL_MAX || "12")),
  idleTimeoutMillis: Math.max(1000, Number(process.env.PG_IDLE_TIMEOUT_MS || "10000")),
  connectionTimeoutMillis: Math.max(
    250,
    Number(process.env.PG_CONNECTION_TIMEOUT_MS || "1200")
  ),
  query_timeout: Math.max(200, Number(process.env.PG_QUERY_TIMEOUT_MS || "4500")),
  statement_timeout: Math.max(
    200,
    Number(process.env.PG_STATEMENT_TIMEOUT_MS || "4500")
  ),
});

if (process.env.DEBUG_DB_CONNECT === "1") {
  console.log(`[DB] Pool configured (application_name=${applicationName})`);
  pool.on("connect", () => {
    console.log(`[DB] Connected to Neon PostgreSQL (application_name=${applicationName})`);
  });
}
