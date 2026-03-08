import { isUuid } from "../../utils/http.js";
import { fixText } from "../../utils/textFix.js";
import { writeAudit } from "../../utils/auditLog.js";
import {
  normalizeLead,
  normalizeThread,
  s,
} from "./inbox.shared.js";

function pickDb(db, client) {
  return client || db;
}

export async function persistLeadActions({ db, client = null, wsHub, tenantKey, actions }) {
  const q = pickDb(db, client);
  const list = Array.isArray(actions) ? actions : [];
  const persisted = [];

  for (const action of list) {
    const type = s(action?.type).toLowerCase();
    if (type !== "create_lead") continue;

    const lead = action?.lead && typeof action.lead === "object" ? action.lead : {};
    const meta = action?.meta && typeof action.meta === "object" ? action.meta : {};

    const source = fixText(s(lead?.source || "meta")) || "meta";
    const sourceRef = fixText(s(lead?.sourceRef || lead?.externalUserId || "")) || null;

    const inboxThreadId = s(lead?.threadId || action?.threadId || meta?.threadId || "") || null;
    const proposalId = s(lead?.proposalId || "") || null;

    const fullName = fixText(s(lead?.fullName || lead?.name || "")) || null;
    const username = fixText(s(lead?.username || "")) || null;
    const company = fixText(s(lead?.company || "")) || null;
    const phone = fixText(s(lead?.phone || "")) || null;
    const email = fixText(s(lead?.email || "")) || null;
    const interest = fixText(s(lead?.intent || meta?.intent || "")) || null;
    const notes = fixText(s(lead?.summary || lead?.notes || "")) || "";

    const stage = fixText(s(lead?.stage || "new")).toLowerCase() || "new";
    const score = Number.isFinite(Number(meta?.score))
      ? Number(meta.score)
      : Number.isFinite(Number(lead?.score))
        ? Number(lead.score)
        : 0;
    const status = fixText(s(lead?.status || "open")).toLowerCase() || "open";

    const extra = {
      ...(lead?.extra && typeof lead.extra === "object" ? lead.extra : {}),
      actionMeta: meta,
      channel: s(action?.channel || lead?.channel || ""),
      externalUserId: s(lead?.externalUserId || action?.externalUserId || ""),
    };

    if (!inboxThreadId || !isUuid(inboxThreadId)) continue;
    if (proposalId && !isUuid(proposalId)) continue;

    const found = await q.query(
      `
      select
        id,
        tenant_key,
        source,
        source_ref,
        inbox_thread_id,
        proposal_id,
        full_name,
        username,
        company,
        phone,
        email,
        interest,
        notes,
        stage,
        score,
        status,
        extra,
        created_at,
        updated_at
      from leads
      where tenant_key = $1::text
        and inbox_thread_id = $2::uuid
        and status <> 'closed'
      order by updated_at desc, created_at desc
      limit 1
      `,
      [tenantKey, inboxThreadId]
    );

    const existing = found.rows?.[0] || null;

    if (existing) {
      const updated = await q.query(
        `
        update leads
        set
          source_ref = coalesce($2::text, source_ref),
          proposal_id = coalesce($3::uuid, proposal_id),
          full_name = coalesce(nullif($4::text, ''), full_name),
          username = coalesce(nullif($5::text, ''), username),
          company = coalesce(nullif($6::text, ''), company),
          phone = coalesce(nullif($7::text, ''), phone),
          email = coalesce(nullif($8::text, ''), email),
          interest = coalesce(nullif($9::text, ''), interest),
          notes = case
            when nullif($10::text, '') is null then notes
            when coalesce(notes, '') = '' then $10::text
            else concat(notes, E'\n\n', $10::text)
          end,
          stage = coalesce(nullif($11::text, ''), stage),
          score = greatest(coalesce(score, 0), $12::int),
          status = coalesce(nullif($13::text, ''), status),
          extra = coalesce(extra, '{}'::jsonb) || $14::jsonb,
          updated_at = now()
        where id = $1::uuid
        returning
          id,
          tenant_key,
          source,
          source_ref,
          inbox_thread_id,
          proposal_id,
          full_name,
          username,
          company,
          phone,
          email,
          interest,
          notes,
          stage,
          score,
          status,
          extra,
          created_at,
          updated_at
        `,
        [
          existing.id,
          sourceRef,
          proposalId || null,
          fullName || "",
          username || "",
          company || "",
          phone || "",
          email || "",
          interest || "",
          notes || "",
          stage || "",
          score,
          status || "",
          JSON.stringify(extra),
        ]
      );

      const savedLead = normalizeLead(updated.rows?.[0] || null);

      try {
        wsHub?.broadcast?.("lead.updated", {
          type: "lead.updated",
          lead: savedLead,
        });
      } catch {}

      try {
        await writeAudit(q, {
          actor: "ai_hq",
          action: "lead.updated",
          objectType: "lead",
          objectId: String(savedLead?.id || ""),
          meta: {
            tenantKey,
            inboxThreadId,
            source,
            score,
            status,
            stage,
          },
        });
      } catch {}

      persisted.push({
        mode: "updated",
        lead: savedLead,
      });

      continue;
    }

    const inserted = await q.query(
      `
      insert into leads (
        tenant_key,
        source,
        source_ref,
        inbox_thread_id,
        proposal_id,
        full_name,
        username,
        company,
        phone,
        email,
        interest,
        notes,
        stage,
        score,
        status,
        extra
      )
      values (
        $1::text,
        $2::text,
        $3::text,
        $4::uuid,
        $5::uuid,
        $6::text,
        $7::text,
        $8::text,
        $9::text,
        $10::text,
        $11::text,
        $12::text,
        $13::text,
        $14::int,
        $15::text,
        $16::jsonb
      )
      returning
        id,
        tenant_key,
        source,
        source_ref,
        inbox_thread_id,
        proposal_id,
        full_name,
        username,
        company,
        phone,
        email,
        interest,
        notes,
        stage,
        score,
        status,
        extra,
        created_at,
        updated_at
      `,
      [
        tenantKey,
        source,
        sourceRef,
        inboxThreadId,
        proposalId,
        fullName,
        username,
        company,
        phone,
        email,
        interest,
        notes,
        stage,
        score,
        status,
        JSON.stringify(extra),
      ]
    );

    const savedLead = normalizeLead(inserted.rows?.[0] || null);

    try {
      wsHub?.broadcast?.("lead.created", {
        type: "lead.created",
        lead: savedLead,
      });
    } catch {}

    try {
      await writeAudit(q, {
        actor: "ai_hq",
        action: "lead.created",
        objectType: "lead",
        objectId: String(savedLead?.id || ""),
        meta: {
          tenantKey,
          inboxThreadId,
          source,
          score,
          status,
          stage,
        },
      });
    } catch {}

    persisted.push({
      mode: "created",
      lead: savedLead,
    });
  }

  return persisted;
}

