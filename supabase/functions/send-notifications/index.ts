// QCU ITSO — notification email dispatcher
// Picks up pending notifications_log rows, sends them via Gmail SMTP or Resend,
// and stamps delivery_status so the row doubles as the email audit trail.
// Called on a schedule by pg_cron (see below) or manually with:
//   curl -X POST <fn-url> -H "x-cron-secret: <CRON_SECRET>"
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
// Gmail mode: set GMAIL_USER + GMAIL_APP_PASSWORD to send through a Gmail account
// (no domain needed). Otherwise emails go through Resend.
const GMAIL_USER = Deno.env.get("GMAIL_USER")?.trim();
const GMAIL_PASS = Deno.env.get("GMAIL_APP_PASSWORD")?.replace(/\s/g, "");
const FROM = Deno.env.get("EMAIL_FROM") ??
  (GMAIL_USER ? `QCU ITSO <${GMAIL_USER}>` : "QCU ITSO <onboarding@resend.dev>");
// Test mode: until a domain is verified in Resend, set EMAIL_TEST_RECIPIENT to your
// Resend signup email — every email is redirected there, tagged with the real recipient.
const TEST_TO = Deno.env.get("EMAIL_TEST_RECIPIENT")?.trim();

type Row = { id: string; recipient: string; type: string; payload: Record<string, any> };

