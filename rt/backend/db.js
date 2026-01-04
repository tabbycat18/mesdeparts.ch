// backend/db.js
import pg from "pg";

const { Pool } = pg;

// Neon requires a full connection string with sslmode=require.
// Example:
// export DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DB?sslmode=require"

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("[DB] ERROR: DATABASE_URL is missing. Set it before running the server.");
  process.exit(1);
}

export const pool = new Pool({
  connectionString,
  ssl: {
    require: true,
    rejectUnauthorized: false,
  },
});

// Optional: log when connected
pool.on("connect", () => {
  console.log("[DB] Connected to Neon PostgreSQL");
});