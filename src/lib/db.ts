import { supabase } from "./supabase";

/* ---------- shared UI shapes (mirror App.tsx) ---------- */
export type Paper = {
  id: string; dbId?: string; ownerUuid?: string; title: string; studentId: string; student: string; program: string; college: string;
  authors: string[]; type: string; status: string; submitted: string; filed: string; problems: number;
  archived?: boolean; archiveReason?: string; drive?: string;
  authorDetails?: { id?: string; name: string; email: string | null }[];
  linkReport?: { at: string; note?: string; by?: string };
  history: { status: string; at: string; by?: string; atRaw?: string }[];
  filedRaw?: string;
  certificate?: { link?: string; issued: string };
  ser?: { id: string; triggered: string; deadline: string; deadlineRaw: string; status: "open" | "resolved"; note?: string };
};
export type Comment = { text: string; timestamp: string; author: string };
export type Defect = {
  id: string; problemId?: string; submissionId: string; noticeDate: string; deadline: string;
  status: "open" | "resolved"; comments: Comment[];
};
export type Event = {
  id?: string; title: string; type: string; date: string; time: string; mode: string; place: string;
  link?: string; registered: number; icon: string; color: string;
  dateRaw?: string; activityType?: string; activityOther?: string;
  durationDays?: number; durationHours?: number;
  participantsInvolved?: string[]; sector?: string[];
  male?: number; female?: number; total?: number;
  ageRange?: string[]; drive?: string; venue?: string;
};
export type Registration = { id?: string; mine?: boolean; eventTitle: string; student: string; status: "Pending approval" | "Approved" | "Declined" };
export type Account = { name: string; email: string; role: string; status: string; rawRole?: "student" | "admin" | "super_admin" };

export type SessionUser = { email: string; role: "Admin" | "Student" | null; studentUuid: string | null; isSuper: boolean; fullName: string | null; givenName: string | null; middleName: string | null; familyName: string | null; suffix: string | null; profileCompleted: boolean; studentIdNumber: string | null; programId: number | null };

const fmt = (d?: string | null) =>
  d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

