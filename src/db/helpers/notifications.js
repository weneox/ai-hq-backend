import { deepFix, fixText } from "../../utils/textFix.js";

export async function dbCreateNotification(db, { recipient="ceo", type="info", title="", body="", payload={} }) {
  const q = await db.query(
    `insert into notifications (recipient, type, title, body, payload)
     values ($1::text, $2::text, $3::text, $4::text, $5::jsonb)
     returning id, recipient, type, title, body, payload, read_at, created_at`,
    [recipient, type, fixText(title), fixText(body), deepFix(payload)]
  );
  return q.rows?.[0] || null;
}

export async function dbListNotifications(db, { recipient="ceo", unreadOnly=false, limit=50 }) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const where = unreadOnly ? `and read_at is null` : ``;
  const q = await db.query(
    `select id, recipient, type, title, body, payload, read_at, created_at
     from notifications
     where recipient = $1::text ${where}
     order by created_at desc
     limit ${lim}`,
    [recipient]
  );
  return (q.rows || []).map((x) => ({
    ...x,
    title: fixText(x.title),
    body: fixText(x.body),
    payload: deepFix(x.payload),
  }));
}

export async function dbMarkNotificationRead(db, id) {
  const q = await db.query(
    `update notifications
     set read_at = coalesce(read_at, now())
     where id = $1::uuid
     returning id, recipient, type, title, body, payload, read_at, created_at`,
    [id]
  );
  const row = q.rows?.[0] || null;
  if (!row) return null;
  return { ...row, title: fixText(row.title), body: fixText(row.body), payload: deepFix(row.payload) };
}