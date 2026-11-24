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
  const isAdmin = row.recipient === "admin";
  const intro = co ? `<p>You're listed as a co-author on <b>${esc(p.title)}</b>${ref}, submitted to the QCU Innovation and Technology Support Office.</p>` : "";
  const open = co ? "" : `<p><a href="${Deno.env.get("SITE_URL") ?? "http://localhost:5173"}">Open the ITSO workspace</a></p>`;
  const siteUrl = (Deno.env.get("SITE_URL") ?? "").replace(/\/+$/, "");
  const header = `<div style="margin-bottom:14px">${siteUrl ? `<img src="${siteUrl}/brand/qcu-logo.png" alt="" width="42" height="42" style="vertical-align:middle;border-radius:50%">` : ""}<span style="display:inline-block;vertical-align:middle;margin-left:10px"><b style="font-size:15px">Quezon City University</b><br><span style="font-size:12px;color:#666">Innovation and Technology Support Office</span></span></div>`;
  const fmtDate = (d: any) => d ? new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";
  const t60 = (s: any) => { const t = String(s ?? ""); return t.length > 60 ? `${t.slice(0, 57)}…` : t; };
  const typeApp = () => `${String(p.type ?? "IP").toLowerCase()} application`;
  const appDesc = co ? `the ${typeApp()} you co-authored` : isAdmin ? `the ${typeApp()}` : `your ${typeApp()}`;
  const r = (k: string, v: any) => v != null && v !== "" ? `<tr><td style="padding:3px 14px 3px 0;color:#666;vertical-align:top">${k}</td><td><b>${esc(v)}</b></td></tr>` : "";
  const subTable = (extra = "") => `<table style="border-collapse:collapse;font-size:13px">${r("Title", p.title)}${r("Reference no.", p.reference)}${r("Filing type", p.type)}${r("Applicant", [p.student, p.student_id].filter(Boolean).join(" · "))}${r("Authors", p.authors)}${r("College", p.college)}${r("Program", p.program)}${r("Current status", p.status)}${r("Date submitted", fmtDate(p.submitted))}${r("Date of filing", fmtDate(p.filing_date))}${r("SER deadline", fmtDate(p.ser_deadline))}${extra}</table>`;
  const duration = [p.duration_days && p.duration_days !== 1 ? `${p.duration_days} days` : "", p.duration_hours ? `${p.duration_hours} hour${p.duration_hours === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const eventTable = (extra = "") => `<table style="border-collapse:collapse;font-size:13px">${extra}${r("Event", p.event)}${r("Activity type", p.activity_other || p.activity_type)}${r("Date", fmtDate(p.date))}${r("Mode", p.mode)}${r("Duration", duration)}</table>`;
  const quote = (text: any) => `<blockquote style="border-left:3px solid #FD7201;padding-left:12px;color:#444">${esc(text)}</blockquote>`;
  const wrap = (body: string, closing = "Thank you!") => `<div style="font-family:Arial,sans-serif;color:#1a1a1a;line-height:1.5">${header}<p>Good day!</p>${body}<p>${closing}</p>${open}<p style="color:#666;font-size:12px">Quezon City University · Innovation and Technology Support Office</p></div>`;
  const statusLine = () => {
    switch (p.new) {
      case "Under Review": return "is now under review by ITSO";
      case "Submitted to IPOPHIL": return `has been filed with IPOPHL${p.filing_date ? ` on ${fmtDate(p.filing_date)}` : ""}`;
      case "Revisions Needed": return "requires revisions before it can proceed";
      case "Passed": return "has been marked as Passed by IPOPHL";
      case "Received eSOA": return "— IPOPHL has issued the electronic Statement of Account (eSOA) for it";
      case "Paid": return "— its payment has been recorded by IPOPHL";
      case "Approved with Certificate": return "has been approved by IPOPHL";
      case "Withdrawn": return "has been withdrawn";
      case "Disapproved": return "was not approved by IPOPHL";
      default: return `moved from <b>${esc(p.old)}</b> to <b>${esc(p.new)}</b>`;
    }
  };
  const statusNext = () => {
    switch (p.new) {
      case "Submitted to IPOPHIL": return `<p>The Substantive Examination Request deadline is <b>${fmtDate(p.ser_deadline || p.deadline)}</b> (18 months from the date of filing).</p>`;
      case "Revisions Needed": return `<p>${co ? "The submitting author needs to" : "Kindly"} revise the submission based on the remarks below.</p>${p.remark ? quote(p.remark) : ""}`;
      case "Received eSOA": return co ? "" : `<p>Kindly coordinate with ITSO regarding payment.</p>`;
      case "Approved with Certificate": return `<p>The e-Certificate will be ${co ? "shared with the submitting author" : "sent to you"} once available.</p>`;
      case "Disapproved": return `<p>Kindly reach out to ITSO if you would like assistance with a possible re-filing.</p>`;
      default: return "";
    }
  };
  switch (row.type) {
    case "submission_received": return { subject: `Submission received${ref}: "${t60(p.title)}"`, html: wrap(`${intro}<p>We have received ${appDesc} entitled "${esc(p.title)}".</p>${subTable()}<p>Kindly wait while ITSO reviews ${co ? "the" : "your"} submission; we will notify you of any updates.</p>`) };
    case "new_submission": return { subject: `New submission${ref}: "${t60(p.title)}"`, html: wrap(`<p>A new ${typeApp()} entitled "${esc(p.title)}" was submitted by <b>${esc(p.student)}</b>.</p>${subTable()}<p>Kindly review it in the ITSO workspace.</p>`) };
    case "status_change": return { subject: `${p.new === "Approved with Certificate" ? "Approved by IPOPHL" : p.new}${ref}: "${t60(p.title)}"`, html: wrap(`${intro}<p>We would like to inform you that ${appDesc} entitled "${esc(p.title)}" ${statusLine()}.</p>${subTable(r("Status change", `${p.old ?? ""} → ${p.new ?? ""}`))}${statusNext()}${isAdmin ? "<p>Kindly review it in the ITSO workspace.</p>" : ""}`, p.new === "Approved with Certificate" ? "Thank you, and congratulations!" : "Thank you!") };
    case "remark": return { subject: `New remark on ${isAdmin || co ? appDesc : `your ${typeApp()}`}${ref}`, html: wrap(`${intro}<p>ITSO left a remark on ${appDesc} entitled "${esc(p.title)}":</p>${subTable()}${quote(p.text)}<p>${co ? "The submitting author can" : "Kindly"} review the remark and update the submission if needed.</p>`) };
    case "certificate": return { subject: `Approved by IPOPHL${ref}: "${t60(p.title)}"`, html: wrap(`${intro}<p>We are pleased to inform you that ${appDesc} has been approved by IPOPHL.</p>${subTable(r("Date issued", fmtDate(p.date_issued)))}${co ? `<p>The submitting author can view and download the e-Certificate for the application entitled "${esc(p.title)}"${p.certificate_link ? " using the link below." : "."}</p>` : `<p>You may view and download the e-Certificate for your ${typeApp()} entitled "${esc(p.title)}"${p.certificate_link ? " using the link below." : " in the ITSO workspace."}</p>`}${p.certificate_link ? `<p><a href="${esc(p.certificate_link)}">Download the e-Certificate</a></p>` : ""}`, "Thank you, and congratulations!") };
    case "ser_started": return { subject: `Filed with IPOPHL${ref}: SER due ${fmtDate(p.ser_deadline || p.deadline)}`, html: wrap(`${intro}<p>${isAdmin ? `The ${typeApp()}` : co ? `The ${typeApp()} you co-authored` : `Your ${typeApp()}`} entitled "${esc(p.title)}" ${p.updated ? "had its date of filing updated" : `was filed with IPOPHL on <b>${fmtDate(p.filing_date)}</b>`}.</p>${subTable()}<p>The Substantive Examination Request deadline is <b>${fmtDate(p.ser_deadline || p.deadline)}</b> (18 months from the date of filing).</p>`) };
    case "formality_defect": return { subject: `Action needed${ref}: ${p.label ?? `formality defect (round ${p.round})`}`, html: wrap(`${intro}<p>A <b>${esc(p.label ?? `formality defect (round ${p.round})`)}</b> notice was logged on ${appDesc} entitled "${esc(p.title)}".</p>${subTable(r("Defect", p.label ?? `Round ${p.round}`) + r("Notice date", fmtDate(p.notice_date)) + r("Deadline", `${fmtDate(p.deadline)} (60 days from notice)`))}${p.details ? quote(p.details) : ""}<p>${co ? "The submitting author needs to" : "Kindly"} address it before <b>${fmtDate(p.deadline)}</b>.</p>`) };
    case "ser_reminder": return { subject: `SER deadline ${p.overdue ? "overdue" : "approaching"}${ref}: "${t60(p.title)}"`, html: wrap(`${intro}<p>The Substantive Examination Request for ${appDesc} entitled "${esc(p.title)}" is ${p.overdue ? `past its deadline (${fmtDate(p.deadline)})` : `due on <b>${fmtDate(p.deadline)}</b>`}.</p>${subTable()}${isAdmin ? "<p>Kindly mark it handled in the ITSO workspace.</p>" : ""}`) };
    case "defect_reminder": return { subject: `Defect deadline ${p.overdue ? "overdue" : "approaching"}${ref}: "${t60(p.title)}"`, html: wrap(`${intro}<p>The <b>${esc(p.label ?? `formality defect (round ${p.round})`)}</b> on ${appDesc} entitled "${esc(p.title)}" is ${p.overdue ? `overdue (the deadline was ${fmtDate(p.deadline)})` : `due on <b>${fmtDate(p.deadline)}</b>${p.days_left != null ? ` — ${p.days_left} day${p.days_left === 1 ? "" : "s"} left` : ""}`}.</p>${subTable(r("Defect", p.label ?? `Round ${p.round}`) + r("Deadline", fmtDate(p.deadline)))}${isAdmin ? "<p>Kindly follow up in the ITSO workspace.</p>" : co ? "" : "<p>Kindly address it before the deadline.</p>"}`) };
    case "registration_received": return { subject: `Registration received: ${t60(p.event)}`, html: wrap(`<p>We have received your registration for <b>${esc(p.event)}</b>; it is pending approval.</p>${eventTable()}<p>We will notify you once ITSO reviews it.</p>`) };
    case "registration_approved": return { subject: `Registration approved: ${t60(p.event)}`, html: wrap(`<p>We are pleased to inform you that your registration for <b>${esc(p.event)}</b> was approved. See you there!</p>${eventTable()}`, "Thank you, and congratulations!") };
    case "registration_declined": return { subject: `Registration update: ${t60(p.event)}`, html: wrap(`<p>We regret to inform you that your registration for <b>${esc(p.event)}</b> was declined.</p>${eventTable()}<p>Kindly reach out to ITSO if you have any questions.</p>`) };
    case "registration_request": return { subject: `Registration request: ${t60(p.event)}`, html: wrap(`<p><b>${esc(p.student)}</b>${p.student_id ? ` (${esc(p.student_id)})` : ""} requested to join <b>${esc(p.event)}</b>.</p>${eventTable(r("Student", [p.student, p.student_id].filter(Boolean).join(" · ")))}<p>Kindly approve or decline it in the ITSO workspace.</p>`) };
    case "new_event": return { subject: `New ITSO event: ${t60(p.event)}`, html: wrap(`<p>We would like to inform you that a new event was posted: <b>${esc(p.event)}</b>.</p>${eventTable()}<p>Kindly register from the Events page in the ITSO workspace.</p>`) };
    case "broken_link": return { subject: `Drive link needs attention${ref}: "${t60(p.title)}"`, html: wrap(`${intro}<p>${p.by === "ITSO" ? `We were unable to open the Google Drive folder for ${appDesc} entitled "${esc(p.title)}"` : `The Google Drive folder for ${appDesc} entitled "${esc(p.title)}" was reported as inaccessible${p.by && p.by !== "ITSO" ? ` by ${esc(p.by)}` : ""}`}.</p>${subTable()}${p.note ? quote(p.note) : ""}${isAdmin ? "" : co ? "" : "<p>Kindly update the Drive folder link in the ITSO workspace.</p>"}`) };
    case "drive_link_updated": return { subject: `Drive link updated${ref}: "${t60(p.title)}"`, html: wrap(`<p>The Drive folder link for ${appDesc} entitled "${esc(p.title)}" was updated.</p>${subTable()}`) };
    default: return { subject: `ITSO update${ref}`, html: wrap(`<p>There's a new update on ${p.title ? `${appDesc} entitled "${esc(p.title)}"` : "your workspace"}${ref}.</p>${p.title ? subTable() : ""}`) };
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