const fmtTime = (d?: string | null) =>
  d ? `${fmt(d)} ${new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "—";

const addMonthsIso = (date: string, months: number) => {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(year, month - 1 + months, 1);
  target.setDate(Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
};

/* ---------- auth ---------- */

export async function signInWithGoogle() {
  if (!supabase) return;
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + import.meta.env.BASE_URL },
  });
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** Who is signed in right now? Includes whitelist role + student profile id. */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!supabase) return null;
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) console.error("[ITSO] getSession error:", error.message);
  const email = session?.user?.email?.toLowerCase();
  if (!email) {
    console.warn("[ITSO] no session after OAuth — check redirect URL whitelist / try on localhost:5173 directly");
    return null;
  }
  const { data: role, error: roleErr } = await supabase.rpc("my_role");
  if (roleErr) console.error("[ITSO] my_role RPC failed:", roleErr.message);
  if (!role) return { email, role: null, studentUuid: null, isSuper: false, fullName: null, givenName: null, middleName: null, familyName: null, suffix: null, profileCompleted: true, studentIdNumber: null, programId: null }; // signed in but not whitelisted
  const { data: studentUuid, error: sidErr } = await supabase.rpc("my_student_id");
  if (sidErr) console.error("[ITSO] my_student_id RPC failed:", sidErr.message);
  let profile: { full_name?: string; given_name?: string; middle_name?: string; family_name?: string; suffix?: string; profile_completed?: boolean; student_id_number?: string; program_id?: number } = {};
  const { data: prof, error: profErr } = await supabase.rpc("my_profile");
  if (profErr) console.warn("[ITSO] my_profile RPC failed:", profErr.message);
  else profile = (prof ?? {}) as typeof profile;
  return { email, role: role === "student" ? "Student" : "Admin", studentUuid: studentUuid ?? null, isSuper: role === "super_admin", fullName: profile.full_name ?? null, givenName: profile.given_name ?? null, middleName: profile.middle_name ?? null, familyName: profile.family_name ?? null, suffix: profile.suffix ?? null, profileCompleted: profile.profile_completed !== false, studentIdNumber: profile.student_id_number ?? null, programId: profile.program_id ?? null };
}

/* ---------- load ---------- */

export type Workspace = {
  papers: Paper[]; defects: Defect[]; remarks: Record<string, Comment[]>;
  events: Event[]; registrations: Registration[]; accounts: Account[];
  colleges: string[]; programs: Record<string, string[]>; programById: Record<number, { name: string; college: string }>;
};

export async function loadWorkspace(isAdmin: boolean, studentUuid: string | null): Promise<Workspace> {
  if (!supabase) throw new Error("Supabase not configured");

  const [subs, authors, probs, defs, dcoms, rems, evs, regs, wl, stus, adms, cols, progs, hist, certs] = await Promise.all([
    supabase.from("submissions").select("*, students(full_name), colleges(name), programs(name)").order("date_created", { ascending: false }),
    supabase.from("submission_authors").select("*").order("order_index"),
    supabase.from("problems").select("*"),
    supabase.from("formality_defects").select("*").order("round_number"),
    supabase.from("formality_defect_comments").select("*"),
    supabase.from("remarks").select("*").order("created_at"),
    supabase.from("events").select("*").order("event_date"),
    supabase.from("event_registrations").select("*, students(full_name,email), events(title)"),
    isAdmin ? supabase.from("authorized_emails").select("*") : Promise.resolve({ data: [] }),
    isAdmin ? supabase.from("students").select("email, full_name") : Promise.resolve({ data: [] }),
    isAdmin ? supabase.from("admins").select("email, full_name") : Promise.resolve({ data: [] }),
    supabase.from("colleges").select("*").order("id"),
    supabase.from("programs").select("*").order("id"),
    supabase.from("status_history").select("*").order("created_at", { ascending: true }),
    supabase.from("certificates").select("*"),
  ]);

  for (const [name, res] of Object.entries({
    submissions: subs, authors, problems: probs, defects: defs, defect_comments: dcoms, remarks: rems,
    events: evs, registrations: regs, whitelist: wl, students: stus, admins: adms, colleges: cols, programs: progs,
    status_history: hist, certificates: certs,
  })) {
    const e = (res as { error?: { message?: string; code?: string } }).error;
    if (e) { console.error(`[ITSO] query failed on ${name}:`, e); throw new Error(`${name}: ${e.message ?? e.code}`); }
  }

  const refOf = new Map<string, string>((subs.data ?? []).map((s: { id: string; reference_number: string }) => [s.id, s.reference_number]));
  const uuidOf = new Map<string, string>((subs.data ?? []).map((s: { id: string; reference_number: string }) => [s.reference_number, s.id]));

  const authorsBySub = new Map<string, string[]>();
  const authorDetailsBySub = new Map<string, { id: string; name: string; email: string | null }[]>();
  for (const a of authors.data ?? []) {
    const list = authorsBySub.get(a.submission_id) ?? [];
    list.push(a.author_name);
    authorsBySub.set(a.submission_id, list);
    const rows = authorDetailsBySub.get(a.submission_id) ?? [];
    rows.push({ id: a.id, name: a.author_name, email: a.email ?? null });
    authorDetailsBySub.set(a.submission_id, rows);
  }

  const openProblems = new Map<string, number>();
  for (const p of probs.data ?? []) {
    if (p.status === "open") openProblems.set(p.submission_id, (openProblems.get(p.submission_id) ?? 0) + 1);
  }

  const commentsByDefect = new Map<string, Comment[]>();
  for (const c of dcoms.data ?? []) {
    const list = commentsByDefect.get(c.formality_defect_id) ?? [];
    list.push({ text: c.comment_text, timestamp: fmt(c.created_at), author: c.admin_email ?? "ITSO Admin" });
    commentsByDefect.set(c.formality_defect_id, list);
  }

  const historyBySub = new Map<string, { status: string; at: string; by?: string; atRaw?: string }[]>();
  for (const h of hist.data ?? []) {
    const list = historyBySub.get(h.submission_id) ?? [];
    list.push({ status: h.new_status, at: fmt(h.created_at), by: h.changed_by_email ?? undefined, atRaw: h.created_at });
    historyBySub.set(h.submission_id, list);
  }

  const certBySub = new Map<string, { link?: string; issued: string }>();
  for (const c of certs.data ?? []) {
    certBySub.set(c.submission_id, { link: c.file_reference ?? undefined, issued: fmt(c.date_issued) });
  }

  const serBySub = new Map<string, { raw: string; ser: NonNullable<Paper["ser"]> }>();
  for (const p of probs.data ?? []) {
    if (p.problem_type !== "Substantive Examination Request") continue;
    const raw = String(p.date_triggered);
    const ser = { id: p.id, triggered: fmt(p.date_triggered), deadline: fmt(p.deadline_date), deadlineRaw: p.deadline_date, status: p.status as "open" | "resolved", note: p.resolution_note ?? undefined };
    const prev = serBySub.get(p.submission_id);
    if (!prev || raw >= prev.raw) serBySub.set(p.submission_id, { raw, ser });
  }

  const remarksByRef = new Map<string, Comment[]>();
  for (const r of rems.data ?? []) {
    const ref = refOf.get(r.submission_id);
    if (!ref) continue;
    const list = remarksByRef.get(ref) ?? [];
    list.push({ text: r.comment_text, timestamp: fmt(r.created_at), author: r.admin_email ?? "ITSO Admin" });
    remarksByRef.set(ref, list);
  }

  const approvedRegs = new Map<string, number>();
  for (const r of regs.data ?? []) {
    if (r.status === "approved") approvedRegs.set(r.event_id, (approvedRegs.get(r.event_id) ?? 0) + 1);
  }

  const papers: Paper[] = (subs.data ?? []).map((s) => ({
    id: s.reference_number,
    dbId: s.id,
    ownerUuid: s.student_id,
    title: s.title,
    studentId: s.student_submitted_id_number,
    student: s.students?.full_name ?? "—",
    program: s.programs?.name ?? "—",
    college: s.colleges?.name ?? "—",
    authors: authorsBySub.get(s.id) ?? [],
    authorDetails: authorDetailsBySub.get(s.id) ?? [],
    type: s.filing_type,
    status: s.current_status,
    submitted: fmt(s.date_created),
    filed: s.filing_date ? fmt(s.filing_date) : "—",
    filedRaw: s.filing_date ?? undefined,
    history: [{ status: "Paper Submitted", at: fmt(s.date_created), atRaw: s.date_created }, ...(historyBySub.get(s.id) ?? [])],
    certificate: certBySub.get(s.id),
    ser: serBySub.get(s.id)?.ser,
    problems: openProblems.get(s.id) ?? 0,
    archived: s.archived,
    archiveReason: s.archive_reason ?? undefined,
    drive: s.drive_folder_link ?? undefined,
    linkReport: s.drive_link_reported_at ? { at: fmt(s.drive_link_reported_at), note: s.drive_link_report_note ?? undefined, by: s.drive_link_reported_by ?? undefined } : undefined,
  }));

  const defects: Defect[] = (defs.data ?? []).map((d) => ({
    id: d.id,
    problemId: d.problem_id,
    submissionId: refOf.get(d.submission_id) ?? d.submission_id,
    noticeDate: d.notice_date,
    deadline: fmt(d.deadline_date),
    status: d.status,
    comments: commentsByDefect.get(d.id) ?? [],
  }));

  const remarks: Record<string, Comment[]> = {};
  for (const [ref, list] of remarksByRef) remarks[ref] = list;

  const events: Event[] = (evs.data ?? []).map((e, i) => ({
    id: e.id,
    title: e.title,
    type: e.activity_type === "Others" && e.activity_type_other ? e.activity_type_other : e.activity_type,
    date: fmt(e.event_date),
    time: e.start_time ? String(e.start_time).slice(0, 5) : "—",
    mode: e.mode_of_delivery,
    place: e.mode_of_delivery === "Online" ? "Online session" : (e.venue ?? "—"),
    link: e.mode_of_delivery === "Online" ? (e.venue ?? e.drive_link ?? undefined) : undefined,
    registered: approvedRegs.get(e.id) ?? 0,
    dateRaw: e.event_date,
    activityType: e.activity_type,
    activityOther: e.activity_type_other ?? undefined,
    durationDays: e.duration_days,
    durationHours: Number(e.duration_hours),
    participantsInvolved: e.participants_involved ?? [],
    sector: e.sector ?? [],
    male: e.participants_male,
    female: e.participants_female,
    total: e.participants_total,
    ageRange: e.age_range ?? [],
    drive: e.drive_link ?? undefined,
    venue: e.venue ?? undefined,
    icon: ["lightbulb", "search_insights", "draw", "event"][i % 4],
    color: ["blue", "orange", "purple"][i % 3],
  }));

  const registrations: Registration[] = (regs.data ?? []).map((r) => ({
    id: r.id,
    mine: r.student_id === studentUuid,
    eventTitle: r.events?.title ?? "—",
    student: r.students?.full_name ?? r.students?.email ?? "—",
    status: r.status === "pending" ? "Pending approval" : r.status === "approved" ? "Approved" : "Declined",
  }));

  const nameByEmail = new Map<string, string>();
  for (const s of stus.data ?? []) nameByEmail.set(s.email, s.full_name);
  for (const a of adms.data ?? []) nameByEmail.set(a.email, a.full_name);
  const accounts: Account[] = (wl.data ?? []).map((w) => ({
    name: nameByEmail.get(w.email) ?? "—",
    email: w.email,
    role: w.role === "super_admin" ? "Super Admin" : w.role === "admin" ? "Admin" : "Student",
    status: w.status === "active" ? "Active" : "Inactive",
    rawRole: w.role as "student" | "admin" | "super_admin",
  }));

  const colleges = (cols.data ?? []).map((c) => c.name);
  const programs: Record<string, string[]> = {};
  const programById: Record<number, { name: string; college: string }> = {};
  for (const p of progs.data ?? []) {
    const cname = (cols.data ?? []).find((c) => c.id === p.college_id)?.name ?? "";
    (programs[cname] = programs[cname] ?? []).push(p.name);
    programById[p.id] = { name: p.name, college: cname };
  }

  void uuidOf;
  return { papers, defects, remarks, events, registrations, accounts, colleges, programs, programById };
}

/* ---------- notifications + audit log ---------- */

export type NotificationItem = { id: string; type: string; at: string; read: boolean; message: string; reference?: string };

const notifMessage = (type: string, p: Record<string, unknown>): string => {
  const ref = String(p.reference ?? "");
  switch (type) {
    case "new_submission": return `New submission: ${p.title ?? ref}`;
    case "status_change": return `${ref} moved to ${p.new}`;
    case "remark": return `New remark on ${ref}`;
    case "certificate": return `Certificate issued for ${ref}`;
    case "formality_defect": return `Formality defect round ${p.round} logged on ${ref} — respond by ${fmt(String(p.deadline ?? ""))}`;
    case "registration_request": return `${p.student ?? "A student"} requested to join ${p.event}`;
    case "registration_received": return `Registration received for ${p.event}`;
    case "registration_approved": return `Registration approved for ${p.event}`;
    case "registration_declined": return `Registration declined for ${p.event}`;
    case "ser_reminder": return `SER deadline ${p.overdue ? "overdue" : "approaching"} for ${ref} — due ${fmt(String(p.deadline ?? ""))}`;
    case "defect_reminder": return `Formality defect round ${p.round} ${p.overdue ? "overdue" : "approaching"} for ${ref} — due ${fmt(String(p.deadline ?? ""))}`;
    case "broken_link": return p.by === "ITSO" ? `ITSO can't open the Drive folder for ${ref} — please update the link` : `Broken Drive link reported on ${ref}`;
    case "drive_link_updated": return `Drive link updated on ${ref}`;
    case "new_event": return `New event: ${p.event} on ${fmt(String(p.date ?? ""))}`;
    default: return `${ref} ${type}`;
  }
};

