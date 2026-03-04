export async function dbUpsertPushSub(db, { recipient, endpoint, p256dh, auth, userAgent }) {
  const q = await db.query(
    `insert into push_subscriptions (recipient, endpoint, p256dh, auth, user_agent, last_seen_at)
     values ($1::text, $2::text, $3::text, $4::text, $5::text, now())
     on conflict (endpoint) do update
       set recipient = excluded.recipient,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           user_agent = excluded.user_agent,
           last_seen_at = now()
     returning id, recipient, endpoint, p256dh, auth, user_agent, created_at, last_seen_at`,
    [recipient, endpoint, p256dh, auth, userAgent || null]
  );
  return q.rows?.[0] || null;
}

export async function dbListPushSubs(db, recipient = "ceo") {
  const q = await db.query(
    `select recipient, endpoint, p256dh, auth
     from push_subscriptions
     where recipient = $1::text
     order by created_at desc
     limit 30`,
    [recipient]
  );
  return q.rows || [];
}

export async function dbDeletePushSub(db, endpoint) {
  try {
    await db.query(`delete from push_subscriptions where endpoint = $1::text`, [endpoint]);
  } catch {}
}