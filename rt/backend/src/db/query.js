import { pool } from "../../db.js";

export async function query(sql, params = []) {
  return pool.query(sql, params);
}

export const db = { query };