export async function loadNotifications(isAdmin: boolean, email: string): Promise<NotificationItem[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("notifications_log").select("*")
    .eq("recipient", isAdmin ? "admin" : email).order("created_at", { ascending: false }).limit(50);
  if (error) { console.warn("[ITSO] notifications unavailable:", error.message); return []; }
  return (data ?? []).map((n) => ({
    id: n.id, type: n.type, at: fmtTime(n.created_at), read: !!n.read_at,
    message: notifMessage(n.type, (n.payload ?? {}) as Record<string, unknown>),
    reference: (n.payload as { reference?: string } | null)?.reference,
  }));
}

export async function dbMarkNotificationsRead(ids: string[]) {
  if (!supabase || !ids.length) return;
  const { error } = await supabase.from("notifications_log").update({ read_at: new Date().toISOString() }).in("id", ids);
  if (error) console.warn("[ITSO] mark-read failed:", error.message);
}

export type ActionLogEntry = { id: string; when: string; admin: string; action: string; target: string; details: Record<string, unknown> | null };

export async function loadActionLog(): Promise<ActionLogEntry[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("admin_action_log").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) { console.warn("[ITSO] action log unavailable:", error.message); return []; }
  return (data ?? []).map((r) => ({ id: r.id, when: fmtTime(r.created_at), admin: r.admin_email ?? "—", action: r.action_type, target: r.target_record ?? "—", details: (r.details ?? null) as Record<string, unknown> | null }));
}