const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function emailFor(row: Row): { subject: string; html: string } {
  const p = row.payload ?? {};
  const ref = p.reference ? ` (${p.reference})` : "";
  const co = !!p.coauthor;
  const intro = co ? `<p>You're listed as a co-author on <b>${p.title}</b>${ref}, submitted to the QCU Innovation and Technology Support Office.</p>` : "";
  const open = co ? "" : `<p><a href="${Deno.env.get("SITE_URL") ?? "http://localhost:5173"}">Open the ITSO workspace</a></p>`;
  const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
  const header = `<div style="margin-bottom:14px">${siteUrl ? `<img src="${siteUrl}/brand/qcu-logo.png" alt="" width="42" height="42" style="vertical-align:middle;border-radius:50%">` : ""}<span style="display:inline-block;vertical-align:middle;margin-left:10px"><b style="font-size:15px">Quezon City University</b><br><span style="font-size:12px;color:#666">Innovation and Technology Support Office</span></span></div>`;
  const wrap = (body: string) => `<div style="font-family:Arial,sans-serif;color:#1a1a1a;line-height:1.5">${header}<p>Hello,</p>${body}${open}<p style="color:#666;font-size:12px">Quezon City University · Innovation and Technology Support Office</p></div>`;
  const fmtDate = (d: any) => d ? new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
  switch (row.type) {
    case "new_submission": return { subject: `New submission: ${p.title}`, html: wrap(`<p>A new filing was submitted${ref}: <b>${esc(p.title)}</b>.</p>`) };
    case "status_change": return { subject: `Status update${ref}: ${p.new}`, html: wrap(co ? `${intro}<p>The submission moved from <b>${esc(p.old)}</b> to <b>${esc(p.new)}</b>.</p>` : `<p>Your submission <b>${esc(p.title)}</b>${ref} moved from <b>${esc(p.old)}</b> to <b>${esc(p.new)}</b>.</p>`) };
    case "remark": return { subject: co ? `New remark on a submission you co-authored${ref}` : `New remark on your submission${ref}`, html: wrap(co ? `${intro}<p>ITSO left a comment on the submission:</p><blockquote style="border-left:3px solid #FD7201;padding-left:12px;color:#444">${esc(p.text)}</blockquote>` : `<p>ITSO left a comment on <b>${esc(p.title)}</b>:</p><blockquote style="border-left:3px solid #FD7201;padding-left:12px;color:#444">${esc(p.text)}</blockquote>`) };
    case "certificate": return { subject: `Certificate issued${ref}`, html: wrap(co ? `${intro}<p>A certificate was issued for this submission. The submitting author can view and download it.</p>` : `<p>Congratulations — a certificate was issued for <b>${esc(p.title)}</b>${ref}. Sign in to view or download it.</p>`) };
    case "ser_started": return { subject: `Filed with IPOPHIL${ref}: SER due ${fmtDate(p.deadline)}`, html: wrap(row.recipient === "admin" ? `<p><b>${esc(p.title)}</b>${ref} was filed with IPOPHIL on <b>${fmtDate(p.filing_date)}</b>; the SER deadline is <b>${fmtDate(p.deadline)}</b>.</p>` : co ? `${intro}<p>${p.updated ? "Its date of filing was updated — the" : "It was filed with IPOPHIL on " + fmtDate(p.filing_date) + " and the"} Substantive Examination Request deadline is <b>${fmtDate(p.deadline)}</b> (18 months from filing).</p>` : `<p>Your submission <b>${esc(p.title)}</b>${ref} ${p.updated ? "had its date of filing updated — the" : "was filed with IPOPHIL on <b>" + fmtDate(p.filing_date) + "</b>. The"} Substantive Examination Request deadline is <b>${fmtDate(p.deadline)}</b> (18 months from filing).</p>`) };
    case "formality_defect": return { subject: `Action needed${ref}: ${p.label ?? `formality defect (round ${p.round})`}`, html: wrap(`${co ? intro : ""}<table style="border-collapse:collapse;font-size:13px">${[["Defect", p.label ?? `Round ${p.round}`], ["Notice date", fmtDate(p.notice_date)], ["Deadline", `${fmtDate(p.deadline)} (60 days from notice)`]].map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#666">${k}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table>${p.details ? `<blockquote style="border-left:3px solid #FD7201;padding-left:12px;color:#444">${esc(p.details)}</blockquote>` : ""}${co ? "<p>The submitting author needs to address it before the deadline.</p>" : `<p>Please address it before <b>${fmtDate(p.deadline)}</b>.</p>`}`) };
    case "ser_reminder": return { subject: `SER deadline ${p.overdue ? "overdue" : "approaching"}${ref}`, html: wrap(`${co ? intro : ""}<p>The Substantive Examination Request for ${row.recipient === "admin" || co ? `<b>${esc(p.title)}</b>${ref}` : `your submission <b>${esc(p.title)}</b>${ref}`} is ${p.overdue ? "past its deadline" : "due on " + fmtDate(p.deadline)}.${row.recipient === "admin" ? " Please mark it handled in the system." : ""}</p>`) };
    case "defect_reminder": return { subject: `Defect deadline ${p.overdue ? "overdue" : "approaching"}${ref}`, html: wrap(`${co ? intro : ""}<p>${esc(p.label ?? `Formality defect round ${p.round}`)} on ${row.recipient === "admin" || co ? `<b>${esc(p.title)}</b>${ref}` : `your submission <b>${esc(p.title)}</b>${ref}`} is ${p.overdue ? `overdue (deadline was ${fmtDate(p.deadline)})` : `due on ${fmtDate(p.deadline)}${p.days_left != null ? ` — ${p.days_left} day${p.days_left === 1 ? "" : "s"} left` : ""}`}.</p>`) };
    case "registration_received": return { subject: `Registration received: ${p.event}`, html: wrap(`<p>Your registration for <b>${esc(p.event)}</b> was received and is pending approval.</p>`) };
    case "registration_approved": return { subject: `Registration approved: ${p.event}`, html: wrap(`<p>Your registration for <b>${esc(p.event)}</b> was approved. See you there!</p>`) };
    case "registration_declined": return { subject: `Registration update: ${p.event}`, html: wrap(`<p>Your registration for <b>${esc(p.event)}</b> was declined.</p>`) };
    case "registration_request": return { subject: `Registration request: ${p.event}`, html: wrap(`<p><b>${esc(p.student)}</b> requested to join <b>${esc(p.event)}</b>. Approve or decline it in the workspace.</p>`) };
    case "new_event": return { subject: `New ITSO event: ${p.event}`, html: wrap(`<p>A new event was posted: <b>${esc(p.event)}</b>${p.date ? " on " + fmtDate(p.date) : ""}${p.mode ? " (" + p.mode + ")" : ""}. Register from the Events page.</p>`) };
    case "broken_link": return { subject: `Drive link needs attention${ref}`, html: wrap(`<p>The Google Drive folder for <b>${esc(p.title)}</b>${ref} was reported as inaccessible${p.note ? `: ${esc(p.note)}` : "."}</p>`) };
    case "drive_link_updated": return { subject: `Drive link updated${ref}`, html: wrap(`<p>The Drive folder link for <b>${esc(p.title)}</b>${ref} was updated.</p>`) };
    default: return { subject: `ITSO update${ref}`, html: wrap(`<p>There's a new update on ${p.title ? `<b>${esc(p.title)}</b>` : "your workspace"}${ref}.</p>`) };
  }
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  const { data: rows, error } = await supabase.rpc("claim_pending_notifications", { p_limit: 50 });
  if (error) return new Response(error.message, { status: 500 });
  if (!rows?.length) return Response.json({ sent: 0 });

  const { data: adminRows } = await supabase
    .from("authorized_emails")
    .select("email")
    .in("role", ["admin", "super_admin"])
    .eq("status", "active");
  const admins = (adminRows ?? []).map((r: { email: string }) => r.email);

  const smtp = GMAIL_USER && GMAIL_PASS
    ? new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER, password: GMAIL_PASS } } })
    : null;

  // Returns "sent" or a failed_* status string
  const deliver = async (to: string[], subject: string, html: string): Promise<string> => {
    if (smtp) {
      try {
        await smtp.send({ from: FROM, to, subject, html });
        return "sent";
      } catch (e) {
        console.error("[smtp]", e);
        return "failed_smtp";
      }
    }
    if (!RESEND_KEY) return "failed_no_provider";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!res.ok) console.error("[resend]", res.status, await res.text());
    return res.ok ? "sent" : `failed_${res.status}`;
  };

  let sent = 0;
  const results: Record<string, string> = {};
  for (const row of rows as Row[]) {
    const to = row.recipient === "admin" ? admins : [row.recipient];
    let status = "skipped";
    if (to.length) {
      const { subject, html } = emailFor(row);
      status = TEST_TO
        ? await deliver([TEST_TO], `[to: ${to.join(", ")}] ${subject}`, html)
        : await deliver(to, subject, html);
    }
    await supabase.from("notifications_log").update({ delivery_status: status }).eq("id", row.id);
    if (status === "sent") sent++; else results[row.id] = status;
  }
  if (smtp) await smtp.close();
  return Response.json({ sent, failed: results, provider: smtp ? "gmail" : "resend" });
});
