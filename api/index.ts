/*
 * Guest list API (Neon Function).
 * Every route requires a Neon Auth JWT; all queries are scoped to the token's `sub`,
 * so one account can never read or change another account's households.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Pool } from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { attachDatabasePool } from "@neon/functions";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

const jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL!));
const issuer = new URL(process.env.NEON_AUTH_BASE_URL!).origin;

type Env = { Variables: { userId: string } };
const app = new Hono<Env>();

// Auth is a bearer token, not a cookie, so any origin may call the API.
app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] }));

app.get("/", (c) => c.json({ ok: true }));

app.use("/api/*", async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return c.json({ error: "Unauthorized" }, 401);
  try {
    const { payload } = await jwtVerify(header.slice(7), jwks, { issuer });
    if (!payload.sub) return c.json({ error: "Unauthorized" }, 401);
    c.set("userId", payload.sub);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

// ---------- Validation ----------
const SIDES = new Set(["Bride", "Groom", "Both"]);
const RSVPS = new Set(["pending", "attending", "declined"]);
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

type Guest = { name: string; type: "adult" | "child"; rsvp: string };

function parseHousehold(body: any) {
  const guests: Guest[] = (Array.isArray(body?.guests) ? body.guests : [])
    .slice(0, 50)
    .map((g: any) => ({
      name: str(g?.name, 120),
      type: g?.type === "child" ? "child" : "adult",
      rsvp: RSVPS.has(g?.rsvp) ? g.rsvp : "pending",
    }))
    .filter((g: Guest) => g.name);
  const priority = Number(body?.priority);
  const household = {
    name: str(body?.name, 200),
    priority: priority >= 1 && priority <= 4 ? Math.trunc(priority) : 1,
    side: SIDES.has(body?.side) ? body.side : "Bride",
    group: str(body?.group, 100),
    email: str(body?.email, 200),
    phone: str(body?.phone, 50),
    address: str(body?.address, 1000),
    notes: str(body?.notes, 2000),
    inviteSent: body?.inviteSent === true,
    guests,
  };
  if (!household.name) return { error: "Household name is required." };
  if (!guests.length) return { error: "Add at least one guest with a name." };
  return { household };
}

const COLUMNS = `id, name, priority, side, group_name AS "group", email, phone, address, notes,
  invite_sent AS "inviteSent", guests`;

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

// ---------- Profile ----------
app.get("/api/profile", async (c) => {
  const { rows } = await pool.query(
    `SELECT couple, to_char(wedding_date, 'YYYY-MM-DD') AS date FROM profiles WHERE user_id = $1`,
    [c.get("userId")]
  );
  return c.json(rows[0] ?? { couple: "", date: "" });
});

app.put("/api/profile", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body?.date) ? body.date : null;
  await pool.query(
    `INSERT INTO profiles (user_id, couple, wedding_date) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET couple = EXCLUDED.couple, wedding_date = EXCLUDED.wedding_date, updated_at = now()`,
    [c.get("userId"), str(body?.couple, 200), date]
  );
  return c.json({ ok: true });
});

// ---------- Households ----------
app.get("/api/households", async (c) => {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM households WHERE user_id = $1 ORDER BY priority, name`,
    [c.get("userId")]
  );
  return c.json(rows);
});

app.post("/api/households", async (c) => {
  const parsed = parseHousehold(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const h = parsed.household;
  const { rows } = await pool.query(
    `INSERT INTO households (user_id, name, priority, side, group_name, email, phone, address, notes, invite_sent, guests)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
    [c.get("userId"), h.name, h.priority, h.side, h.group, h.email, h.phone, h.address, h.notes, h.inviteSent, JSON.stringify(h.guests)]
  );
  return c.json(rows[0], 201);
});

app.put("/api/households/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "Not found" }, 404);
  const parsed = parseHousehold(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const h = parsed.household;
  const { rows } = await pool.query(
    `UPDATE households SET name = $3, priority = $4, side = $5, group_name = $6, email = $7, phone = $8, address = $9,
       notes = $10, invite_sent = $11, guests = $12, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
    [id, c.get("userId"), h.name, h.priority, h.side, h.group, h.email, h.phone, h.address, h.notes, h.inviteSent, JSON.stringify(h.guests)]
  );
  return rows[0] ? c.json(rows[0]) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/households/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "Not found" }, 404);
  const { rowCount } = await pool.query(`DELETE FROM households WHERE id = $1 AND user_id = $2`, [id, c.get("userId")]);
  return rowCount ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

export default app;