/* ---------- mutations (all run under the signed-in user's RLS context) ---------- */

export async function dbSubmitPaper(input: {
  studentUuid: string; title: string; studentIdNumber: string; college: string; program: string;
  type: string; drive: string; authors: { name: string; email?: string | null }[];
}) {
  if (!supabase) throw new Error("offline");
  const { data: prog } = await supabase.from("programs").select("id, college_id").eq("name", input.program).single();
  if (!prog) throw new Error(`Program not found: ${input.program}`);
  const { data: sub, error } = await supabase
    .from("submissions")
    .insert({
      student_id: input.studentUuid,
      student_submitted_id_number: input.studentIdNumber,
      title: input.title,
      program_id: prog.id,
      college_id: prog.college_id,
      filing_type: input.type,
      drive_folder_link: input.drive,
    })
    .select("id")
    .single();
  if (error) throw error;
  const rows = input.authors.map((a, i) => ({
    submission_id: sub.id, author_name: a.name, email: a.email ?? null, order_index: i + 1, added_by_role: "student" as const,
  }));
  const { error: aerr } = await supabase.from("submission_authors").insert(rows);
  if (aerr) throw aerr;
}

export async function dbUpdateStatus(submissionDbId: string, newStatus: string) {
  const { error } = await supabase!.from("submissions").update({ current_status: newStatus }).eq("id", submissionDbId);
  if (error) throw error;
}

