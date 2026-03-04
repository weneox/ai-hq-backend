import { cfg } from "../config.js";
import { deepFix, fixText } from "../utils/textFix.js";
import { isDbReady } from "../utils/http.js";
import { pushSendOne } from "../utils/push.js";
import { mem } from "../utils/memStore.js";
import { dbListPushSubs, dbDeletePushSub } from "../db/helpers/push.js";

export async function pushBroadcastToCeo({ db, title, body, data }) {
  if (!cfg.PUSH_ENABLED) return;

  const payload = {
    title: fixText(title || "AI HQ"),
    body: fixText(body || ""),
    data: deepFix(data || {}),
  };

  if (isDbReady(db)) {
    const subs = await dbListPushSubs(db, "ceo");
    for (const s of subs) {
      try {
        const r = await pushSendOne(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload
        );
        if (!r.ok && r.expired) await dbDeletePushSub(db, s.endpoint);
      } catch {}
    }
    return;
  }

  for (const s of mem.pushSubs.values()) {
    if (s.recipient !== "ceo") continue;
    try {
      const r = await pushSendOne(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      if (!r.ok && r.expired) mem.pushSubs.delete(s.endpoint);
    } catch {}
  }
}