export async function applyHandoffActions({ db, client = null, wsHub, threadId, actions }) {
  const q = pickDb(db, client);
  const list = Array.isArray(actions) ? actions : [];
  const handoffs = list.filter((x) => s(x?.type).toLowerCase() === "handoff");
  if (!handoffs.length || !threadId || !isUuid(threadId)) return [];

  const results = [];

  for (const action of handoffs) {
    const reason = s(action?.reason || "manual_review");
    const priority = s(action?.priority || "normal").toLowerCase() || "normal";
    const meta = action?.meta && typeof action.meta === "object" ? action.meta : {};
    const actor = fixText(s(meta?.actor || meta?.handoffBy || "ai_hq")) || "ai_hq";

    const updated = await q.query(
      `
      update inbox_threads
      set
        status = 'open',
        assigned_to = case
          when assigned_to is null or assigned_to = '' then 'human_handoff'
          else assigned_to
        end,
        labels = (
          select jsonb_agg(distinct v)
          from jsonb_array_elements_text(
            coalesce(labels, '[]'::jsonb) || to_jsonb(array['handoff', $2::text]::text[])
          ) as t(v)
        ),
        handoff_active = true,
        handoff_reason = $3::text,
        handoff_priority = $2::text,
        handoff_at = now(),
        handoff_by = $4::text,
        meta = coalesce(meta, '{}'::jsonb) || $5::jsonb,
        updated_at = now()
      where id = $1::uuid
      returning
        id,
        tenant_key,
        channel,
        external_thread_id,
        external_user_id,
        external_username,
        customer_name,
        status,
        last_message_at,
        last_inbound_at,
        last_outbound_at,
        unread_count,
        assigned_to,
        labels,
        meta,
        handoff_active,
        handoff_reason,
        handoff_priority,
        handoff_at,
        handoff_by,
        created_at,
        updated_at
      `,
      [
        threadId,
        priority,
        reason,
        actor,
        JSON.stringify({
          handoff: {
            active: true,
            reason,
            priority,
            at: new Date().toISOString(),
            by: actor,
            meta,
          },
        }),
      ]
    );

    const thread = normalizeThread(updated.rows?.[0] || null);

    if (thread) {
      try {
        wsHub?.broadcast?.("inbox.thread.updated", {
          type: "inbox.thread.updated",
          thread,
        });
      } catch {}

      try {
        await writeAudit(q, {
          actor: "ai_hq",
          action: "inbox.handoff.applied",
          objectType: "inbox_thread",
          objectId: String(thread?.id || ""),
          meta: {
            reason,
            priority,
          },
        });
      } catch {}
    }

    results.push({
      reason,
      priority,
      thread,
    });
  }

  return results;
}