export async function dbUnarchive(submissionDbId: string) {
  const { error } = await supabase!.from("submissions")
    .update({ archived: false, archived_date: null, archive_reason: null }).eq("id", submissionDbId);
  if (error) throw error;
}

export async function dbArchive(submissionDbId: string, reason: string) {
  const { error } = await supabase!.from("submissions")
    .update({ archived: true, archived_date: new Date().toISOString(), archive_reason: reason }).eq("id", submissionDbId);
  if (error) throw error;
}

export async function dbAddRemark(submissionDbId: string, text: string, adminEmail: string) {
  const { error } = await supabase!.from("remarks")
    .insert({ submission_id: submissionDbId, comment_text: text, admin_email: adminEmail });
  if (error) throw error;
}

export async function dbAddDefect(submissionDbId: string, noticeDate: string, text: string, adminEmail: string, round: number) {
  const { data: prob, error: perr } = await supabase!.from("problems")
    .insert({ submission_id: submissionDbId, problem_type: "Formality Defect", date_triggered: noticeDate, deadline_date: addMonthsIso(noticeDate, 2) })
    .select("id").single();
  if (perr) throw perr;
  const { data: def, error: derr } = await supabase!.from("formality_defects")
    .insert({ problem_id: prob.id, submission_id: submissionDbId, round_number: round, notice_date: noticeDate })
    .select("id").single();
  if (derr) throw derr;
  const { error: cerr } = await supabase!.from("formality_defect_comments")
    .insert({ formality_defect_id: def.id, comment_text: text, admin_email: adminEmail });
  if (cerr) throw cerr;
}

export async function dbRecordFilingDate(submissionDbId: string, date: string) {
  const { error } = await supabase!.from("submissions")
    .update({ filing_date: date, last_activity_date: new Date().toISOString() }).eq("id", submissionDbId);
  if (error) throw error;
}

export async function dbResolveSer(problemId: string, note: string) {
  const { error } = await supabase!.from("problems")
    .update({ status: "resolved", resolved_date: new Date().toISOString().slice(0, 10), resolution_note: note }).eq("id", problemId);
  if (error) throw error;
}

export async function dbIssueCertificate(submissionDbId: string, link: string) {
  const { error } = await supabase!.from("certificates")
    .insert({ submission_id: submissionDbId, file_reference: link });
  if (error) throw error;
  const { data: sub } = await supabase!.from("submissions").select("current_status").eq("id", submissionDbId).single();
  if (sub && sub.current_status !== "Approved with Certificate") await dbUpdateStatus(submissionDbId, "Approved with Certificate");
}

export async function dbCompleteProfile(input: { given: string; middle: string; family: string; suffix: string; studentIdNumber?: string; programName?: string }) {
  let programId: number | null = null;
  if (input.programName) {
    const { data: prog } = await supabase!.from("programs").select("id").eq("name", input.programName).single();
    if (!prog) throw new Error(`Program not found: ${input.programName}`);
    programId = prog.id;
  }
  const { error } = await supabase!.rpc("complete_my_profile", {
    p_given: input.given, p_middle: input.middle || null, p_family: input.family, p_suffix: input.suffix || null,
    p_student_id_number: input.studentIdNumber ?? null, p_program_id: programId,
  });
  if (error) throw error;
}

export async function dbUpdateMyProfile(input: { given: string; middle: string; family: string; suffix: string; studentIdNumber?: string; programName?: string }) {
  let programId: number | null = null;
  if (input.programName) {
    const { data: prog } = await supabase!.from("programs").select("id").eq("name", input.programName).single();
    if (!prog) throw new Error(`Program not found: ${input.programName}`);
    programId = prog.id;
  }
  const { error } = await supabase!.rpc("update_my_profile", {
    p_given: input.given, p_middle: input.middle || null, p_family: input.family, p_suffix: input.suffix || null,
    p_student_id_number: input.studentIdNumber ?? null, p_program_id: programId,
  });
  if (error) throw error;
}

export async function dbLogAction(action: string, target: string, details?: Record<string, unknown>) {
  if (!supabase) return;
  const { error } = await supabase.rpc("log_admin_action", { p_action: action, p_target: target, p_details: details ?? null });
  if (error) console.warn("[ITSO] action log failed:", error.message);
}

export async function dbReplyDefect(defectId: string, text: string, adminEmail: string) {
  const { error } = await supabase!.from("formality_defect_comments")
    .insert({ formality_defect_id: defectId, comment_text: text, admin_email: adminEmail });
  if (error) throw error;
}

export async function dbResolveDefect(defectId: string, problemId: string | undefined) {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase!.from("formality_defects")
    .update({ status: "resolved", resolved_date: today }).eq("id", defectId);
  if (error) throw error;
  if (problemId) {
    await supabase!.from("problems").update({ status: "resolved", resolved_date: today }).eq("id", problemId);
  }
}

export const EVENT_ACTIVITY_TYPES = ["IP Awareness", "Patent Search", "Patent Drafting", "IPA and PS", "IPA and PD", "PS and PD", "IPS, PA, and PD"];

export type EventInput = {
  title: string; type: string; typeOther?: string; mode: string; date: string; time?: string; place?: string;
  durationDays: number; durationHours: number; participantsInvolved: string[]; sector: string[];
  male: number; female: number; ageRange: string[]; drive?: string;
};

const eventRow = (input: EventInput) => ({
  title: input.title,
  activity_type: EVENT_ACTIVITY_TYPES.includes(input.type) ? input.type : "Others",
  activity_type_other: EVENT_ACTIVITY_TYPES.includes(input.type) ? null : input.typeOther ?? input.type,
  mode_of_delivery: input.mode,
  event_date: input.date,
  start_time: input.mode === "Online" ? null : input.time || null,
  venue: input.place || null,
  duration_days: input.durationDays,
  duration_hours: input.durationHours,
  participants_involved: input.participantsInvolved,
  sector: input.sector,
  participants_male: input.male,
  participants_female: input.female,
  participants_total: input.male + input.female,
  age_range: input.ageRange,
  drive_link: input.drive || null,
});

export async function dbAddEvent(input: EventInput) {
  const { error } = await supabase!.from("events").insert(eventRow(input));
  if (error) throw error;
}

export async function dbUpdateEvent(eventId: string, input: EventInput) {
  const { error } = await supabase!.from("events").update(eventRow(input)).eq("id", eventId);
  if (error) throw error;
}

export async function dbDeleteEvent(eventId: string) {
  const { error } = await supabase!.from("events").delete().eq("id", eventId);
  if (error) throw error;
}

export async function dbRegisterEvent(eventId: string, studentUuid: string) {
  const { error } = await supabase!.from("event_registrations")
    .insert({ event_id: eventId, student_id: studentUuid });
  if (error) throw error;
}

export async function dbDecideRegistration(regId: string, status: "approved" | "declined") {
  const { error } = await supabase!.from("event_registrations").update({ status }).eq("id", regId);
  if (error) throw error;
}

export async function dbAddWhitelist(email: string, role: "student" | "admin" = "student") {
  const { error } = await supabase!.from("authorized_emails").insert({ email: email.trim().toLowerCase(), role });
  if (error) throw error;
}

export async function dbSetAccountStatus(email: string, status: "active" | "inactive") {
  const { error } = await supabase!.from("authorized_emails").update({ status }).eq("email", email.trim().toLowerCase());
  if (error) throw error;
}

export async function dbUpdateAccountName(email: string, role: "student" | "admin" | "super_admin", parts: { given: string; middle: string; family: string; suffix: string }) {
  const trimmed = { given: parts.given.trim() || null, middle: parts.middle.trim() || null, family: parts.family.trim() || null, suffix: parts.suffix.trim() || null };
  const full = [trimmed.given, trimmed.middle, trimmed.family, trimmed.suffix].filter(Boolean).join(" ");
  const { error } = await supabase!.from(role === "student" ? "students" : "admins")
    .update({ given_name: trimmed.given, middle_name: trimmed.middle, family_name: trimmed.family, suffix: trimmed.suffix, full_name: full })
    .eq("email", email.trim().toLowerCase());
  if (error) throw error;
}

export async function dbAddAuthor(submissionDbId: string, name: string, email?: string | null) {
  const { data: last } = await supabase!.from("submission_authors").select("order_index")
    .eq("submission_id", submissionDbId).order("order_index", { ascending: false }).limit(1);
  const { error } = await supabase!.from("submission_authors")
    .insert({ submission_id: submissionDbId, author_name: name, email: email ?? null, order_index: (last?.[0]?.order_index ?? 0) + 1, added_by_role: "student" });
  if (error) throw error;
}

export async function dbReportBrokenLink(submissionDbId: string, note: string) {
  const { error } = await supabase!.rpc("report_broken_link", { p_submission: submissionDbId, p_note: note || null });
  if (error) throw error;
}

export async function dbUpdateMyDriveLink(submissionDbId: string, link: string) {
  const { error } = await supabase!.rpc("update_my_drive_link", { p_submission: submissionDbId, p_link: link });
  if (error) throw error;
}

export async function dbClearBrokenLink(submissionDbId: string) {
  const { error } = await supabase!.rpc("clear_broken_link", { p_submission: submissionDbId });
  if (error) throw error;
}

export async function dbDeleteAuthor(authorId: string) {
  const { error } = await supabase!.from("submission_authors").delete().eq("id", authorId);
  if (error) throw error;
}

export async function dbUpdateAuthor(authorId: string, patch: { name?: string; email?: string | null }) {
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.author_name = patch.name;
  if (patch.email !== undefined) update.email = patch.email;
  const { error } = await supabase!.from("submission_authors").update(update).eq("id", authorId);
  if (error) throw error;
}
