import { useEffect, useMemo, useState } from "react";
import LoginScreen from "./LoginScreen";
import { ITSO_EMAIL, copyItsoEmail } from "./lib/contact";
import { isSupabaseConfigured, supabase } from "./lib/supabase";
import {
  getSessionUser, signOut as dbSignOut, loadWorkspace,
  dbSubmitPaper, dbUpdateStatus, dbUnarchive, dbAddRemark, dbAddDefect, dbReplyDefect,
  dbResolveDefect, dbAddEvent, dbRegisterEvent, dbDecideRegistration, dbAddWhitelist,
  dbRecordFilingDate, dbResolveSer, dbIssueCertificate, dbLogAction, dbUpdateEvent, dbDeleteEvent,
  EVENT_ACTIVITY_TYPES, loadNotifications, dbMarkNotificationsRead, loadActionLog, dbCompleteProfile,
  dbSetAccountStatus, dbUpdateAccountName, dbAddAuthor, dbDeleteAuthor, dbUpdateAuthor,
  dbReportBrokenLink, dbUpdateMyDriveLink, dbClearBrokenLink, dbUpdateMyProfile, applicantLabel,
  type NotificationItem, type ActionLogEntry, type Account, type ApplicantType,
  type SessionUser,
} from "./lib/db";

type Page = "Overview" | "Papers Submitted" | "Analytics" | "Events" | "Archives" | "Security" | "My Submissions";
type Role = "Admin" | "Student";
type Paper = {
  id: string; dbId?: string; ownerUuid?: string; title: string; studentId: string; student: string; program: string; college: string; authors: string[];
  type: string; status: string; submitted: string; filed: string; problems: number; archived?: boolean; archiveReason?: string; drive?: string;
  history?: { status: string; at: string; by?: string; atRaw?: string; initial?: boolean }[]; filedRaw?: string; authorDetails?: { id?: string; name: string; email: string | null }[]; linkReport?: { at: string; note?: string; by?: string };
  certificate?: { link?: string; issued: string };
  ser?: { id: string; triggered: string; deadline: string; deadlineRaw: string; status: "open" | "resolved"; note?: string };
  applicantType?: ApplicantType; affiliation?: string;
};
type Comment = { text: string; timestamp: string; author: string };
type Defect = { id: string; problemId?: string; submissionId: string; noticeDate: string; deadline: string; status: "open" | "resolved"; resolvedDate?: string; comments: Comment[]; round?: number; details?: string; deadlineRaw?: string };
type Event = { id?: string; title: string; type: string; date: string; time: string; mode: string; place: string; link?: string; registered: number; icon: string; color: string; dateRaw?: string; activityType?: string; activityOther?: string; durationDays?: number; durationHours?: number; participantsInvolved?: string[]; sector?: string[]; male?: number; female?: number; total?: number; ageRange?: string[]; drive?: string; venue?: string };
type Registration = { id?: string; mine?: boolean; eventTitle: string; student: string; status: "Pending approval" | "Approved" | "Declined"; classification?: string };

const load = <T,>(key: string, fallback: T): T => {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
};
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or unavailable */ } };

function addMonths(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(year, month - 1 + months, 1);
  target.setDate(Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
  return target.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day + days).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function addDaysRaw(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(year, month - 1, day + days);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
}
function defectLabel(round: number) {
  const suffix = round % 100 >= 11 && round % 100 <= 13 ? "th" : round % 10 === 1 ? "st" : round % 10 === 2 ? "nd" : round % 10 === 3 ? "rd" : "th";
  return `${round}${suffix} Formality Defect`;
}
function addMonthsRaw(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(year, month - 1 + months, 1);
  target.setDate(Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
}

const fmtDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const todayFmt = () => new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const daysUntil = (iso: string) => Math.ceil((new Date(`${iso}T12:00:00`).getTime() - Date.now()) / 86400000);
const humanAction = (a: string) => a === "auto_archive" ? "Auto-archive" : a.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
const detailText = (action: string, d: Record<string, unknown> | null) => {
  if (!d) return "—";
  if (action === "status_change" && (d.from || d.to)) return `${d.from ?? "—"} → ${d.to ?? "—"}`;
  if (action === "auto_archive" && d.reason) return String(d.reason);
  return Object.entries(d).map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
};
const submittedIso = (p: { submitted: string; history?: { atRaw?: string }[] }) => {
  const raw = p.history?.[0]?.atRaw;
  if (raw) return raw.slice(0, 10);
  const d = p.submitted === "Today" ? new Date() : new Date(p.submitted);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const filedIso = (p: { filedRaw?: string; filed: string }) => {
  if (p.filedRaw) return p.filedRaw;
  if (!p.filed || p.filed === "—") return undefined;
  const d = new Date(p.filed);
  return Number.isNaN(d.getTime()) ? undefined : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const eventIso = (e: { dateRaw?: string; date: string }) => {
  if (e.dateRaw) return e.dateRaw;
  const d = new Date(e.date);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const colleges = [
  "College of Business", "College of Accountancy", "College of Education", "College of Engineering", "College of Computer Studies",
];
const programs: Record<string, string[]> = {
  [colleges[0]]: ["Bachelor of Science in Entrepreneurship (BSentrep)"],
  [colleges[1]]: ["Bachelor of Science in Accountancy (BSA)"],
  [colleges[2]]: ["Bachelor of Early Childhood Education (BECEd)"],
  [colleges[3]]: ["BS Industrial Engineering (BSIE)", "BS Electronics Engineering (BSECE)", "BS Computer Engineering (BSCpE)"],
  [colleges[4]]: ["BS Information Technology (BSIT)", "BS Information Systems (BSIS)", "BS Computer Science (BSCS)"],
};
const statuses = ["Under Review", "Submitted to IPOPHIL", "Revisions Needed", "Passed", "Received eSOA", "Paid", "Approved with Certificate", "Withdrawn", "Disapproved"];
const types = ["Copyright", "Patent", "Utility Model", "Industrial Design"];
const participantOptions = ["Students", "Researcher", "Academic-Faculty", "Entrepreneur-Business Person"];
const sectorOptions = ["LGU", "Government Agency", "Academic Institution", "MSME"];
const ageOptions = ["13–20", "21–30", "31–45", "46–59", "60 and above"];
const COLLEGE_COLORS = ["#002366", "#FD7201", "#1e55be", "#8a5cf6", "#16a34a", "#0e7490", "#64748b"];
const CURRENT_STUDENT = "Alex Rivera";
const initialPapers: Paper[] = [
  { id: "ITSO-2025-0084", title: "Smart Waste Segregation System Using Image Recognition", studentId: "22-0145", student: "Alex Rivera", program: "BS Information Technology (BSIT)", college: colleges[4], authors: ["Alex Rivera", "Janelle Cruz"], type: "Patent", status: "Under Review", submitted: "Oct 24, 2025", filed: "—", problems: 0 },
  { id: "ITSO-2025-0083", title: "Adaptive Learning Platform for Early Childhood Education", studentId: "21-0231", student: "Maria Santos", program: "Bachelor of Early Childhood Education (BECEd)", college: colleges[2], authors: ["Maria Santos", "Paolo Reyes"], type: "Copyright", status: "Revisions Needed", submitted: "Oct 22, 2025", filed: "—", problems: 1 },
  { id: "ITSO-2025-0082", title: "Low-Cost Solar-Powered Water Filtration Device", studentId: "22-0318", student: "Daniel Lim", program: "BS Industrial Engineering (BSIE)", college: colleges[3], authors: ["Daniel Lim", "Aira Mendoza", "Luis Ong"], type: "Utility Model", status: "Submitted to IPOPHIL", submitted: "Oct 18, 2025", filed: "Oct 21, 2025", problems: 1 },
  { id: "ITSO-2025-0081", title: "Modular Ergonomic Workspace for Small Enterprises", studentId: "23-0067", student: "Sofia Garcia", program: "Bachelor of Science in Entrepreneurship (BSentrep)", college: colleges[0], authors: ["Sofia Garcia"], type: "Industrial Design", status: "Passed", submitted: "Oct 15, 2025", filed: "Oct 20, 2025", problems: 0 },
  { id: "ITSO-2025-0080", title: "Community-Based Digital Financial Literacy Toolkit", studentId: "21-0104", student: "Nina Torres", program: "Bachelor of Science in Accountancy (BSA)", college: colleges[1], authors: ["Nina Torres", "Kara Dizon"], type: "Copyright", status: "Approved with Certificate", submitted: "Oct 12, 2025", filed: "Sep 30, 2025", problems: 0 },
  { id: "ITSO-2025-0079", title: "Portable Air Quality Monitoring Device", studentId: "20-0198", student: "John dela Cruz", program: "BS Electronics Engineering (BSECE)", college: colleges[3], authors: ["John dela Cruz", "Mika Tan"], type: "Patent", status: "Received eSOA", submitted: "Oct 09, 2025", filed: "Oct 14, 2025", problems: 1 },
  { id: "ITSO-2025-0078", title: "Campus Navigation App for Accessible Routes", studentId: "23-0152", student: "Bea Flores", program: "BS Information Technology (BSIT)", college: colleges[4], authors: ["Bea Flores"], type: "Copyright", status: "Under Review", submitted: "Oct 06, 2025", filed: "—", problems: 0 },
  { id: "ITSO-2015-0012", title: "Automated Urban Garden Irrigation Framework", studentId: "12-0144", student: "Carlo Ramos", program: "BS Computer Engineering (BSCpE)", college: colleges[3], authors: ["Carlo Ramos"], type: "Utility Model", status: "Approved with Certificate", submitted: "Jun 12, 2015", filed: "Jul 02, 2015", problems: 0, archived: true, archiveReason: "Completed 10 years ago" },
];
const initialEvents: Event[] = [
  { title: "IP Awareness: From Idea to Impact", type: "IP Awareness", date: "Nov 18, 2025", time: "09:00", mode: "Onsite", place: "QCU Auditorium", registered: 68, icon: "lightbulb", color: "blue" },
  { title: "Patent Search Fundamentals", type: "Patent Search", date: "Nov 26, 2025", time: "13:30", mode: "Online", place: "Online session", registered: 42, icon: "search_insights", color: "orange" },
  { title: "Patent Drafting Workshop", type: "Patent Drafting", date: "Dec 05, 2025", time: "10:00", mode: "Onsite", place: "Innovation Hub", registered: 35, icon: "draw", color: "purple" },
];
function Icon({ name, size = 20 }: { name: string; size?: number }) { return <span className="material-symbols-outlined icon" style={{ fontSize: size }} aria-hidden="true">{name}</span>; }
function Status({ value }: { value: string }) {
  const tone = value === "Approved with Certificate" || value === "Passed" ? "green" : value === "Revisions Needed" || value === "Received eSOA" ? "amber" : value === "Disapproved" || value === "Withdrawn" ? "red" : value === "Paper Submitted" ? "slate" : "blue";
  return <span className={`status status-${tone}`}><span className="status-dot" />{value}</span>;
}
function SectionHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="section-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}
function Stat({ icon, label, value, note, tone = "blue" }: { icon: string; label: string; value: string; note: string; tone?: string }) {
  return <div className="stat-card"><div className="stat-top"><span className={`stat-icon ${tone}`}><Icon name={icon} size={22} /></span><Icon name="north_east" size={17} /></div><div className="stat-value">{value}</div><div className="stat-label">{label}</div><div className="stat-note">{note}</div></div>;
}

export default function App() {
  const [session, setSession] = useState<Role | null>(null);
  const [me, setMe] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(!isSupabaseConfigured);
  const [authError, setAuthError] = useState("");
  const [dbColleges, setDbColleges] = useState<string[] | null>(null);
  const [dbPrograms, setDbPrograms] = useState<Record<string, string[]> | null>(null);
  const [dbProgramById, setDbProgramById] = useState<Record<number, { name: string; college: string }>>({});
const [dbCollegeById, setDbCollegeById] = useState<Record<number, string>>({});
  const collegeOptions = dbColleges ?? colleges;
  const programOptions = dbPrograms ?? programs;
  const [role, setRole] = useState<Role>("Admin");
  const [page, setPage] = useState<Page>("Overview");
  const [papers, setPapers] = useState<Paper[]>(() => load("itso.papers.v1", initialPapers));
  const [events, setEvents] = useState<Event[]>(() => load("itso.events.v1", initialEvents));
  const [registrations, setRegistrations] = useState<Registration[]>(() => load("itso.registrations.v1", []));
  const [defects, setDefects] = useState<Defect[]>(() => load("itso.defects.v1", [{ id: "local-1", submissionId: "ITSO-2025-0083", noticeDate: "2025-10-22", deadline: addDays("2025-10-22", 60), deadlineRaw: addDaysRaw("2025-10-22", 60), round: 1, details: "Please correct the information noted in the formality notice.", status: "open", comments: [{ text: "Please correct the information noted in the formality notice.", timestamp: "Oct 22, 2025", author: "ITSO Admin" }] }]));
  const [remarks, setRemarks] = useState<Record<string, Comment[]>>(() => load("itso.remarks.v1", {}));
  const [selected, setSelected] = useState<Paper | null>(null);
  const [modal, setModal] = useState<"instructions" | "submit" | "event" | "account" | "name" | "profile" | null>(null);
  const [instructionPurpose, setInstructionPurpose] = useState<"view" | "submit" | "read">("view");
  const openInstructions = (purpose: "view" | "submit" | "read") => { setInstructionPurpose(purpose); setModal("instructions"); };
  const [notice, setNotice] = useState("");
  const [emailCopied, setEmailCopied] = useState(false);
  const [search, setSearch] = useState("");
  const [college, setCollege] = useState("");
  const [program, setProgram] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [mobileNav, setMobileNav] = useState(false);
  const [authorInput, setAuthorInput] = useState("");
  const [authors, setAuthors] = useState<{ name: string; email: string }[]>([]);
  const [formCollege, setFormCollege] = useState("");
  const [formProgram, setFormProgram] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formType, setFormType] = useState("");
  const [formDrive, setFormDrive] = useState("");
  const [formStudentId, setFormStudentId] = useState("");
  const [formApplicant, setFormApplicant] = useState<ApplicantType>("student");
  const [formAffil, setFormAffil] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [remark, setRemark] = useState("");
  const [generalComment, setGeneralComment] = useState("");
  const [defectComment, setDefectComment] = useState("");
  const [defectNotice, setDefectNotice] = useState("");
  const [defectReply, setDefectReply] = useState<Record<string, string>>({});
  const [pendingStatus, setPendingStatus] = useState("");
  const [filingDate, setFilingDate] = useState("");
  const [serNote, setSerNote] = useState("");
  const [certLink, setCertLink] = useState("");
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventTime, setEventTime] = useState("");
  const [eventLocation, setEventLocation] = useState("");
  const [eventType, setEventType] = useState("IP Awareness");
  const [eventOther, setEventOther] = useState("");
  const [eventMode, setEventMode] = useState("Onsite");
  const [eventDays, setEventDays] = useState("1");
  const [eventHours, setEventHours] = useState("8");
  const [eventParticipants, setEventParticipants] = useState<string[]>([]);
  const [eventSector, setEventSector] = useState<string[]>([]);
  const [eventMale, setEventMale] = useState("0");
  const [eventFemale, setEventFemale] = useState("0");
  const [eventAge, setEventAge] = useState<string[]>([]);
  const [eventDrive, setEventDrive] = useState("");
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [eventSearch, setEventSearch] = useState("");
  const [eventMonth, setEventMonth] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [filedFrom, setFiledFrom] = useState("");
  const [filedTo, setFiledTo] = useState("");
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
  const [logSearch, setLogSearch] = useState("");
  const [logType, setLogType] = useState("");
  const [acctSearch, setAcctSearch] = useState("");
  const [acctRole, setAcctRole] = useState("");
  const [acctStat, setAcctStat] = useState("");
  const [obType, setObType] = useState<ApplicantType>("student");
  const [obAffil, setObAffil] = useState("");
  const [pfType, setPfType] = useState<ApplicantType>("student");
  const [pfAffil, setPfAffil] = useState("");
  const [obGiven, setObGiven] = useState("");
  const [obMiddle, setObMiddle] = useState("");
  const [obFamily, setObFamily] = useState("");
  const [obSuffix, setObSuffix] = useState("");
  const [obStudentId, setObStudentId] = useState("");
  const [obCollege, setObCollege] = useState("");
  const [obProgram, setObProgram] = useState("");
  const [obError, setObError] = useState("");
  const [obBusy, setObBusy] = useState(false);
  const [anaFrom, setAnaFrom] = useState("");
  const [anaTo, setAnaTo] = useState("");
  const [chartMode, setChartMode] = useState<"weekly" | "monthly" | "yearly">("monthly");
  const [newRole, setNewRole] = useState<"student" | "admin">("student");
  const [editNameFor, setEditNameFor] = useState<Account | null>(null);
  const [enGiven, setEnGiven] = useState("");
  const [enMiddle, setEnMiddle] = useState("");
  const [enFamily, setEnFamily] = useState("");
  const [enSuffix, setEnSuffix] = useState("");
  const [newAuthorName, setNewAuthorName] = useState(""); const [newAuthorEmail, setNewAuthorEmail] = useState("");
  const [editingAuthor, setEditingAuthor] = useState<string | null>(null);
  const [authorEdit, setAuthorEdit] = useState(""); const [authorEmailEdit, setAuthorEmailEdit] = useState("");
  const [linkNoteOpen, setLinkNoteOpen] = useState(false);
  const [linkNote, setLinkNote] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("itso.theme") as "dark" | "light" | null) ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [pfGiven, setPfGiven] = useState("");
  const [pfMiddle, setPfMiddle] = useState("");
  const [pfFamily, setPfFamily] = useState("");
  const [pfSuffix, setPfSuffix] = useState("");
  const [pfStudentId, setPfStudentId] = useState("");
  const [pfCollege, setPfCollege] = useState("");
  const [pfProgram, setPfProgram] = useState("");
  const [pfError, setPfError] = useState("");
  const [pfBusy, setPfBusy] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>(() => load<Account[]>("itso.accounts.v1", [{ name: "Alex Rivera", email: "alex.rivera@qcu.edu.ph", role: "Student", status: "Active" }, { name: "Maria Santos", email: "maria.santos@qcu.edu.ph", role: "Student", status: "Active" }, { name: "ITSO Administrator", email: "admin@qcu.edu.ph", role: "Admin", status: "Active" }]));
  const [newEmail, setNewEmail] = useState("");

  useEffect(() => {
    save("itso.papers.v1", papers);
    save("itso.events.v1", events);
    save("itso.registrations.v1", registrations);
    save("itso.defects.v1", defects);
    save("itso.remarks.v1", remarks);
    save("itso.accounts.v1", accounts);
  }, [papers, events, registrations, defects, remarks, accounts]);

  const refresh = async (r: Role = role, studentUuid: string | null = me?.studentUuid ?? null, email: string | null = me?.email ?? null) => {
    const w = await loadWorkspace(r === "Admin", studentUuid);
    setPapers(w.papers); setEvents(w.events); setRegistrations(w.registrations);
    setDefects(w.defects); setRemarks(w.remarks); setAccounts(w.accounts);
    setDbColleges(w.colleges); setDbPrograms(w.programs); setDbProgramById(w.programById); setDbCollegeById(w.collegeById);
    setSelected(prev => prev ? (w.papers.find(x => x.id === prev.id) ?? null) : null);
    setNotifications(await loadNotifications(r === "Admin", email ?? ""));
    if (page === "Security" && me?.isSuper) void loadActionLog().then(setActionLog);
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); await refresh(); toast(ok); }
    catch (e) { console.error("[ITSO] save failed:", e); toast(`Save failed: ${(e as { message?: string })?.message ?? "check permissions"}`); }
  };

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    const boot = async () => {
      let u = await getSessionUser();
      if (!u && /[?&#](code|access_token|error)=/.test(window.location.search + window.location.hash)) {
        await new Promise(r => setTimeout(r, 1200));
        u = await getSessionUser();
      }
      if (u?.role) {
        setMe(u); setRole(u.role); setSession(u.role);
        try { await refresh(u.role, u.studentUuid, u.email); } catch (e) { console.error("[ITSO] workspace load failed:", e); setNotice(`Connected but data failed to load: ${(e as { message?: string })?.message ?? "unknown error"}`); }
      } else if (u) {
        setAuthError(u.email);
      }
      setAuthChecked(true);
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((ev, s) => {
      if (ev === "SIGNED_IN" && s) void boot();
      else if (ev === "SIGNED_OUT") { setSession(null); setMe(null); setAuthChecked(true); }
    });
    void boot();
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!me || !isSupabaseConfigured) return;
    const t = window.setInterval(() => { void loadNotifications(me.role === "Admin", me.email).then(setNotifications); }, 60000);
    return () => window.clearInterval(t);
  }, [me]);

  useEffect(() => {
    if (page === "Security" && me?.isSuper) void loadActionLog().then(setActionLog);
  }, [page, me]);

  useEffect(() => {
    if (me && !me.profileCompleted && !dbColleges) void refresh().catch(e => console.error("[ITSO] workspace load failed:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); try { localStorage.setItem("itso.theme", theme); } catch {} }, [theme]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") { setAvatarOpen(false); setNotifOpen(false); } }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);

  const active = papers.filter(p => !p.archived);
  const archived = papers.filter(p => p.archived);
  const shownAccounts = accounts.filter(a => `${a.name} ${a.email} ${a.role} ${a.classification ?? ""} ${a.status}`.toLowerCase().includes(acctSearch.toLowerCase()) && (!acctRole || a.role === acctRole) && (!acctStat || a.status === acctStat));
  const myType: ApplicantType = me?.role === "Student" ? (me.applicantType ?? "student") : "student";
  const paperSubline = (p: Paper) => p.applicantType === "staff" ? `QCU Faculty / Staff${p.affiliation ? ` · ${p.affiliation}` : ""}` : p.applicantType === "external" ? `External${p.affiliation ? ` · ${p.affiliation}` : ""}` : p.program;
  const anaBuckets = [...collegeOptions, "QCU Faculty / Staff", "External (Non-QCU)"];
  const bucketOf = (p: Paper) => p.applicantType === "staff" ? "QCU Faculty / Staff" : p.applicantType === "external" ? "External (Non-QCU)" : p.college;
  const actionCount = active.filter(p => p.problems > 0 || p.linkReport).length;
  const shownPapers = useMemo(() => papers.filter(p => (page === "Archives" ? p.archived : !p.archived) && (role === "Admin" || (isSupabaseConfigured ? p.ownerUuid === me?.studentUuid : p.student === CURRENT_STUDENT)) && (!college || (college === "__staff" ? p.applicantType === "staff" : college === "__external" ? p.applicantType === "external" : p.college === college)) && (!program || p.program === program) && (!status || p.status === status) && (!type || p.type === type) && (!search || `${p.id} ${p.title} ${p.student} ${p.authors.join(" ")}`.toLowerCase().includes(search.toLowerCase())) && (!(filedFrom || filedTo) || (!!filedIso(p) && (!filedFrom || filedIso(p)! >= filedFrom) && (!filedTo || filedIso(p)! <= filedTo)))), [papers, page, role, college, program, status, type, search, filedFrom, filedTo, me]);
  const go = (target: Page) => { setPage(target); setMobileNav(false); setSearch(""); setCollege(""); setProgram(""); setStatus(""); setType(""); setFiledFrom(""); setFiledTo(""); setSelectedRows([]); setPage(target); window.scrollTo(0, 0); };
  const changeRole = () => { setRole(role === "Admin" ? "Student" : "Admin"); setPage("Overview"); setSelected(null); setMobileNav(false); };
  const toast = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 4000); };
  const unread = notifications.filter(n => !n.read).length;
  const markAllRead = () => { const ids = notifications.filter(n => !n.read).map(n => n.id); setNotifications(notifications.map(n => ({ ...n, read: true }))); void dbMarkNotificationsRead(ids); };
  const openNotification = (n: NotificationItem) => {
    if (!n.read) { setNotifications(notifications.map(x => x.id === n.id ? { ...x, read: true } : x)); void dbMarkNotificationsRead([n.id]); }
    if (n.reference) {
      const paper = papers.find(p => p.id === n.reference);
      if (paper) { go(role === "Admin" ? "Papers Submitted" : "My Submissions"); setSelected(paper); setPendingStatus(paper.status); }
    } else if (n.type === "new_event" || n.type.startsWith("registration_")) go("Events");
    setNotifOpen(false);
  };
  const completeOnboarding = async (e: React.FormEvent) => {
    e.preventDefault(); setObError("");
    if (me?.role === "Student" && obType === "student" && obStudentId && !/^\d{2}-\d{4}$/.test(obStudentId)) { setObError("Student ID must use the format 22-0145."); return; }
    if (me?.role === "Student" && obType !== "student" && !obAffil.trim()) { setObError(obType === "staff" ? "Office / department is required." : "Organization / institution is required."); return; }
    setObBusy(true);
    try {
      await dbCompleteProfile({ given: obGiven, middle: obMiddle, family: obFamily, suffix: obSuffix, applicantType: me?.role === "Student" ? obType : undefined, studentIdNumber: me?.role === "Student" && obType === "student" ? obStudentId || undefined : undefined, programName: me?.role === "Student" && obType === "student" ? obProgram : undefined, collegeName: me?.role === "Student" && obType === "staff" ? obCollege || undefined : undefined, affiliation: me?.role === "Student" && obType !== "student" ? obAffil : undefined });
      const u = await getSessionUser();
      if (u) { setMe(u); await refresh(u.role ?? role, u.studentUuid, u.email); }
    } catch (err) { setObError((err as { message?: string })?.message ?? "Could not save your profile."); }
    setObBusy(false);
  };
  const openSubmitForm = () => {
    if (me?.role === "Student") {
      if (me.fullName && !authors.some(a => a.name === me.fullName)) setAuthors([{ name: me.fullName, email: "" }]);
      if (me.studentIdNumber && !formStudentId) setFormStudentId(me.studentIdNumber);
    }
    setFormApplicant(myType); setFormAffil(myType === "student" ? "" : me?.affiliation ?? "");
    setModal("submit");
  };
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60000); return () => window.clearInterval(t); }, []);
  const greeting = (() => { const h = now.getHours(); return h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 18 ? "Good afternoon" : "Good evening"; })();
  const displayName = me ? (me.givenName ?? me.fullName?.split(" ")[0] ?? (role === "Admin" ? "Admin" : "there")) : (role === "Admin" ? "Admin" : "Alex");
  const avatarInitials = me?.fullName ? (w => w.length > 1 ? `${w[0][0]}${w[w.length - 1][0]}` : w[0][0])(me.fullName.trim().split(/\s+/)).toUpperCase() : (role === "Admin" ? "AD" : "AR");
  const myPapers = active.filter(p => isSupabaseConfigured ? p.ownerUuid === me?.studentUuid : p.student === CURRENT_STUDENT);
  const activityFrom = (list: Paper[], n: number) => list.flatMap(p => (p.history ?? []).filter(h => h.atRaw).map(h => ({ paper: p, status: h.status, initial: h.initial, at: h.atRaw! }))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, n);
  const activityItems = activityFrom(papers, 5);
  const activityInfo = (s: string, initial?: boolean) => initial ? { icon: "description", tone: "blue", label: "New paper submitted" } : s === "Paper Submitted" ? { icon: "description", tone: "blue", label: "New paper submitted" } : s === "Approved with Certificate" ? { icon: "workspace_premium", tone: "green", label: "Certificate issued" } : s === "Revisions Needed" ? { icon: "edit_note", tone: "orange", label: "Revisions requested" } : s === "Withdrawn" || s === "Disapproved" ? { icon: "cancel", tone: "orange", label: `Status changed to ${s}` } : { icon: "sync", tone: "blue", label: `Status changed to ${s}` };
  const relTime = (iso: string) => { const m = Math.floor((Date.now() - Date.parse(iso)) / 60000); if (m < 1) return "just now"; if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`; return fmtDate(iso.slice(0, 10)); };
  const anaPapers = papers.filter(p => { const iso = submittedIso(p); return (!anaFrom || (iso !== "" && iso >= anaFrom)) && (!anaTo || (iso !== "" && iso <= anaTo)); });
  const countBy = (list: Paper[], key: (p: Paper) => string) => { const m = new Map<string, number>(); for (const p of list) m.set(key(p), (m.get(key(p)) ?? 0) + 1); return m; };
  const anaTypeCounts = countBy(anaPapers, p => p.type);
  const anaCollegeCounts = countBy(anaPapers, bucketOf);
  const anaTopType = anaPapers.length ? [...anaTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : "—";
  const anaTopCollege = anaPapers.length ? [...countBy(anaPapers.filter(p => !p.applicantType || p.applicantType === "student"), p => p.college).entries()].sort((a, b) => b[1] - a[1])[0]?.[0].replace(/^College of /, "") ?? "—" : "—";
  const anaLatestRaw = anaPapers.flatMap(p => (p.history ?? []).map(h => h.atRaw)).filter((x): x is string => !!x).sort().pop();
  const anaLatest = anaLatestRaw ? relTime(anaLatestRaw) : "—";
  const anaMaxCollege = Math.max(0, ...anaBuckets.map(c => anaCollegeCounts.get(c) ?? 0));
  const anaActivity = activityFrom(anaPapers, 10);
  const chartBuckets = useMemo(() => {
    const add = (d: Date, unit: string, n: number) => { const x = new Date(d); if (unit === "weekly") x.setDate(x.getDate() + 7 * n); else if (unit === "monthly") x.setMonth(x.getMonth() + n); else x.setFullYear(x.getFullYear() + n); return x; };
    const startOf = (d: Date, unit: string) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); if (unit === "weekly") x.setDate(x.getDate() - x.getDay()); else if (unit === "monthly") x.setDate(1); else { x.setMonth(0); x.setDate(1); } return x; };
    const label = (d: Date, unit: string) => unit === "weekly" ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : unit === "monthly" ? d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) : String(d.getFullYear());
    const end = anaTo ? new Date(`${anaTo}T12:00:00`) : new Date();
    const minIso = anaPapers.map(submittedIso).filter(Boolean).sort()[0];
    const build = (unit: string) => {
      const start = anaFrom ? startOf(new Date(`${anaFrom}T12:00:00`), unit) : anaTo ? startOf(new Date(`${minIso ?? anaTo}T12:00:00`), unit) : add(startOf(end, unit), unit, -(unit === "yearly" ? 4 : 11));
      const out: { start: Date; label: string; total: number; seg: number[] }[] = [];
      for (let d = start; d <= end && out.length < 60; d = add(d, unit, 1)) out.push({ start: d, label: label(d, unit), total: 0, seg: anaBuckets.map(() => 0) });
      return out;
    };
    let unit = chartMode;
    let bs = build(unit);
    while (bs.length > 24 && unit !== "yearly") { unit = unit === "weekly" ? "monthly" : "yearly"; bs = build(unit); }
    if (bs.length > 24) bs = bs.slice(-24);
    for (const p of anaPapers) {
      const iso = submittedIso(p); if (!iso) continue;
      const d = new Date(`${iso}T12:00:00`);
      const idx = bs.findIndex((b, i) => d >= b.start && (i === bs.length - 1 || d < bs[i + 1].start));
      if (idx >= 0) { bs[idx].total++; const ci = anaBuckets.indexOf(bucketOf(p)); if (ci >= 0) bs[idx].seg[ci]++; }
    }
    return bs;
  }, [anaPapers, chartMode, anaFrom, anaTo, collegeOptions]);
  const chartMax = Math.max(4, ...chartBuckets.map(b => b.total));
  const chartNice = Math.ceil(chartMax / 4) * 4;
  const chartTicks = [chartNice, Math.round(chartNice * 0.75), Math.round(chartNice * 0.5), Math.round(chartNice * 0.25), 0];
  const donutStyle = (() => { if (!anaPapers.length) return ""; let acc = 0; const stops = types.map((t, i) => { const start = acc; acc += ((anaTypeCounts.get(t) ?? 0) / anaPapers.length) * 100; return `${["#1f59c8", "#f18b38", "#b5cdfa", "#8e78cc"][i]} ${start}% ${acc}%`; }); return `conic-gradient(${stops.join(",")})`; })();
  const exportData = async (format: "csv" | "xlsx" | "pdf") => {
    const source = selectedRows.length ? shownPapers.filter(p => selectedRows.includes(p.id)) : shownPapers;
    const label = format === "csv" ? "CSV" : format === "xlsx" ? "Excel" : "PDF";
    if (!source.length) { toast("Nothing to export."); return; }
    if (!window.confirm(`Export ${source.length} record${source.length === 1 ? "" : "s"} as ${label}?`)) return;
    const header = ["Reference", "Classification", "Student ID", "Applicant", "Title", "Affiliation", "College", "Program", "Authors", "Type", "Status", "Date submitted", "Date filed", ...(page === "Archives" ? ["Archived reason"] : [])];
    const rows = source.map(p => [p.id, applicantLabel(p.applicantType), p.studentId, p.student, p.title, p.affiliation ?? "", p.college === "—" ? "" : p.college, p.program === "—" ? "" : p.program, p.authors.join("; "), p.type, p.status, p.submitted, p.filed, ...(page === "Archives" ? [p.archiveReason ?? "—"] : [])]);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `itso-${page === "Archives" ? "archives" : "papers"}-${stamp}`;
    if (format === "csv") {
      const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
      const csv = [header, ...rows].map(r => r.map(escape).join(",")).join("\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = `${base}.csv`; a.click();
      URL.revokeObjectURL(url);
    } else if (format === "xlsx") {
      const XLSX = await import("xlsx");
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), page === "Archives" ? "Archives" : "Papers");
      XLSX.writeFile(wb, `${base}.xlsx`);
    } else {
      const { default: jsPDF } = await import("jspdf");
      const { default: autoTable } = await import("jspdf-autotable");
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}brand/qcu-logo.png`);
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.onerror = no; r.readAsDataURL(blob); });
        doc.addImage(dataUrl, "PNG", 14, 6, 16, 16);
      } catch {}
      doc.setFontSize(13); doc.text("Quezon City University — Innovation and Technology Support Office", 34, 13);
      doc.setFontSize(11); doc.text(page === "Archives" ? "Archives" : "Papers Submitted", 34, 20);
      doc.setFontSize(9); doc.text(`Generated ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, 34, 26);
      autoTable(doc, { head: [header], body: rows, startY: 30, styles: { fontSize: 7 }, headStyles: { fillColor: [0, 35, 102], textColor: [255, 255, 255] } });
      doc.save(`${base}.pdf`);
    }
    toast(`Exported ${rows.length} record${rows.length === 1 ? "" : "s"} as ${label}.`);
  };
  const addAuthor = () => { if (authorInput.trim()) { setAuthors([...authors, { name: authorInput.trim(), email: "" }]); setAuthorInput(""); } };
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/i;
  const updatePaper = async (newStatus: string) => {
    if (!selected) return;
    if (newStatus === "Revisions Needed" && !remark.trim()) { toast("A remark is required for Revisions Needed."); return; }
    const filing = newStatus === "Submitted to IPOPHIL" ? (filingDate || selected.filedRaw || new Date().toISOString().slice(0, 10)) : "";
    if (newStatus === "Submitted to IPOPHIL" && !filing) { toast("Pick the date of filing."); return; }
    if (isSupabaseConfigured) {
      await run(async () => {
        if (remark.trim()) await dbAddRemark(selected.dbId!, remark.trim(), me!.email, true);
        await dbUpdateStatus(selected.dbId!, newStatus, filing || undefined);
        await dbLogAction("status_change", selected.id, { from: selected.status, to: newStatus, ...(filing ? { filing_date: filing } : {}) });
      }, "Status updated.");
      setPendingStatus(""); setRemark(""); setFilingDate(""); return;
    }
    const next = { ...selected, status: newStatus, history: [...(selected.history ?? [{ status: "Under Review", at: selected.submitted, initial: true }]), { status: newStatus, at: todayFmt() }], ...(filing ? { filed: fmtDate(filing), filedRaw: filing, problems: selected.problems + (selected.ser ? 0 : 1), ser: { id: selected.ser?.id ?? `local-ser-${Date.now()}`, triggered: fmtDate(filing), deadline: fmtDate(addMonthsRaw(filing, 18)), deadlineRaw: addMonthsRaw(filing, 18), status: "open" as const } } : {}) };
    if (remark.trim()) setRemarks({ ...remarks, [selected.id]: [...(remarks[selected.id] || []), { text: remark.trim(), timestamp: new Date().toLocaleDateString("en-US"), author: "ITSO Admin" }] });
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); setPendingStatus(""); setRemark(""); setFilingDate(""); toast("Status updated.");
  };
  const unarchive = (paper: Paper) => {
    if (isSupabaseConfigured) { void run(async () => { await dbUnarchive(paper.dbId!); await dbLogAction("unarchive", paper.id); }, "Paper restored to Papers Submitted."); setSelected(null); return; }
    setPapers(papers.map(p => p.id === paper.id ? { ...p, archived: false } : p)); setSelected(null); toast("Paper restored to Papers Submitted.");
  };
  const recordRemark = async () => {
    if (!selected || !generalComment.trim()) return;
    if (isSupabaseConfigured) {
      await run(async () => { await dbAddRemark(selected.dbId!, generalComment.trim(), me!.email); await dbLogAction("add_remark", selected.id); }, "Comment added to the submission log.");
      setGeneralComment(""); return;
    }
    setRemarks({ ...remarks, [selected.id]: [...(remarks[selected.id] || []), { text: generalComment.trim(), timestamp: new Date().toLocaleDateString("en-US"), author: "ITSO Admin" }] });
    setGeneralComment(""); toast("Comment added to the submission log.");
  };
  const recordDefect = async () => {
    if (!selected || !defectNotice || !defectComment.trim()) return;
    if (isSupabaseConfigured) {
      const round = defects.filter(d => d.submissionId === selected.id).length + 1;
      await run(async () => { await dbAddDefect(selected.dbId!, defectNotice, defectComment.trim(), me!.email, round); await dbLogAction("log_defect", selected.id, { notice_date: defectNotice, round, deadline: addDaysRaw(defectNotice, 60), label: defectLabel(round) }); }, "New formality defect round recorded.");
      setDefectNotice(""); setDefectComment(""); return;
    }
    const round = defects.filter(d => d.submissionId === selected.id).length + 1;
    setDefects([...defects, { id: String(Date.now()), submissionId: selected.id, noticeDate: defectNotice, deadline: addDays(defectNotice, 60), deadlineRaw: addDaysRaw(defectNotice, 60), round, details: defectComment.trim(), status: "open", comments: [{ text: defectComment.trim(), timestamp: new Date().toLocaleDateString("en-US"), author: "ITSO Admin" }] }]);
    const next = { ...selected, problems: selected.problems + 1 };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next);
    setDefectNotice(""); setDefectComment(""); toast("New formality defect round recorded.");
  };
  const resolveDefect = async (defect: Defect) => {
    if (!selected) return;
    if (isSupabaseConfigured) { await run(async () => { await dbResolveDefect(defect.id, defect.problemId); await dbLogAction("resolve_defect", selected.id); }, "Defect resolved; its history remains visible."); return; }
    setDefects(defects.map(d => d.id === defect.id ? { ...d, status: "resolved", resolvedDate: new Date().toLocaleDateString("en-US") } : d));
    const next = { ...selected, problems: Math.max(0, selected.problems - 1) };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next);
    toast("Defect resolved; its history remains visible.");
  };
  const recordFilingDate = async () => {
    if (!selected) return;
    const date = filingDate || selected.filedRaw || "";
    if (!date) return;
    if (isSupabaseConfigured) {
      await run(async () => { await dbRecordFilingDate(selected.dbId!, date); await dbLogAction("record_filing_date", selected.id, { filing_date: date }); }, "Filing date recorded; the 18-month Substantive Examination clock has started.");
      setFilingDate(""); return;
    }
    const deadlineRaw = addMonthsRaw(date, 18);
    const next = { ...selected, filed: fmtDate(date), filedRaw: date, problems: selected.problems + (selected.ser ? 0 : 1), ser: { id: selected.ser?.id ?? `local-ser-${Date.now()}`, triggered: fmtDate(date), deadline: fmtDate(deadlineRaw), deadlineRaw, status: "open" as const } };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); setFilingDate(""); toast("Filing date recorded; the 18-month Substantive Examination clock has started.");
  };
  const resolveSer = async () => {
    if (!selected?.ser || !serNote.trim()) return;
    if (isSupabaseConfigured) {
      await run(async () => { await dbResolveSer(selected.ser!.id, serNote.trim()); await dbLogAction("resolve_ser", selected.id, { note: serNote.trim() }); }, "Substantive Examination Request marked as handled.");
      setSerNote(""); return;
    }
    const next = { ...selected, ser: { ...selected.ser, status: "resolved" as const, note: serNote.trim() }, problems: Math.max(0, selected.problems - 1) };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); setSerNote(""); toast("Substantive Examination Request marked as handled.");
  };
  const issueCertificate = async () => {
    const link = certLink.trim();
    if (!selected || !link.startsWith("https://")) return;
    if (isSupabaseConfigured) {
      await run(async () => { await dbIssueCertificate(selected.dbId!, link); await dbLogAction("issue_certificate", selected.id, { link }); }, "Certificate issued.");
      setCertLink(""); return;
    }
    const next = { ...selected, status: "Approved with Certificate", certificate: { link, issued: todayFmt() }, history: [...(selected.history ?? [{ status: "Under Review", at: selected.submitted, initial: true }]), { status: "Approved with Certificate", at: todayFmt() }] };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); setCertLink(""); toast("Certificate issued.");
  };
  const replyToDefect = async (defect: Defect) => {
    const text = defectReply[defect.id]?.trim();
    if (!text) return;
    if (isSupabaseConfigured) { await run(() => dbReplyDefect(defect.id, text, me!.email), "Comment added to this defect round's log."); setDefectReply({ ...defectReply, [defect.id]: "" }); return; }
    setDefects(defects.map(d => d.id === defect.id ? { ...d, comments: [...d.comments, { text, timestamp: new Date().toLocaleDateString("en-US"), author: "ITSO Admin" }] } : d));
    setDefectReply({ ...defectReply, [defect.id]: "" }); toast("Comment added to this defect round's log.");
  };
  const decideRegistration = async (request: Registration, decision: "Approved" | "Declined") => {
    if (isSupabaseConfigured) { await run(() => dbDecideRegistration(request.id!, decision === "Approved" ? "approved" : "declined"), `Registration ${decision.toLowerCase()}.`); return; }
    setRegistrations(registrations.map(r => r.eventTitle === request.eventTitle && r.student === request.student ? { ...r, status: decision } : r));
    if (decision === "Approved") setEvents(events.map(e => e.title === request.eventTitle ? { ...e, registered: e.registered + 1 } : e));
    toast(`Registration ${decision.toLowerCase()}.`);
  };
  const requestRegistration = async (event: Event) => {
    if (isSupabaseConfigured) {
      if (!me?.studentUuid) { toast("No student profile is linked to this account yet."); return; }
      await run(() => dbRegisterEvent(event.id!, me.studentUuid!), "Registration requested. ITSO must approve it before your place is confirmed.");
      return;
    }
    setRegistrations([...registrations.filter(r => !(r.eventTitle === event.title && r.student === CURRENT_STUDENT)), { eventTitle: event.title, student: CURRENT_STUDENT, status: "Pending approval" }]);
    toast("Registration requested. ITSO must approve it before your place is confirmed.");
  };
  const resetEventForm = () => { setEditingEvent(null); setEventTitle(""); setEventType("IP Awareness"); setEventOther(""); setEventDate(""); setEventTime(""); setEventLocation(""); setEventMode("Onsite"); setEventDays("1"); setEventHours("8"); setEventParticipants([]); setEventSector([]); setEventMale("0"); setEventFemale("0"); setEventAge([]); setEventDrive(""); };
  const openEventModal = (event?: Event) => {
    if (event) {
      setEditingEvent(event); setEventTitle(event.title);
      setEventType(event.activityType === "Others" ? "Others" : event.activityType ?? event.type); setEventOther(event.activityType === "Others" ? event.activityOther ?? event.type : "");
      setEventDate(eventIso(event)); setEventTime(event.time === "—" ? "" : event.time); setEventMode(event.mode);
      setEventLocation(event.mode === "Online" ? event.venue ?? event.link ?? "" : event.venue ?? (event.place === "Online session" ? "" : event.place));
      setEventDays(String(event.durationDays ?? 1)); setEventHours(String(event.durationHours ?? 8));
      setEventParticipants(event.participantsInvolved ?? []); setEventSector(event.sector ?? []);
      setEventMale(String(event.male ?? 0)); setEventFemale(String(event.female ?? 0));
      setEventAge(event.ageRange ?? []); setEventDrive(event.drive ?? "");
    } else resetEventForm();
    setModal("event");
  };
  const eventFormInput = () => ({ title: eventTitle.trim(), type: eventType, typeOther: eventOther.trim() || undefined, mode: eventMode, date: eventDate, time: eventTime, place: eventLocation.trim(), durationDays: Math.max(1, parseInt(eventDays) || 1), durationHours: parseFloat(eventHours) || 8, participantsInvolved: eventParticipants, sector: eventSector, male: Math.max(0, parseInt(eventMale) || 0), female: Math.max(0, parseInt(eventFemale) || 0), ageRange: eventAge, drive: eventDrive.trim() || undefined });
  const eventLocalFrom = (input: ReturnType<typeof eventFormInput>, base?: Event): Event => ({ ...base, title: input.title, type: input.type === "Others" ? input.typeOther ?? "Others" : input.type, activityType: EVENT_ACTIVITY_TYPES.includes(input.type) ? input.type : "Others", activityOther: EVENT_ACTIVITY_TYPES.includes(input.type) ? undefined : input.typeOther ?? input.type, date: fmtDate(input.date), dateRaw: input.date, time: input.mode === "Online" ? "—" : input.time || "—", mode: input.mode, place: input.mode === "Online" ? "Online session" : input.place || "—", link: input.mode === "Online" ? input.place : undefined, venue: input.place, durationDays: input.durationDays, durationHours: input.durationHours, participantsInvolved: input.participantsInvolved, sector: input.sector, male: input.male, female: input.female, total: input.male + input.female, ageRange: input.ageRange, drive: input.drive, registered: base?.registered ?? 0, icon: base?.icon ?? "event", color: base?.color ?? "blue" });
  const saveEvent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (eventType === "Others" && !eventOther.trim()) return;
    if (eventDrive.trim() && !eventDrive.trim().startsWith("https://")) { toast("Drive link must start with https://"); return; }
    const input = eventFormInput();
    if (isSupabaseConfigured) {
      await run(async () => {
        if (editingEvent?.id) { await dbUpdateEvent(editingEvent.id, input); await dbLogAction("update_event", input.title); }
        else { await dbAddEvent(input); await dbLogAction("create_event", input.title); }
      }, editingEvent ? "Event updated." : "Event added.");
    } else {
      setEvents(editingEvent ? events.map(ev => ev === editingEvent ? eventLocalFrom(input, ev) : ev) : [...events, eventLocalFrom(input)]);
      toast(editingEvent ? "Event updated." : "Event added.");
    }
    resetEventForm(); setModal(null);
  };
  const deleteEvent = async (event: Event) => {
    if (!window.confirm(`Delete "${event.title}"? This cannot be undone.`)) return;
    if (isSupabaseConfigured) { await run(async () => { await dbDeleteEvent(event.id!); await dbLogAction("delete_event", event.title); }, "Event deleted."); return; }
    setEvents(events.filter(ev => ev !== event)); toast("Event deleted.");
  };
  const addAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (accounts.some(a => a.email === email)) { toast("This email is already authorized."); return; }
    if (isSupabaseConfigured) await run(() => dbAddWhitelist(email, newRole), "Account added to the whitelist.");
    else { setAccounts([...accounts, { name: "New user", email, role: newRole === "admin" ? "Admin" : "Student", status: "Active", rawRole: newRole }]); toast("Account added to the whitelist."); }
    setNewEmail(""); setNewRole("student"); setModal(null);
  };
  const setAccountStatus = async (a: Account, status: "active" | "inactive") => {
    if (status === "inactive" && !window.confirm(`Deactivate ${a.email}? They will lose workspace access.`)) return;
    if (isSupabaseConfigured) { await run(async () => { await dbSetAccountStatus(a.email, status); await dbLogAction(status === "active" ? "reactivate_account" : "deactivate_account", a.email); }, status === "active" ? "Account reactivated." : "Account deactivated."); return; }
    setAccounts(accounts.map(x => x.email === a.email ? { ...x, status: status === "active" ? "Active" : "Inactive" } : x));
    toast(status === "active" ? "Account reactivated." : "Account deactivated.");
  };
  const openEditName = (a: Account) => { setEditNameFor(a); setEnGiven(""); setEnMiddle(""); setEnFamily(""); setEnSuffix(""); setModal("name"); };
  const saveAccountName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editNameFor) return;
    const full = [enGiven, enMiddle, enFamily, enSuffix].map(s => s.trim()).filter(Boolean).join(" ");
    if (isSupabaseConfigured) await run(async () => { await dbUpdateAccountName(editNameFor.email, editNameFor.rawRole ?? "student", { given: enGiven, middle: enMiddle, family: enFamily, suffix: enSuffix }); await dbLogAction("edit_name", editNameFor.email); }, "Name updated.");
    else { setAccounts(accounts.map(x => x.email === editNameFor.email ? { ...x, name: full } : x)); toast("Name updated."); }
    setModal(null); setEditNameFor(null);
  };
  const canEditAuthors = selected ? role === "Student" && !selected.archived && (isSupabaseConfigured ? selected.ownerUuid === me?.studentUuid : true) : false;
  const addPaperAuthor = async () => {
    if (!selected || !newAuthorName.trim()) return;
    const em = newAuthorEmail.trim();
    if (em && !EMAIL_RE.test(em)) { toast("That email doesn't look right."); return; }
    if (isSupabaseConfigured) { await run(() => dbAddAuthor(selected.dbId!, newAuthorName.trim(), em || null), "Author added."); setNewAuthorName(""); setNewAuthorEmail(""); return; }
    const next = { ...selected, authors: [...selected.authors, newAuthorName.trim()], authorDetails: [...(selected.authorDetails ?? selected.authors.map(n => ({ name: n, email: null }))), { name: newAuthorName.trim(), email: em || null }] };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); setNewAuthorName(""); setNewAuthorEmail(""); toast("Author added.");
  };
  const removeAuthor = async (row: { id?: string; name: string }) => {
    if (!selected) return;
    if (isSupabaseConfigured) { await run(() => dbDeleteAuthor(row.id!), "Author removed."); return; }
    const next = { ...selected, authors: selected.authors.filter(n => n !== row.name), authorDetails: selected.authorDetails?.filter(d => d.name !== row.name) };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); toast("Author removed.");
  };
  const saveAuthorEdit = async (row: { id?: string; name: string; email: string | null }) => {
    if (!selected) return;
    const canRename = role === "Admin";
    const name = canRename ? authorEdit.trim() : row.name;
    const em = authorEmailEdit.trim();
    if (em && !EMAIL_RE.test(em)) { toast("That email doesn't look right."); return; }
    if (canRename && !name) return;
    const patch: { name?: string; email?: string | null } = {};
    if (canRename && name !== row.name) patch.name = name;
    if ((em || null) !== (row.email ?? null)) patch.email = em || null;
    if (!Object.keys(patch).length) { setEditingAuthor(null); return; }
    if (isSupabaseConfigured) { await run(async () => { if (row.id) await dbUpdateAuthor(row.id, patch); if (canRename) await dbLogAction("edit_author", selected.id, { from: row.name, to: name, ...(patch.email !== undefined ? { email: [row.email ?? "", em] } : {}) }); }, "Author updated."); setEditingAuthor(null); return; }
    const details = (selected.authorDetails ?? selected.authors.map(n => ({ id: n, name: n, email: null as string | null }))).map(d => (d.id ?? d.name) === (row.id ?? row.name) ? { ...d, name, email: em || null } : d);
    const next = { ...selected, authors: selected.authors.map(n => n === row.name ? name : n), authorDetails: details };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); setEditingAuthor(null); toast("Author updated.");
  };
  const isOwnerStudent = selected ? role === "Student" && (isSupabaseConfigured ? selected.ownerUuid === me?.studentUuid : true) : false;
  const reportBroken = async () => {
    if (!selected) return;
    if (isSupabaseConfigured) { await run(async () => { await dbReportBrokenLink(selected.dbId!, linkNote.trim()); if (role === "Admin") await dbLogAction("report_broken_link", selected.id, linkNote.trim() ? { note: linkNote.trim() } : undefined); }, "Broken link reported."); setLinkNoteOpen(false); setLinkNote(""); return; }
    const next = { ...selected, linkReport: { at: todayFmt(), note: linkNote.trim() || undefined, by: role === "Admin" ? "ITSO Admin" : "You" } };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); setLinkNoteOpen(false); setLinkNote(""); toast("Broken link reported.");
  };
  const updateDriveLink = async () => {
    const link = linkInput.trim();
    if (!selected || !link.startsWith("https://")) return;
    if (isSupabaseConfigured) { await run(() => dbUpdateMyDriveLink(selected.dbId!, link), "Drive link updated."); setLinkInput(""); return; }
    const next = { ...selected, drive: link, linkReport: undefined };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); setLinkInput(""); toast("Drive link updated.");
  };
  const clearBroken = async () => {
    if (!selected) return;
    if (isSupabaseConfigured) { await run(async () => { await dbClearBrokenLink(selected.dbId!); await dbLogAction("clear_broken_link", selected.id); }, "Report marked as resolved."); return; }
    const next = { ...selected, linkReport: undefined };
    setPapers(papers.map(p => p.id === selected.id ? next : p)); setSelected(next); toast("Report marked as resolved.");
  };
  const openUpdateInfo = () => {
    if (!me) { toast("Available when signed in"); return; }
    const prog = me.programId != null ? dbProgramById[me.programId] : undefined;
    const myClass = me.applicantType ?? "student";
    setPfGiven(me.givenName ?? ""); setPfMiddle(me.middleName ?? ""); setPfFamily(me.familyName ?? ""); setPfSuffix(me.suffix ?? "");
    setPfType(myClass); setPfAffil(me.affiliation ?? "");
    setPfStudentId(me.studentIdNumber ?? ""); setPfCollege(myClass === "student" ? (prog?.college ?? "") : (me.collegeId != null ? dbCollegeById[me.collegeId] ?? "" : "")); setPfProgram(prog?.name ?? "");
    setPfError(""); setModal("profile"); setAvatarOpen(false);
  };
  const saveUpdateInfo = async (e: React.FormEvent) => {
    e.preventDefault(); setPfError("");
    if (me?.role === "Student" && pfType === "student" && pfStudentId && !/^\d{2}-\d{4}$/.test(pfStudentId)) { setPfError("Student ID must use the format 22-0145."); return; }
    if (me?.role === "Student" && pfType !== "student" && !pfAffil.trim()) { setPfError(pfType === "staff" ? "Office / department is required." : "Organization / institution is required."); return; }
    setPfBusy(true);
    try {
      await dbUpdateMyProfile({ given: pfGiven, middle: pfMiddle, family: pfFamily, suffix: pfSuffix, applicantType: me?.role === "Student" ? pfType : undefined, studentIdNumber: me?.role === "Student" && pfType === "student" ? pfStudentId || undefined : undefined, programName: me?.role === "Student" && pfType === "student" ? pfProgram : undefined, collegeName: me?.role === "Student" && pfType === "staff" ? pfCollege || undefined : undefined, affiliation: me?.role === "Student" && pfType !== "student" ? pfAffil : undefined });
      const u = await getSessionUser();
      if (u) { setMe(u); await refresh(u.role ?? role, u.studentUuid, u.email); }
      setModal(null); toast("Your information was updated.");
    } catch (err) { setPfError((err as { message?: string })?.message ?? "Could not update your information."); }
    setPfBusy(false);
  };
  const signOut = () => {
    if (isSupabaseConfigured) void dbSignOut();
    setSession(null); setMe(null); setPage("Overview"); setSelected(null);
  };
  const submitPaper = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formApplicant === "student" && formStudentId && !/^\d{2}-\d{4}$/.test(formStudentId)) { toast("Student ID must use the format 22-0145."); return; }
    if (formApplicant !== "student" && !formAffil.trim()) { toast(formApplicant === "staff" ? "Enter your office or department." : "Enter your organization or institution."); return; }
    if (!authors.length) { toast("Add at least one author."); return; }
    const badEmail = authors.find(a => a.email.trim() && !EMAIL_RE.test(a.email.trim()));
    if (badEmail) { toast(`"${badEmail.email.trim()}" doesn't look like a valid email.`); return; }
    if (isSupabaseConfigured) {
      if (!me?.studentUuid) { toast("No student profile is linked to this account. Ask ITSO to create one."); return; }
      await run(() => dbSubmitPaper({ studentUuid: me.studentUuid!, title: formTitle.trim(), studentIdNumber: formApplicant === "student" ? formStudentId || undefined : undefined, college: formApplicant === "external" ? undefined : formCollege || undefined, program: formApplicant === "student" ? formProgram || undefined : undefined, applicantType: formApplicant, affiliation: formApplicant === "student" ? undefined : formAffil.trim(), type: formType, drive: formDrive, authors: authors.map(a => ({ name: a.name, email: a.name === me?.fullName ? null : a.email.trim() || null })) }), "Submission added.");
      setModal(null); setFormTitle(""); setFormCollege(""); setFormProgram(""); setFormType(""); setFormDrive(""); setAuthors([]); setFormStudentId(""); setConfirmed(false); setPage("My Submissions");
      return;
    }
    const paper: Paper = { id: `ITSO-2025-${String(85 + papers.length - initialPapers.length).padStart(4, "0")}`, title: formTitle.trim(), studentId: formApplicant === "student" ? formStudentId : "", student: CURRENT_STUDENT, program: formApplicant === "student" ? formProgram : "", college: formApplicant === "external" ? "" : formCollege, applicantType: formApplicant, affiliation: formApplicant === "student" ? undefined : formAffil.trim(), authors: authors.map(a => a.name), type: formType, status: "Under Review", submitted: "Today", filed: "—", problems: 0, drive: formDrive, authorDetails: authors.map(a => ({ name: a.name, email: a.name === me?.fullName ? null : a.email.trim() || null })) };
    setPapers([paper, ...papers]); setModal(null); setFormTitle(""); setFormCollege(""); setFormProgram(""); setFormType(""); setFormDrive(""); setAuthors([]); setFormStudentId(""); setConfirmed(false); toast("Submission added."); setPage("My Submissions");
  };
  const nav: { group: string; items: { label: Page; icon: string }[] }[] = role === "Admin" ? [
    { group: "WORKSPACE", items: [{ label: "Overview", icon: "space_dashboard" }, { label: "Papers Submitted", icon: "description" }, { label: "Analytics", icon: "monitoring" }] },
    { group: "MANAGEMENT", items: [{ label: "Events", icon: "calendar_month" }, { label: "Archives", icon: "inventory_2" }, { label: "Security", icon: "admin_panel_settings" }] },
  ] : [{ group: "MY WORKSPACE", items: [{ label: "Overview", icon: "space_dashboard" }, { label: "My Submissions", icon: "description" }, { label: "Events", icon: "calendar_month" }] }];

  const paperTable = (rows: Paper[], compact = false) => <div className={compact ? "table-wrap" : "table-wrap scroll"}><table><thead><tr>
    {!compact && role === "Admin" && <th className="check-col"><input type="checkbox" aria-label="Select all visible papers" checked={rows.length > 0 && rows.every(p => selectedRows.includes(p.id))} onChange={e => setSelectedRows(e.target.checked ? rows.map(p => p.id) : [])} /></th>}
    <th>REFERENCE / PAPER</th><th>STUDENT & AUTHORS</th><th>TYPE</th><th>STATUS</th><th>FORMALITY DEFECT</th><th>{page === "Archives" ? "ARCHIVED" : "DATE FILED"}</th><th aria-label="Actions" />
  </tr></thead><tbody>{rows.map(p => {
    const hasOpenDefect = defects.some(d => d.submissionId === p.id && d.status === "open");
    return <tr key={p.id}>{!compact && role === "Admin" && <td><input type="checkbox" aria-label={`Select ${p.id}`} checked={selectedRows.includes(p.id)} onChange={e => setSelectedRows(e.target.checked ? [...selectedRows, p.id] : selectedRows.filter(id => id !== p.id))} /></td>}
      <td><div className="ref">{p.id}</div><button className="table-title" onClick={() => { setSelected(p); setPendingStatus(p.status); setFilingDate(""); setSerNote(""); setCertLink(""); setLinkNoteOpen(false); setLinkInput(""); }}>{p.title}</button><div className="cell-muted">{paperSubline(p)}{p.problems > 0 && <span className="problem-inline"><Icon name="error" size={14} /> {p.problems} open problem{p.problems > 1 ? "s" : ""}</span>}{p.linkReport && <span className="problem-inline link-warn" title="Drive link reported broken"><Icon name="link_off" size={14} /></span>}</div></td>
      <td><div className="cell-main">{p.student} <span className="cell-id">{p.studentId}</span></div><div className="cell-muted">{p.authors.join(", ")}</div></td><td><span className="type-pill">{p.type}</span></td><td><Status value={p.status} /></td>
      <td><span className={`defect-indicator ${hasOpenDefect ? "warning" : "clear"}`}>{p.type === "Copyright" ? "N/A" : <><Icon name={hasOpenDefect ? "warning" : "check_circle"} size={16} />{hasOpenDefect ? "Open defect" : "No open defect"}</>}</span></td>
      <td><span className="date-cell">{page === "Archives" ? "Oct 12, 2025" : p.filed}{page !== "Archives" && p.ser?.status === "open" && <small className="ser-due">SER due {p.ser.deadline}</small>}</span></td><td><button className="icon-button row-arrow" aria-label={`View ${p.title}`} onClick={() => { setSelected(p); setPendingStatus(p.status); setFilingDate(""); setSerNote(""); setCertLink(""); setLinkNoteOpen(false); setLinkInput(""); }}><Icon name="arrow_forward" size={19} /></button></td>
    </tr>;
  })}</tbody></table>{!rows.length && <div className="empty-state"><Icon name="search_off" size={30} /><strong>No papers found</strong><span>Try changing your filters or search.</span></div>}</div>;

  const filterPanel = <div className="filter-panel"><div className="filter-title"><Icon name="tune" size={18} /> Filters <span>Refine your results</span></div><div className="filter-grid"><label>College<select value={college} onChange={e => { setCollege(e.target.value); setProgram(""); }}><option value="">All colleges</option>{collegeOptions.map(c => <option key={c}>{c}</option>)}<option value="__staff">QCU Faculty / Staff</option><option value="__external">External (Non-QCU)</option></select></label><label>Program<select value={program} onChange={e => setProgram(e.target.value)} disabled={!college || college.startsWith("__")}><option value="">All programs</option>{(programOptions[college] || []).map(p => <option key={p}>{p}</option>)}</select></label><label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{statuses.map(s => <option key={s}>{s}</option>)}</select></label><label>Filing type<select value={type} onChange={e => setType(e.target.value)}><option value="">All types</option>{types.map(t => <option key={t}>{t}</option>)}</select></label><label>Filed from<input type="date" value={filedFrom} onChange={e => setFiledFrom(e.target.value)} /></label><label>Filed to<input type="date" value={filedTo} onChange={e => setFiledTo(e.target.value)} /></label><button className="clear-btn" onClick={() => { setCollege(""); setProgram(""); setStatus(""); setType(""); setSearch(""); setFiledFrom(""); setFiledTo(""); }}>Clear all</button></div></div>;

  if (isSupabaseConfigured && !authChecked) return <div className="app-loading"><span className="google-spinner" /> Loading workspace…</div>;
  if (authError) return <main className="login-page"><section className="login-story"><div className="login-brand"><span className="brand-logos"><img src={`${import.meta.env.BASE_URL}brand/qcu-logo.png`} alt="Quezon City University seal" /><img className="itso" src={`${import.meta.env.BASE_URL}brand/itso-logo.jpg`} alt="ITSO logo" /></span><span><strong>QCU <em>ITSO</em></strong><small>Innovation and Technology Support Office</small></span></div><div className="login-story-content"><span className="login-kicker"><span /> QUEZON CITY UNIVERSITY · INNOVATION AND TECHNOLOGY SUPPORT OFFICE</span><h1>Access is by<br /><em>invitation.</em></h1><p>Only emails authorized by the ITSO office can enter the workspace.</p><div className="login-story-rule" /><div className="login-story-foot"><span className="material-symbols-outlined">lock_person</span> Request access at the ITSO office.</div></div><div className="login-decor login-ring-one" /><div className="login-decor login-ring-two" /><div className="login-orb"><span className="material-symbols-outlined">lock_person</span></div><div className="login-bottom">© {new Date().getFullYear()} Quezon City University · Innovation and Technology Support Office</div></section><section className="login-form-side"><div className="login-form-wrap"><div className="login-eyebrow">ACCESS DENIED</div><h2>Not authorized<span>.</span></h2><p className="login-subtitle">{authError} isn't on the ITSO whitelist. Please contact the ITSO office to request access.</p><div className="contact-card"><Icon name="mail" size={22} /><div><strong>Contact ITSO</strong><span>{ITSO_EMAIL}</span></div><button type="button" className="secondary-button" onClick={() => void copyItsoEmail().then(ok => { setEmailCopied(ok); window.setTimeout(() => setEmailCopied(false), 2500); })}><Icon name={emailCopied ? "check" : "content_copy"} size={17} /> {emailCopied ? "Copied!" : "Copy email"}</button></div><button className="primary-button full" onClick={() => { setAuthError(""); void dbSignOut(); }}>Sign out & try another account <Icon name="arrow_forward" size={18} /></button></div></section></main>;
  if (!session) return <LoginScreen onEnter={chosen => { setRole(chosen); setSession(chosen); setPage("Overview"); }} />;
  if (me && !me.profileCompleted) return <main className="login-page"><section className="login-story"><div className="login-brand"><span className="brand-logos"><img src={`${import.meta.env.BASE_URL}brand/qcu-logo.png`} alt="Quezon City University seal" /><img className="itso" src={`${import.meta.env.BASE_URL}brand/itso-logo.jpg`} alt="ITSO logo" /></span><span><strong>QCU <em>ITSO</em></strong><small>Innovation and Technology Support Office</small></span></div><div className="login-story-content"><span className="login-kicker"><span /> QUEZON CITY UNIVERSITY · INNOVATION AND TECHNOLOGY SUPPORT OFFICE</span><h1>One last<br /><em>step.</em></h1><p>Enter your name exactly as it appears on your government-issued ID. ITSO uses it on IPOPHL filings and certificates.</p><div className="login-story-rule" /><div className="login-story-foot"><span className="material-symbols-outlined">verified_user</span> Sign in&nbsp;✓&nbsp;·&nbsp;Legal name&nbsp;→&nbsp;Workspace</div></div><div className="login-decor login-ring-one" /><div className="login-decor login-ring-two" /><div className="login-orb"><span className="material-symbols-outlined">badge</span></div><div className="login-bottom">© {new Date().getFullYear()} Quezon City University · Innovation and Technology Support Office</div></section><section className="login-form-side"><div className="login-form-wrap"><div className="login-eyebrow">WELCOME TO QCU ITSO</div><h2>Tell us your legal name<span>.</span></h2><p className="login-subtitle">Signed in as {me.email} · <button className="ob-signout" type="button" onClick={signOut}>Not you? Sign out</button></p><form onSubmit={completeOnboarding}><div className="ob-section">Legal name</div><div className="form-grid"><label className="field-label">Given name<input required value={obGiven} onChange={e => setObGiven(e.target.value)} placeholder="e.g. Juan" /></label><label className="field-label">Middle name<input value={obMiddle} onChange={e => setObMiddle(e.target.value)} placeholder="Optional" /></label><label className="field-label">Family name<input required value={obFamily} onChange={e => setObFamily(e.target.value)} placeholder="e.g. Dela Cruz" /></label><label className="field-label">Suffix<input value={obSuffix} onChange={e => setObSuffix(e.target.value)} placeholder="Optional, e.g. Jr., III" /></label></div>{me.role === "Student" && <><div className="ob-section">I am a…</div><div className="class-cards">{([["student", "school", "QCU Student", "Enrolled in a QCU program"], ["staff", "badge", "QCU Faculty / Staff", "QCU employee or office"], ["external", "public", "External (Non-QCU)", "Outside organization or individual"]] as [ApplicantType, string, string, string][]).map(([v, icon, label, sub]) => <button type="button" key={v} className={`class-card ${obType === v ? "on" : ""}`} onClick={() => setObType(v)}><Icon name={icon} size={22} /><strong>{label}</strong><small>{sub}</small></button>)}</div>{obType === "student" ? <><div className="ob-section">Student details</div><div className="form-grid"><label className="field-label span-two">Student ID number (optional)<input pattern="[0-9]{2}-[0-9]{4}" title="Use the format 22-0145" placeholder="e.g. 22-0145" value={obStudentId} onChange={e => setObStudentId(e.target.value)} /></label><label className="field-label">College<select required value={obCollege} onChange={e => { setObCollege(e.target.value); setObProgram(""); }}><option value="">Select college</option>{collegeOptions.map(c => <option key={c}>{c}</option>)}</select></label><label className="field-label">Program<select required value={obProgram} disabled={!obCollege} onChange={e => setObProgram(e.target.value)}><option value="">Select program</option>{(programOptions[obCollege] || []).map(p => <option key={p}>{p}</option>)}</select></label></div></> : obType === "staff" ? <><div className="ob-section">Employment details</div><div className="form-grid"><label className="field-label span-two">Office / Department<input required placeholder="e.g. ITSO, Registrar's Office" value={obAffil} onChange={e => setObAffil(e.target.value)} /></label><label className="field-label span-two">College (optional)<select value={obCollege} onChange={e => setObCollege(e.target.value)}><option value="">None / Not college-based</option>{collegeOptions.map(c => <option key={c}>{c}</option>)}</select></label></div></> : <><div className="ob-section">Organization details</div><div className="form-grid"><label className="field-label span-two">Organization / Institution<input required placeholder="e.g. company, school, or 'Independent inventor'" value={obAffil} onChange={e => setObAffil(e.target.value)} /></label></div></>}</>}{[obGiven, obMiddle, obFamily, obSuffix].some(x => x.trim()) && <div className="ob-preview">You’ll appear as: <strong>{[obGiven, obMiddle, obFamily, obSuffix].map(x => x.trim()).filter(Boolean).join(" ")}</strong></div>}{obError && <div className="login-message"><Icon name="error" size={18} /><span>{obError}</span></div>}<button className="primary-button full" type="submit" disabled={obBusy}>{obBusy ? "Saving…" : "Save and continue"} <Icon name="arrow_forward" size={18} /></button></form></div></section></main>;

  return <div className="app-shell">
    {mobileNav && <div className="mobile-scrim" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
      <div className="brand"><div className="brand-logos"><img src={`${import.meta.env.BASE_URL}brand/qcu-logo.png`} alt="Quezon City University seal" /><img className="itso" src={`${import.meta.env.BASE_URL}brand/itso-logo.jpg`} alt="ITSO logo" /></div><div><div className="brand-name">QCU <span>ITSO</span></div><div className="brand-caption">Innovation and Technology Support Office</div></div></div>
      <div className="workspace-chip"><span className="workspace-icon"><Icon name="grid_view" size={19} /></span><span><strong>ITSO Workspace</strong><small>{role === "Admin" ? "Administration portal" : "Student portal"}</small></span><Icon name="unfold_more" size={17} /></div>
      <nav aria-label="Main navigation">{nav.map(group => <div className="nav-group" key={group.group}><div className="nav-label">{group.group}</div>{group.items.map(item => <button key={item.label} className={`nav-link ${page === item.label ? "active" : ""}`} onClick={() => go(item.label)}><Icon name={item.icon} size={21} /><span>{item.label}</span>{item.label === "Papers Submitted" && <span className="nav-count">{active.length}</span>}</button>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><Icon name="support_agent" size={18} /></div><strong>Need a hand?</strong><p>Get support with your IP filing journey.</p><button onClick={() => void copyItsoEmail().then(ok => toast(ok ? `ITSO's email address (${ITSO_EMAIL}) was copied to your clipboard.` : `Email ITSO at ${ITSO_EMAIL}`))} title={`Copy ${ITSO_EMAIL}`}>Contact ITSO <Icon name="arrow_outward" size={16} /></button></div><div className="sidebar-footer">© {new Date().getFullYear()} Quezon City University · ITSO</div></div>
    </aside>
    <div className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open menu"><Icon name="menu" /></button><div className="breadcrumb">Workspace <Icon name="chevron_right" size={16} /> <strong>{page}</strong></div></div><div className="topbar-right">{!me && <button className="role-switch" onClick={changeRole} title="Switch role"><Icon name="swap_horiz" size={17} /> {role} view</button>}<div className="topbar-divider" /><div className="notif-wrap"><button className="icon-button notification-button" aria-label="Notifications" onClick={() => me ? setNotifOpen(o => !o) : toast("You're all caught up.")}><Icon name="notifications" size={21} />{unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}</button>{notifOpen && <><div className="notif-scrim" onClick={() => setNotifOpen(false)} /><div className="notif-panel"><div className="notif-head"><strong>Notifications</strong>{unread > 0 && <button className="notif-clear" onClick={markAllRead}>Mark all as read</button>}</div><div className="notif-list">{notifications.length ? notifications.map(n => <button key={n.id} className={`notif-item ${n.read ? "" : "unread"}`} onClick={() => openNotification(n)}><p>{n.message}</p><time>{n.at}</time></button>) : <div className="notif-empty"><Icon name="notifications_none" size={24} />You're all caught up.</div>}</div></div></>}</div><div className="avatar-wrap"><button className="avatar avatar-btn" aria-label="Account menu" onClick={() => setAvatarOpen(o => !o)}>{avatarInitials}</button>{avatarOpen && <><div className="notif-scrim" onClick={() => setAvatarOpen(false)} /><div className="avatar-menu"><div className="avatar-menu-head"><strong>{me?.fullName ?? (role === "Admin" ? "Admin" : "Student")}</strong><small>{me?.email ?? "Offline preview"}</small><span className="type-pill">{me?.isSuper ? "Super admin" : me?.role ?? role}</span></div><button className="avatar-item" onClick={() => { setAvatarOpen(false); me ? openUpdateInfo() : toast("Available when signed in"); }}><Icon name="badge" size={18} /> Update information</button><button className="avatar-item" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "light_mode" : "dark_mode"} size={18} /> {theme === "dark" ? "Light mode" : "Dark mode"}</button><button className="avatar-item" onClick={signOut}><Icon name="logout" size={18} /> Sign out</button></div></>}</div></div></header>
      <main className="content">
        {page === "Overview" && <>
          <div className="welcome-line"><div><div className="eyebrow">{role === "Admin" ? "ADMIN DASHBOARD" : myType === "student" ? "STUDENT DASHBOARD" : "APPLICANT DASHBOARD"} <span className="eyebrow-line" /></div><h1>{greeting}, {displayName}<span className="orange-period">.</span></h1><p>Here’s what’s happening at your intellectual property office today.</p></div><div className="date-badge"><Icon name="calendar_today" size={18} /> {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div></div>
          <div className="hero"><div className="hero-content"><div className="hero-tag"><span /> QCU INNOVATION HUB</div><h2>Ideas worth protecting.<br /><em>Impact worth creating.</em></h2><p>From your first idea to your final certificate, we make the intellectual property journey easier to navigate.</p><button className="hero-button" onClick={() => role === "Admin" ? go("Papers Submitted") : openInstructions("submit")}>{role === "Admin" ? "Review submissions" : "Submit a paper"}<Icon name="arrow_forward" size={19} /></button></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="hero-glow" /><div className="hero-emblem"><Icon name="lightbulb" size={92} /></div><div className="float-symbol float-one"><Icon name="verified" size={25} /></div><div className="float-symbol float-two"><Icon name="draw" size={25} /></div><div className="float-symbol float-three"><Icon name="auto_awesome" size={22} /></div></div></div>
          <div className="overview-heading"><div><div className="eyebrow">AT A GLANCE</div><h2>Workspace overview</h2></div><span className="overview-caption">A quick snapshot of what matters most</span></div>
          <div className="stats-grid">{role === "Admin" ? <><Stat icon="description" label="Total submissions" value={String(active.length).padStart(2, "0")} note="Active research filings" /><Stat icon="verified" label="Approved papers" value={String(active.filter(p => p.status === "Approved with Certificate").length).padStart(2, "0")} note="Certificates issued" tone="green" /><Stat icon="hourglass_top" label="Pending review" value={String(active.filter(p => ["Paper Submitted", "Under Review"].includes(p.status)).length).padStart(2, "0")} note="In the review pipeline" tone="purple" /><Stat icon="error_outline" label="Action required" value={String(actionCount).padStart(2, "0")} note="Open problems to resolve" tone="orange" /></> : <><Stat icon="description" label="My submissions" value={String(myPapers.length).padStart(2, "0")} note="Papers in your workspace" /><Stat icon="hourglass_top" label="In progress" value={String(myPapers.filter(p => !["Approved with Certificate", "Withdrawn", "Disapproved"].includes(p.status)).length).padStart(2, "0")} note="Currently under review" tone="purple" /><Stat icon="verified" label="Certificates" value={String(myPapers.filter(p => p.certificate || p.status === "Approved with Certificate").length).padStart(2, "0")} note="Issued certificates" tone="green" /><Stat icon="event" label="Upcoming events" value={String(events.filter(e => eventIso(e) >= new Date().toISOString().slice(0, 10)).length).padStart(2, "0")} note="Explore and register" tone="orange" /></>}</div>
          <div className="overview-columns"><div className="panel quick-access"><div className="panel-heading"><div><div className="eyebrow">YOUR SHORTCUTS</div><h3>What would you like to do?</h3></div><span className="heading-symbol"><Icon name="arrow_outward" size={19} /></span></div><div className="shortcut-list">{(role === "Admin" ? [
            { icon: "fact_check", title: "Review papers submitted", text: "Track filings, update statuses, and handle open problems.", target: "Papers Submitted" as Page, tone: "blue" },
            { icon: "monitoring", title: "Explore analytics", text: "See research trends and activity at a glance.", target: "Analytics" as Page, tone: "orange" },
            { icon: "calendar_month", title: "Manage events", text: "Organize activities and student registrations.", target: "Events" as Page, tone: "purple" },
            { icon: "shield_person", title: "Manage access", text: "Maintain the student whitelist and account roles.", target: "Security" as Page, tone: "green" },
          ] : [
            { icon: "upload_file", title: "Submit a paper", text: "Start a new intellectual property filing.", target: "My Submissions" as Page, tone: "blue" },
            { icon: "track_changes", title: "Track my submissions", text: "Follow status updates, feedback, and deadlines.", target: "My Submissions" as Page, tone: "orange" },
            { icon: "event", title: "View upcoming events", text: "Learn, connect, and register for ITSO activities.", target: "Events" as Page, tone: "purple" },
            { icon: "folder_shared", title: "Document sharing instructions", text: "Make sure ITSO can access your Drive folder.", target: "Overview" as Page, tone: "green" },
          ]).map((item, i) => <button className="shortcut" key={item.title} onClick={() => role === "Student" && (i === 0 || i === 3) ? openInstructions(i === 0 ? "submit" : "read") : go(item.target)}><span className={`shortcut-icon ${item.tone}`}><Icon name={item.icon} size={23} /></span><span className="shortcut-copy"><strong>{item.title}</strong><small>{item.text}</small></span><Icon name="arrow_forward" size={19} /></button>)}</div></div>
          <div className="side-panels"><div className="panel about-panel"><div className="panel-heading"><div><div className="eyebrow">GET TO KNOW US</div><h3>What is ITSO?</h3></div><span className="about-mark"><Icon name="tips_and_updates" size={21} /></span></div><p>The Intellectual Property & Technology Support Office helps turn student ideas into protected innovations. We connect QCU creators with IPOPHIL and guide every filing from submission to certificate.</p><div className="about-footer"><span className="orange-dash" /> Your ideas, our mission.</div></div><div className="panel activity-panel"><div className="panel-heading"><div><div className="eyebrow">LATEST UPDATES</div><h3>Recent activity</h3></div><button className="text-link" onClick={() => go(role === "Admin" ? "Papers Submitted" : "My Submissions")}>View all <Icon name="arrow_forward" size={16} /></button></div><div className="activity-list">{activityItems.length ? activityItems.map((item, i) => { const info = activityInfo(item.status, item.initial); return <div className="activity-item clickable" key={i} onClick={() => { setSelected(item.paper); setPendingStatus(item.paper.status); }}><span className={`activity-icon ${info.tone}`}><Icon name={info.icon} size={18} /></span><div><strong>{info.label}</strong><p>{item.paper.title.length > 40 ? `${item.paper.title.slice(0, 40)}…` : item.paper.title}</p></div><time>{relTime(item.at)}</time></div>; }) : me ? <div className="activity-item"><div><strong>No activity yet.</strong></div></div> : <><div className="activity-item"><span className="activity-icon blue"><Icon name="description" size={18} /></span><div><strong>New paper submitted</strong><p>Smart Waste Segregation System</p></div><time>2h ago</time></div><div className="activity-item"><span className="activity-icon orange"><Icon name="edit_note" size={18} /></span><div><strong>Revisions requested</strong><p>Adaptive Learning Platform</p></div><time>1d ago</time></div><div className="activity-item"><span className="activity-icon green"><Icon name="workspace_premium" size={18} /></span><div><strong>Certificate issued</strong><p>Digital Financial Literacy Toolkit</p></div><time>3d ago</time></div></>}</div></div></div></div>
          <div className="panel recent-panel"><div className="panel-heading"><div><div className="eyebrow">RECENT FILINGS</div><h3>{role === "Admin" ? "Latest submissions" : "Your submissions"}</h3></div><button className="text-link" onClick={() => go(role === "Admin" ? "Papers Submitted" : "My Submissions")}>View all papers <Icon name="arrow_forward" size={16} /></button></div>{paperTable(role === "Admin" ? active.slice(0, 3) : active.filter(p => isSupabaseConfigured ? p.ownerUuid === me?.studentUuid : p.student === CURRENT_STUDENT), true)}</div>
        </>}
        {(page === "Papers Submitted" || page === "My Submissions" || page === "Archives") && <>
          <SectionHeader eyebrow={page === "Archives" ? "RECORDS / ARCHIVES" : "RESEARCH / FILINGS"} title={page} description={page === "Archives" ? "Browse completed and inactive records stored for long-term reference." : role === "Admin" ? "Manage, review, and track every intellectual property filing in one place." : "Follow your papers from submission to certificate."} action={page === "My Submissions" ? <button className="primary-button" onClick={() => openInstructions("submit")}><Icon name="add" size={18} /> New submission</button> : page === "Archives" ? <span className="page-pill"><Icon name="lock" size={15} /> Read-only records</span> : null} />
          {page === "Papers Submitted" && <div className="mini-stats"><div><span>Total submitted</span><strong>{active.length}</strong><Icon name="description" /></div><div><span>Total approved</span><strong>{active.filter(p => p.status === "Approved with Certificate").length}</strong><Icon name="verified" /></div><div><span>Total pending</span><strong>{active.filter(p => ["Paper Submitted", "Under Review"].includes(p.status)).length}</strong><Icon name="hourglass_top" /></div><div><span>Action required</span><strong>{actionCount}</strong><Icon name="error_outline" /></div></div>}
          {page !== "My Submissions" && filterPanel}
          <div className="panel listing-panel"><div className="listing-toolbar"><div><h3>{page === "Archives" ? "Archived papers" : page === "My Submissions" ? "My papers" : "All papers"} <span className="count-pill">{shownPapers.length}</span></h3><p>{page === "Archives" ? "Historical filings kept for your records" : "Showing the latest filing activity"}</p></div>
          {page !== "My Submissions" && <div className="toolbar-actions"><div className="search-field"><Icon name="search" size={19} /><input aria-label="Search papers" placeholder="Search papers..." value={search} onChange={e => setSearch(e.target.value)} /></div><select className="export-select" aria-label="Export records" value="" onChange={e => { const f = e.target.value; e.target.value = ""; if (f) void exportData(f as "csv" | "xlsx" | "pdf"); }}><option value="" disabled>Export…</option><option value="csv">Export as CSV</option><option value="xlsx">Export as Excel</option><option value="pdf">Export as PDF</option></select></div>}</div>
          {paperTable(shownPapers)}<div className="table-footer">Showing {shownPapers.length} of {page === "Archives" ? archived.length : role === "Admin" ? active.length : active.filter(p => isSupabaseConfigured ? p.ownerUuid === me?.studentUuid : p.student === CURRENT_STUDENT).length} records <span>Live workspace data</span></div></div>
        </>}
        {page === "Analytics" && <><SectionHeader eyebrow="INSIGHTS / REPORTING" title="Analytics" description="Understand the ideas, people, and progress behind QCU innovation." action={<div className="toolbar-actions"><input className="month-filter" type="date" aria-label="From date" value={anaFrom} onChange={e => setAnaFrom(e.target.value)} /><input className="month-filter" type="date" aria-label="To date" value={anaTo} onChange={e => setAnaTo(e.target.value)} />{(anaFrom || anaTo) && <button className="clear-btn" onClick={() => { setAnaFrom(""); setAnaTo(""); }}>Clear</button>}</div>} /><div className="stats-grid"><Stat icon="description" label="Total researches" value={String(anaPapers.length).padStart(2, "0")} note="Filings in the selected period" /><Stat icon="category" label="Most common type" value={anaTopType} note="Across all submissions" tone="purple" /><Stat icon="school" label="Top college" value={anaTopCollege} note="By submission volume" tone="orange" /><Stat icon="update" label="Recent activity" value={anaLatest} note="Since latest filing" tone="green" /></div><div className="analytics-grid"><div className="panel chart-panel"><div className="panel-heading"><div><div className="eyebrow">FILING TRENDS</div><h3>Submissions over time</h3></div><span className="seg-control">{(["weekly", "monthly", "yearly"] as const).map(m => <button key={m} type="button" className={chartMode === m ? "on" : ""} onClick={() => setChartMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}</span></div>{anaPapers.length ? <div className="chart-area"><div className="gridlines">{chartTicks.map(t => <span key={t}>{t}</span>)}</div><div className="bars">{chartBuckets.map((b, i) => <div className="bar-column" key={i}><div className="bar-stack" style={{ height: `${b.total ? Math.max(3, (b.total / chartNice) * 100) : 0}%` }}>{b.seg.map((n, ci) => n > 0 && <span key={ci} style={{ height: `${(n / b.total) * 100}%`, background: COLLEGE_COLORS[ci % COLLEGE_COLORS.length], display: "block", width: "100%" }} />)}</div><small>{b.label}</small></div>)}</div></div> : <p className="chart-empty">No submissions in this period</p>}<div className="chart-legend">{anaBuckets.map((c, i) => <span key={c}><i style={{ background: COLLEGE_COLORS[i % COLLEGE_COLORS.length] }} />{c}</span>)}</div></div><div className="panel breakdown-panel"><div className="panel-heading"><div><div className="eyebrow">BY CATEGORY</div><h3>Filing types</h3></div><Icon name="donut_large" size={20} /></div><div className={`donut${anaPapers.length ? "" : " empty"}`} style={donutStyle ? { background: donutStyle } : undefined}><div><strong>{anaPapers.length}</strong><span>Total filings</span></div></div><div className="breakdown-list">{types.map((t, i) => <div key={t}><span><i className={`legend-${["blue", "orange", "light", "purple"][i]}`} />{t}</span><div className="type-bar"><i style={{ width: `${anaPapers.length ? ((anaTypeCounts.get(t) ?? 0) / anaPapers.length) * 100 : 0}%` }} /></div><strong>{anaTypeCounts.get(t) ?? 0}</strong></div>)}</div></div></div><div className="panel college-panel"><div className="panel-heading"><div><div className="eyebrow">INSTITUTIONAL REACH</div><h3>Submissions by college</h3></div></div>{anaPapers.length ? anaBuckets.map(c => ({ c, n: anaCollegeCounts.get(c) ?? 0 })).sort((a, b) => b.n - a.n).map(({ c, n }) => <div className="college-row" key={c}><span>{c}</span><div><i style={{ width: `${anaMaxCollege ? (n / anaMaxCollege) * 100 : 0}%` }} /></div><strong>{n}</strong></div>) : <p className="chart-empty">No submissions in this period</p>}</div><div className="panel activity-panel ana-activity"><div className="panel-heading"><div><div className="eyebrow">LATEST UPDATES</div><h3>Recent activity</h3></div></div><div className="activity-list">{anaActivity.length ? anaActivity.map((item, i) => { const info = activityInfo(item.status, item.initial); return <div className="activity-item clickable" key={i} onClick={() => { setSelected(item.paper); setPendingStatus(item.paper.status); }}><span className={`activity-icon ${info.tone}`}><Icon name={info.icon} size={18} /></span><div><strong>{info.label}</strong><p>{item.paper.title.length > 40 ? `${item.paper.title.slice(0, 40)}…` : item.paper.title}</p></div><time>{relTime(item.at)}</time></div>; }) : <div className="activity-item"><div><strong>No submissions in this period</strong></div></div>}</div></div></>}
        {page === "Events" && <>
          <SectionHeader eyebrow="COMMUNITY / ACTIVITIES" title="Events & activities" description={role === "Admin" ? "Create activities and review student registration requests." : "Discover upcoming workshops and request a place at an ITSO event."} action={role === "Admin" ? <button className="primary-button" onClick={() => openEventModal()}><Icon name="add" size={19} /> Add new event</button> : null} />
          <div className="event-banner"><div><span>LEARN. CONNECT. CREATE.</span><h3>Innovation starts with a conversation.</h3><p>Explore events designed to help ideas grow into real-world impact.</p></div><Icon name="campaign" size={92} /></div>
          {role === "Admin" && <div className="mini-stats three"><div><span>Total events</span><strong>{events.length}</strong><Icon name="event" /></div><div><span>Upcoming events</span><strong>{events.filter(e => eventIso(e) >= new Date().toISOString().slice(0, 10)).length}</strong><Icon name="event_available" /></div><div><span>Total participants</span><strong>{events.reduce((n, e) => n + (e.total ?? 0), 0)}</strong><Icon name="groups" /></div></div>}
          <div className="overview-heading"><div><div className="eyebrow">ON THE CALENDAR</div><h2>Upcoming events</h2></div><span className="overview-caption">{events.length} events to explore</span></div>
          <div className="event-grid">{events.map((event, i) => {
            const registration = registrations.find(r => r.eventTitle === event.title && (isSupabaseConfigured ? r.mine : r.student === CURRENT_STUDENT));
            return <div className="event-card" key={`${event.title}-${i}`}><div className={`event-image ${event.color}`}><div className="event-pattern" /><Icon name={event.icon} size={54} /><span className="event-date-float"><strong>{event.date.split(" ")[1]?.replace(",", "")}</strong><small>{event.date.split(" ")[0]?.toUpperCase()}</small></span></div><div className="event-body"><span className="event-type">{event.type}</span><h3>{event.title}</h3><div className="event-meta"><span><Icon name="location_on" size={17} /> {event.place}</span><span><Icon name="schedule" size={17} /> {event.time}</span><span><Icon name="groups" size={17} /> {event.registered} approved</span></div>
              {role === "Student" && registration?.status === "Approved" && event.link && <a className="event-join" href={event.link} target="_blank" rel="noreferrer"><Icon name="videocam" size={16} /> Join online event <Icon name="open_in_new" size={15} /></a>}
              <div className="event-bottom"><span><Icon name={event.mode === "Online" ? "videocam" : "domain"} size={16} /> {event.mode}</span>{role === "Student" ? <button disabled={!!registration && registration.status !== "Declined"} onClick={() => requestRegistration(event)}>{registration?.status === "Approved" ? "Approved" : registration?.status === "Pending approval" ? "Pending approval" : "Request registration"} <Icon name="arrow_forward" size={16} /></button> : <span>ITSO approval required</span>}</div></div></div>;
          })}</div>
          {role === "Admin" && <div className="panel listing-panel"><div className="listing-toolbar"><div><h3>Event log <span className="count-pill">{events.filter(e => (!eventSearch || `${e.title} ${e.type} ${e.venue ?? e.place}`.toLowerCase().includes(eventSearch.toLowerCase())) && (!eventMonth || eventIso(e).startsWith(eventMonth)) && (!eventTypeFilter || (e.activityType === "Others" ? e.activityOther : e.activityType ?? e.type) === eventTypeFilter)).length}</span></h3><p>All recorded ITSO activities and their reach</p></div><div className="toolbar-actions"><div className="search-field"><Icon name="search" size={19} /><input aria-label="Search events" placeholder="Search events..." value={eventSearch} onChange={e => setEventSearch(e.target.value)} /></div><input className="month-filter" type="month" aria-label="Filter by month" value={eventMonth} onChange={e => setEventMonth(e.target.value)} /><select className="type-filter" aria-label="Filter by activity type" value={eventTypeFilter} onChange={e => setEventTypeFilter(e.target.value)}><option value="">All activity types</option>{[...EVENT_ACTIVITY_TYPES, "Others"].map(t => <option key={t}>{t}</option>)}</select></div></div><div className="table-wrap scroll"><table><thead><tr><th>TITLE</th><th>TYPE</th><th>DATE</th><th>MODE</th><th>PARTICIPANTS</th><th>DURATION</th><th aria-label="Actions" /></tr></thead><tbody>{events.filter(e => (!eventSearch || `${e.title} ${e.type} ${e.venue ?? e.place}`.toLowerCase().includes(eventSearch.toLowerCase())) && (!eventMonth || eventIso(e).startsWith(eventMonth)) && (!eventTypeFilter || (e.activityType === "Others" ? e.activityOther : e.activityType ?? e.type) === eventTypeFilter)).map(ev => <tr key={ev.id ?? ev.title}><td><div className="cell-main">{ev.title}</div><div className="cell-muted">{ev.place}</div></td><td><span className="type-pill">{ev.activityType === "Others" ? ev.activityOther ?? ev.type : ev.activityType ?? ev.type}</span></td><td><span className="date-cell">{ev.date}</span></td><td>{ev.mode}</td><td>{ev.total ?? 0}</td><td>{ev.durationDays ?? 1} day{(ev.durationDays ?? 1) > 1 ? "s" : ""} · {ev.durationHours ?? 8} h</td><td><div className="registration-actions"><button className="secondary-button" onClick={() => openEventModal(ev)}><Icon name="edit" size={15} /> Edit</button><button className="secondary-button danger" onClick={() => deleteEvent(ev)}><Icon name="delete" size={15} /> Delete</button></div></td></tr>)}</tbody></table>{!events.length && <div className="empty-state"><Icon name="event_busy" size={30} /><strong>No events recorded</strong><span>Add an activity to start the log.</span></div>}</div></div>}
          {role === "Admin" && <div className="panel registration-panel"><div className="panel-heading"><div><div className="eyebrow">EVENT REGISTRATIONS</div><h3>Requests awaiting approval</h3></div><span className="count-pill">{registrations.filter(r => r.status === "Pending approval").length} pending</span></div>{registrations.filter(r => r.status === "Pending approval").length ? registrations.filter(r => r.status === "Pending approval").map(request => <div className="registration-row" key={`${request.eventTitle}-${request.student}`}><div className="avatar">{request.student.split(" ").map(n => n[0]).join("")}</div><div><strong>{request.student}</strong><small>{request.classification ? `${request.classification} · ` : ""}{request.eventTitle}</small></div><div className="registration-actions"><button className="secondary-button" onClick={() => decideRegistration(request, "Declined")}>Decline</button><button className="primary-button" onClick={() => decideRegistration(request, "Approved")}><Icon name="check" size={16} /> Approve</button></div></div>) : <div className="registration-empty"><Icon name="task_alt" size={19} /> No registration requests awaiting review.</div>}</div>}
        </>}
        {page === "Security" && <><SectionHeader eyebrow="ADMINISTRATION / ACCESS" title="Security & access" description="Manage who can access the ITSO workspace and keep records protected." action={<button className="primary-button" onClick={() => setModal("account")}><Icon name="person_add" size={19} /> {me?.isSuper ? "Add account" : "Add applicant email"}</button>} /><div className="security-note"><Icon name="shield" size={23} /><div><strong>Access is controlled by the whitelist</strong><p>Only authorized email addresses can enter the live system. Super admin controls and action logs require a connected backend with row-level security.</p></div></div><div className="mini-stats three"><div><span>Authorized users</span><strong>{accounts.length}</strong><Icon name="group" /></div><div><span>Student accounts</span><strong>{accounts.filter(a => a.role === "Student").length}</strong><Icon name="school" /></div><div><span>Admin accounts</span><strong>{accounts.filter(a => a.role === "Admin").length}</strong><Icon name="admin_panel_settings" /></div></div><div className="panel listing-panel"><div className="listing-toolbar"><div><h3>Authorized accounts <span className="count-pill">{shownAccounts.length}</span></h3><p>People with access to the ITSO workspace</p></div><div className="toolbar-actions"><div className="search-field"><Icon name="search" size={19} /><input aria-label="Search accounts" placeholder="Search accounts..." value={acctSearch} onChange={e => setAcctSearch(e.target.value)} /></div><select className="type-filter" aria-label="Filter by role" value={acctRole} onChange={e => setAcctRole(e.target.value)}><option value="">All roles</option><option>Student</option><option>Admin</option><option>Super Admin</option></select><select className="type-filter" aria-label="Filter by status" value={acctStat} onChange={e => setAcctStat(e.target.value)}><option value="">All statuses</option><option>Active</option><option>Inactive</option></select></div></div><div className="table-wrap scroll"><table><thead><tr><th>NAME</th><th>EMAIL ADDRESS</th><th>ROLE</th><th>STATUS</th><th aria-label="Actions" /></tr></thead><tbody>{shownAccounts.map(a => <tr key={a.email}><td className="cell-main">{a.name}</td><td>{a.email}</td><td><span className="type-pill">{a.role === "Student" ? a.classification ?? "Applicant" : a.role}</span></td><td><span className={`status ${a.status === "Active" ? "status-green" : "status-red"}`}><span className="status-dot" />{a.status}</span></td><td>{a.email === me?.email ? <span className="cell-muted you-cell">You</span> : (me?.isSuper || (a.rawRole ?? "student") === "student") && <div className="registration-actions"><button className="secondary-button" onClick={() => openEditName(a)}><Icon name="edit" size={15} /> Edit name</button>{a.status === "Active" ? <button className="secondary-button danger" onClick={() => setAccountStatus(a, "inactive")}>Deactivate</button> : <button className="secondary-button" onClick={() => setAccountStatus(a, "active")}>Reactivate</button>}</div>}</td></tr>)}</tbody></table>{!shownAccounts.length && <div className="empty-state"><Icon name="person_search" size={30} /><strong>No accounts match</strong><span>Try changing your filters or search.</span></div>}</div></div>
        {me?.isSuper && <div className="panel listing-panel"><div className="listing-toolbar"><div><h3>Admin action log <span className="count-pill">{actionLog.filter(a => (!logSearch || `${a.admin} ${a.action} ${a.target}`.toLowerCase().includes(logSearch.toLowerCase())) && (!logType || a.action === logType)).length}</span></h3><p>Super-admin audit trail of workspace actions</p></div><div className="toolbar-actions"><div className="search-field"><Icon name="search" size={19} /><input aria-label="Search action log" placeholder="Search log..." value={logSearch} onChange={e => setLogSearch(e.target.value)} /></div><select className="type-filter" aria-label="Filter by action" value={logType} onChange={e => setLogType(e.target.value)}><option value="">All actions</option>{[...new Set(actionLog.map(a => a.action))].map(a => <option key={a} value={a}>{humanAction(a)}</option>)}</select></div></div><div className="table-wrap scroll"><table><thead><tr><th>WHEN</th><th>ADMIN</th><th>ACTION</th><th>TARGET</th><th>DETAILS</th></tr></thead><tbody>{actionLog.filter(a => (!logSearch || `${a.admin} ${a.action} ${a.target}`.toLowerCase().includes(logSearch.toLowerCase())) && (!logType || a.action === logType)).map(a => <tr key={a.id}><td><span className="date-cell">{a.when}</span></td><td>{a.admin}</td><td><span className="type-pill">{humanAction(a.action)}</span></td><td className="cell-main">{a.target}</td><td><span className="cell-muted">{detailText(a.action, a.details)}</span></td></tr>)}</tbody></table>{!actionLog.length && <div className="empty-state"><Icon name="history" size={30} /><strong>No actions logged yet</strong><span>Admin activity will appear here.</span></div>}</div></div>}</>}
      </main>
    </div>
    {selected && <div className="drawer-layer"><div className="drawer-scrim" onClick={() => setSelected(null)} /><aside className="detail-drawer"><div className="drawer-head"><div><div className="eyebrow">SUBMISSION DETAILS</div><strong>{selected.id}</strong></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close details"><Icon name="close" /></button></div><div className="drawer-content">
      <Status value={selected.status} /><h2>{selected.title}</h2><p className="drawer-subtitle">{selected.type} · {selected.program}</p>
      <div className="drawer-section"><h3>Filing information</h3><div className="detail-row"><span>Student</span><strong>{selected.student}</strong></div><div className="detail-row"><span>Classification</span><strong>{applicantLabel(selected.applicantType)}</strong></div>{selected.affiliation && <div className="detail-row"><span>Affiliation</span><strong>{selected.affiliation}</strong></div>}{selected.studentId && <div className="detail-row"><span>Student ID</span><strong>{selected.studentId}</strong></div>}<div className="detail-row"><span>Date submitted</span><strong>{selected.submitted}</strong></div><div className="detail-row"><span>Date filed</span><strong>{selected.filed}</strong></div>{selected.ser && <div className="detail-row"><span>SER deadline (18 months)</span><strong>{selected.ser.deadline} · {selected.ser.status === "open" ? (daysUntil(selected.ser.deadlineRaw) >= 0 ? `${daysUntil(selected.ser.deadlineRaw)} days left` : `${-daysUntil(selected.ser.deadlineRaw)} days overdue`) : "handled"}</strong></div>}{selected.archived && <div className="detail-row"><span>Archive reason</span><strong>{selected.archiveReason}</strong></div>}{role === "Admin" && !selected.archived && <div className="inline-field"><label className="field-label">Filing date<input type="date" value={filingDate || selected.filedRaw || ""} onChange={e => setFilingDate(e.target.value)} /></label><button className="secondary-button full" disabled={!(filingDate || selected.filedRaw)} onClick={recordFilingDate}><Icon name="event_available" size={17} /> {selected.filedRaw ? "Update filing date" : "Record filing date"}</button><p className="tiny-copy">Starts the 18-month Substantive Examination clock.</p></div>}</div>
      <div className="drawer-section"><h3>Authors</h3>{(selected.authorDetails?.length ? selected.authorDetails : selected.authors.map(n => ({ id: n, name: n, email: null }))).map((row, i) => { const rowKey = row.id ?? row.name; const editing = editingAuthor === rowKey; return <div className="author-row" key={rowKey}><span>{i + 1}. {editing && role === "Admin" ? <input className="author-edit-input" value={authorEdit} onChange={e => setAuthorEdit(e.target.value)} /> : row.name}{editing ? <input className="author-edit-input author-email-edit" type="email" placeholder="name@gmail.com" value={authorEmailEdit} onChange={e => setAuthorEmailEdit(e.target.value)} /> : <small className="author-email">{row.email ?? "No email"}</small>}</span>{!selected.archived && (role === "Admin" || canEditAuthors) && (editing ? <span className="author-actions"><button className="text-link" onClick={() => saveAuthorEdit(row)}>Save</button><button className="text-link" onClick={() => setEditingAuthor(null)}>Cancel</button></span> : <button className="text-link" onClick={() => { setEditingAuthor(rowKey); setAuthorEdit(row.name); setAuthorEmailEdit(row.email ?? ""); }}>Edit</button>)}{canEditAuthors && <button className="icon-button author-remove" aria-label={`Remove ${row.name}`} disabled={(selected.authorDetails?.length ?? selected.authors.length) <= 1} onClick={() => removeAuthor(row)}><Icon name="close" size={15} /></button>}</div>; })}{canEditAuthors && <div className="author-input"><input placeholder="Add an author's full name" value={newAuthorName} onChange={e => setNewAuthorName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void addPaperAuthor(); } }} /><input className="author-email-input" type="email" placeholder="name@gmail.com" value={newAuthorEmail} onChange={e => setNewAuthorEmail(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void addPaperAuthor(); } }} /><button type="button" onClick={() => void addPaperAuthor()}><Icon name="add" size={16} /> Add</button></div>}</div>
      <div className="drawer-section"><h3>Documents</h3>{selected.drive ? <a className="drive-link" href={selected.drive} target="_blank" rel="noreferrer"><Icon name="folder_open" size={19} /> Open Google Drive folder <Icon name="open_in_new" size={16} /></a> : <p className="drawer-subtitle">No Drive folder linked to this record.</p>}<p className="tiny-copy">Only share the folder with itso@qcu.edu.ph. Keep revised versions in the same folder.</p>{selected.linkReport && <div className="problem-card link-report"><Icon name="link_off" size={20} /><div><strong>Drive link reported as inaccessible</strong><p>{selected.linkReport.at}{selected.linkReport.by ? ` · by ${selected.linkReport.by}` : ""}</p>{selected.linkReport.note && <p>{selected.linkReport.note}</p>}</div></div>}{linkNoteOpen && <><label className="field-label">Note for ITSO (optional)<textarea placeholder="e.g. The folder link says access denied..." value={linkNote} onChange={e => setLinkNote(e.target.value)} /></label><div className="defect-actions"><button className="secondary-button" onClick={() => void reportBroken()}><Icon name="link_off" size={16} /> Confirm report</button><button className="text-link" onClick={() => { setLinkNoteOpen(false); setLinkNote(""); }}>Cancel</button></div></>}{role === "Admin" && !selected.archived && <div className="defect-actions">{!selected.linkReport && !linkNoteOpen && <button className="secondary-button" onClick={() => setLinkNoteOpen(true)}><Icon name="link_off" size={16} /> Report broken link to student</button>}{selected.linkReport && <button className="secondary-button" onClick={() => void clearBroken()}><Icon name="task_alt" size={16} /> Mark resolved</button>}</div>}{isOwnerStudent && !selected.archived && <>{!selected.linkReport && !linkNoteOpen && <button className="secondary-button" onClick={() => setLinkNoteOpen(true)}><Icon name="link_off" size={16} /> Report broken link</button>}<div className={`inline-field ${selected.linkReport ? "link-fix" : ""}`}><label className="field-label">{selected.linkReport ? "Update Drive link to resolve the report" : "Update Drive link"}<input type="url" placeholder="https://drive.google.com/drive/folders/..." value={linkInput} onChange={e => setLinkInput(e.target.value)} /></label><button className="secondary-button full" disabled={!linkInput.trim().startsWith("https://")} onClick={() => void updateDriveLink()}><Icon name="link" size={16} /> Save new link</button></div></>}</div>
      <div className="drawer-section"><h3>Formality defect · separate from status</h3>{selected.type === "Copyright" ? <div className="defect-summary clear"><Icon name="block" size={20} /><div><strong>Not applicable to Copyright</strong><small>Formality defects only apply to patent-type filings.</small></div></div> : <><div className={`defect-summary ${defects.some(d => d.submissionId === selected.id && d.status === "open") ? "warning" : "clear"}`}><Icon name={defects.some(d => d.submissionId === selected.id && d.status === "open") ? "warning" : "check_circle"} size={20} /><div><strong>{defects.some(d => d.submissionId === selected.id && d.status === "open") ? "Open formality defect" : "No open formality defect"}</strong><small>This notice is tracked independently of the filing status.</small></div></div>
      {defects.filter(d => d.submissionId === selected.id).map((defect, index) => <div className="defect-round" key={defect.id}><div className="defect-round-head"><strong>{defectLabel(defect.round ?? index + 1)} · {defect.status === "open" ? "Open" : "Resolved"}</strong><span>Deadline: {defect.deadline} (60 days from notice){defect.status === "open" && (defect.deadlineRaw ? daysUntil(defect.deadlineRaw) : daysUntil(defect.deadline)) >= 0 ? ` · ${(defect.deadlineRaw ? daysUntil(defect.deadlineRaw) : daysUntil(defect.deadline))} days left` : defect.status === "open" ? ` · ${-(defect.deadlineRaw ? daysUntil(defect.deadlineRaw) : daysUntil(defect.deadline))} days overdue` : ""}</span></div><p>Notice: {defect.noticeDate}</p><div className="comment-log">{defect.comments.map((comment, i) => <div className="logged-comment" key={i}><strong>{comment.author} <time>{comment.timestamp}</time></strong><p>{comment.text}</p></div>)}</div>{role === "Admin" && !selected.archived && <><label className="field-label">Comment on this defect<textarea placeholder="Add a note to this defect round..." value={defectReply[defect.id] || ""} onChange={e => setDefectReply({ ...defectReply, [defect.id]: e.target.value })} /></label><div className="defect-actions"><button className="secondary-button" disabled={!defectReply[defect.id]?.trim()} onClick={() => replyToDefect(defect)}>Post defect comment</button>{defect.status === "open" && <button className="secondary-button" onClick={() => resolveDefect(defect)}>Mark resolved</button>}</div></>}</div>)}
      {role === "Admin" && !selected.archived && <div className="new-defect"><h4>Record a new defect round</h4><label className="field-label">Notice date<input type="date" value={defectNotice} onChange={e => setDefectNotice(e.target.value)} /></label>{defectNotice && <p className="deadline-preview">Deadline: {addDays(defectNotice, 60)} (60 days)</p>}<label className="field-label">Defect details / comment<textarea placeholder="Describe the formality defect in this notice..." value={defectComment} onChange={e => setDefectComment(e.target.value)} /></label><button className="secondary-button full" disabled={!defectNotice || !defectComment.trim()} onClick={recordDefect}><Icon name="add" size={17} /> Log formality defect</button></div>}</>}</div>
      <div className="drawer-section"><h3>Other problems & deadlines</h3>{selected.ser ? <><div className={`problem-card ${selected.ser.status === "resolved" ? "resolved" : ""}`}><Icon name={selected.ser.status === "open" ? "warning" : "task_alt"} size={20} /><div><strong>Substantive Examination Request</strong><p>Triggered {selected.ser.triggered} · Deadline {selected.ser.deadline}</p><p>{selected.ser.status === "open" ? (daysUntil(selected.ser.deadlineRaw) >= 0 ? `Open · ${daysUntil(selected.ser.deadlineRaw)} days remaining` : `Open · Overdue by ${-daysUntil(selected.ser.deadlineRaw)} days`) : `Handled${selected.ser.note ? ` · ${selected.ser.note}` : ""}`}</p></div></div>{role === "Admin" && !selected.archived && selected.ser.status === "open" && <><label className="field-label">Justification required<input placeholder="Why is the SER being marked as handled?" value={serNote} onChange={e => setSerNote(e.target.value)} /></label><button className="secondary-button full" disabled={!serNote.trim()} onClick={resolveSer}><Icon name="task_alt" size={17} /> Mark handled</button></>}</> : <div className="all-clear"><Icon name="check_circle" size={19} /> No other open problems</div>}</div>
      <div className="drawer-section"><h3>Certificate</h3>{selected.certificate ? <>{selected.certificate.link && <a className="drive-link" href={selected.certificate.link} target="_blank" rel="noreferrer"><Icon name="workspace_premium" size={19} /> Open certificate <Icon name="open_in_new" size={16} /></a>}<p className="tiny-copy">Issued {selected.certificate.issued}</p></> : role === "Admin" && !selected.archived ? <><label className="field-label">Certificate link<input type="url" placeholder="https://drive.google.com/..." value={certLink} onChange={e => setCertLink(e.target.value)} /></label><button className="primary-button full" disabled={!certLink.trim().startsWith("https://")} onClick={issueCertificate}><Icon name="workspace_premium" size={17} /> Issue certificate</button></> : <p className="drawer-subtitle">Certificate will be available here once issued.</p>}</div>
      <div className="drawer-section"><h3>Admin remarks · submission log</h3>{(remarks[selected.id] || []).length ? <div className="comment-log">{remarks[selected.id].map((comment, i) => <div className="logged-comment" key={i}><strong>{comment.author} <time>{comment.timestamp}</time></strong><p>{comment.text}</p></div>)}</div> : <p className="drawer-subtitle">No general remarks yet. Defect comments are logged separately above.</p>}{role === "Admin" && !selected.archived && <><label className="field-label">Add a comment<textarea placeholder="Write feedback for the student..." value={generalComment} onChange={e => setGeneralComment(e.target.value)} /></label><button className="primary-button full" disabled={!generalComment.trim()} onClick={recordRemark}>Post comment to log</button></>}</div>
      <div className="drawer-section"><h3>Status timeline</h3><div className="timeline">{((selected.history?.length ? selected.history.map(h => ({ label: h.status, at: h.at, by: h.by, sort: h.atRaw ?? h.at })) : [{ label: selected.status, at: "Current status", by: undefined as string | undefined, sort: "9999" }, { label: "Under Review", at: selected.submitted, by: undefined as string | undefined, sort: selected.submitted }]).concat(selected.filedRaw ? [{ label: `Filed with IPOPHIL — date of filing ${selected.filed} · SER deadline ${selected.ser?.deadline ?? "—"}`, at: selected.filed, by: undefined as string | undefined, sort: selected.filedRaw }] : [], defects.filter(d => d.submissionId === selected.id).map((d, i) => ({ label: `${defectLabel(d.round ?? i + 1)} logged — deadline ${d.deadline}`, at: fmtDate(d.noticeDate), by: undefined as string | undefined, sort: d.noticeDate })))).sort((a, b) => Date.parse(b.sort) - Date.parse(a.sort)).map((entry, i) => <div key={i}><strong>{entry.label}</strong><span>{entry.at}{entry.by ? ` · by ${entry.by}` : ""}</span></div>)}</div></div>
      {role === "Admin" && !selected.archived && <div className="drawer-section"><h3>Update status</h3><label className="field-label">New status<select value={pendingStatus} onChange={e => setPendingStatus(e.target.value)}>{statuses.map(s => <option key={s}>{s}</option>)}</select></label>{pendingStatus === "Submitted to IPOPHIL" && <label className="field-label">Date of filing<input type="date" value={filingDate || selected.filedRaw || new Date().toISOString().slice(0, 10)} onChange={e => setFilingDate(e.target.value)} /></label>}{pendingStatus === "Revisions Needed" && <label className="field-label">Remark required<textarea placeholder="Tell the student what needs revision..." value={remark} onChange={e => setRemark(e.target.value)} /></label>}<button className="primary-button full" disabled={!pendingStatus || pendingStatus === selected.status} onClick={() => updatePaper(pendingStatus)}>Save status change</button></div>}
      {selected.archived && role === "Admin" && <button className="primary-button full" onClick={() => unarchive(selected)}>Unarchive paper</button>}
    </div></aside></div>}
    {modal && <div className="modal-layer" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><div className={`modal ${modal === "submit" || modal === "event" || modal === "profile" ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={modal === "instructions" ? "Document sharing instructions" : modal === "submit" ? "New submission" : modal === "event" ? (editingEvent ? "Edit event" : "New event") : modal === "name" ? "Edit name" : modal === "profile" ? "Update information" : "Add account"}><button className="modal-close icon-button" onClick={() => setModal(null)} aria-label="Close"><Icon name="close" /></button>{modal === "instructions" && <><div className="modal-icon"><Icon name="folder_shared" size={29} /></div><div className="eyebrow">BEFORE YOU CONTINUE</div><h2>Share your documents correctly</h2><p className="modal-intro">Share your Google Drive folder only with itso@qcu.edu.ph as a Viewer. Do not enable link access or share it with anyone else. Check the access list each time you submit.</p><div className="sharing-illustration"><div className="sharing-window"><div className="sharing-top"><Icon name="folder" size={20} /> Share “Research documents” <Icon name="close" size={16} /></div><div className="sharing-section">People with access</div><div className="sharing-access"><span><Icon name="person" size={22} /></span><div><strong>itso@qcu.edu.ph</strong><small>Viewer · only ITSO has access</small></div><Icon name="check_circle" size={17} /></div><div className="sharing-bottom">General access: Restricted <span>Done</span></div></div></div><div className="instruction-callout"><Icon name="info" size={19} /><span>Add <strong>itso@qcu.edu.ph</strong> as a <strong>Viewer</strong>. Set General access to <strong>Restricted</strong> and remove access for anyone else. Copy the folder link and keep all revisions there. ITSO cannot automatically verify your Drive settings.</span></div><button className="primary-button full" onClick={() => instructionPurpose === "submit" ? openSubmitForm() : setModal(null)}>I understand — proceed <Icon name="arrow_forward" size={18} /></button><button className="quiet-button" onClick={() => setModal(null)}>I’ll do this later</button></>}{modal === "submit" && <><div className="eyebrow">NEW FILING</div><h2>Submit a new paper</h2><p className="modal-intro">Tell us about your work. Your files stay in your Google Drive folder.</p><form onSubmit={submitPaper}><div className="form-grid"><label className="field-label span-two">Paper title<input required placeholder="Enter the title of your research" value={formTitle} onChange={e => setFormTitle(e.target.value)} /></label><div className="field-label span-two">Submitting as<div className="class-cards">{([["student", "school", "QCU Student"], ["staff", "badge", "QCU Faculty / Staff"], ["external", "public", "External (Non-QCU)"]] as const).map(([v, icon, label]) => <button type="button" key={v} className={`class-card ${formApplicant === v ? "on" : ""}`} onClick={() => { setFormApplicant(v); setFormCollege(""); setFormProgram(""); setFormAffil(v === myType && v !== "student" ? me?.affiliation ?? "" : ""); }}><Icon name={icon} size={22} /><strong>{label}</strong></button>)}</div></div>{formApplicant !== "student" && <label className="field-label span-two">{formApplicant === "staff" ? "Office / Department" : "Organization / Institution"}<input required value={formAffil} onChange={e => setFormAffil(e.target.value)} placeholder={formApplicant === "staff" ? "e.g. Office of the Registrar" : "e.g. company, school, or Independent inventor"} /></label>}{formApplicant === "student" && <label className="field-label">Student ID number (optional)<input pattern="[0-9]{2}-[0-9]{4}" title="Use the format 22-0145" placeholder="e.g. 22-0145" value={formStudentId} onChange={e => setFormStudentId(e.target.value)} /></label>}<label className="field-label">Filing type<select required value={formType} onChange={e => setFormType(e.target.value)}><option value="">Select filing type</option>{types.map(t => <option key={t}>{t}</option>)}</select></label>{formApplicant === "student" && <><label className="field-label">College<select required value={formCollege} onChange={e => { setFormCollege(e.target.value); setFormProgram(""); }}><option value="">Select college</option>{collegeOptions.map(c => <option key={c}>{c}</option>)}</select></label><label className="field-label">Program<select required value={formProgram} disabled={!formCollege} onChange={e => setFormProgram(e.target.value)}><option value="">Select program</option>{(programOptions[formCollege] || []).map(p => <option key={p}>{p}</option>)}</select></label></>}{formApplicant === "staff" && <label className="field-label">College (optional)<select value={formCollege} onChange={e => setFormCollege(e.target.value)}><option value="">None / Not college-based</option>{collegeOptions.map(c => <option key={c}>{c}</option>)}</select></label>}<label className="field-label span-two">Google Drive folder link<input required type="url" placeholder="https://drive.google.com/drive/folders/..." value={formDrive} onChange={e => setFormDrive(e.target.value)} /></label><div className="field-label span-two">Authors <span className="field-hint">Add each author one at a time · Co-authors with an email get updates on status changes, remarks, defects and certificates.</span><div className="author-input"><input placeholder="Enter an author’s full name" value={authorInput} onChange={e => setAuthorInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addAuthor(); } }} /><button type="button" onClick={addAuthor}><Icon name="add" size={18} /> Add</button></div><div className="author-list">{authors.map((a, i) => <span className="author-chip" key={`${a.name}-${i}`}>{i + 1}. {isSupabaseConfigured && a.name === me?.fullName ? "You" : a.name}{isSupabaseConfigured && a.name === me?.fullName ? null : <input className="author-email-input" type="email" placeholder="name@gmail.com" aria-label={`Gmail address (optional) for ${a.name}`} value={a.email} onChange={e => setAuthors(authors.map((x, n) => n === i ? { ...x, email: e.target.value } : x))} />}<button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAuthors(authors.filter((_, n) => n !== i))}><Icon name="close" size={14} /></button></span>)}</div></div></div><label className="confirmation"><input required type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I confirm only itso@qcu.edu.ph has Viewer access, nobody else can access the folder, and General access is Restricted.</label><div className="form-actions"><button className="secondary-button" type="button" onClick={() => setModal(null)}>Cancel</button><button className="primary-button" type="submit">Submit paper <Icon name="arrow_forward" size={18} /></button></div></form></>}{modal === "event" && <><div className="eyebrow">EVENTS / {editingEvent ? "EDIT" : "NEW"}</div><h2>{editingEvent ? "Edit event" : "Add a new event"}</h2><p className="modal-intro">{editingEvent ? "Update the details of this ITSO activity." : "Create an upcoming ITSO activity for students to discover."}</p><form onSubmit={saveEvent}><div className="form-grid"><label className="field-label span-two">Event title<input required value={eventTitle} onChange={e => setEventTitle(e.target.value)} placeholder="e.g. IP Awareness Workshop" /></label><label className="field-label">Type of activity<select value={eventType} onChange={e => setEventType(e.target.value)}>{[...EVENT_ACTIVITY_TYPES, "Others"].map(t => <option key={t}>{t}</option>)}</select></label>{eventType === "Others" && <label className="field-label">Specify activity<input required value={eventOther} onChange={e => setEventOther(e.target.value)} placeholder="Enter activity type" /></label>}<label className="field-label">Event date<input required type="date" value={eventDate} onChange={e => setEventDate(e.target.value)} /></label><label className="field-label">Mode of delivery<select value={eventMode} onChange={e => { setEventMode(e.target.value); setEventLocation(""); }}><option>Onsite</option><option>Online</option></select></label>{eventMode === "Onsite" && <label className="field-label">Start time<input required type="time" value={eventTime} onChange={e => setEventTime(e.target.value)} /></label>}<label className="field-label">{eventMode === "Online" ? "Meeting link" : "Onsite venue"}<input required type={eventMode === "Online" ? "url" : "text"} placeholder={eventMode === "Online" ? "https://meet.google.com/..." : "e.g. QCU Auditorium"} value={eventLocation} onChange={e => setEventLocation(e.target.value)} /></label><label className="field-label">Duration (days)<input required type="number" min={1} step={1} value={eventDays} onChange={e => setEventDays(e.target.value)} /></label><label className="field-label">Hours per day<input required type="number" min={0.5} step={0.5} value={eventHours} onChange={e => setEventHours(e.target.value)} /></label><div className="field-label span-two">Participants involved<div className="chip-group">{participantOptions.map(o => <label key={o} className={`chip ${eventParticipants.includes(o) ? "on" : ""}`}><input type="checkbox" checked={eventParticipants.includes(o)} onChange={e => setEventParticipants(e.target.checked ? [...eventParticipants, o] : eventParticipants.filter(x => x !== o))} />{o}</label>)}</div></div><div className="field-label span-two">Sector<div className="chip-group">{sectorOptions.map(o => <label key={o} className={`chip ${eventSector.includes(o) ? "on" : ""}`}><input type="checkbox" checked={eventSector.includes(o)} onChange={e => setEventSector(e.target.checked ? [...eventSector, o] : eventSector.filter(x => x !== o))} />{o}</label>)}</div></div><label className="field-label">Male participants<input required type="number" min={0} step={1} value={eventMale} onChange={e => setEventMale(e.target.value)} /></label><label className="field-label">Female participants<input required type="number" min={0} step={1} value={eventFemale} onChange={e => setEventFemale(e.target.value)} /></label><div className="detail-row span-two"><span>Total participants</span><strong>{(parseInt(eventMale) || 0) + (parseInt(eventFemale) || 0)} (computed)</strong></div><div className="field-label span-two">Age range<div className="chip-group">{ageOptions.map(o => <label key={o} className={`chip ${eventAge.includes(o) ? "on" : ""}`}><input type="checkbox" checked={eventAge.includes(o)} onChange={e => setEventAge(e.target.checked ? [...eventAge, o] : eventAge.filter(x => x !== o))} />{o}</label>)}</div></div><label className="field-label span-two">Google Drive link (optional)<input type="url" placeholder="https://drive.google.com/..." value={eventDrive} onChange={e => setEventDrive(e.target.value)} /></label></div><button className="primary-button full" type="submit">{editingEvent ? "Save changes" : "Add event"} <Icon name="arrow_forward" size={18} /></button></form></>}{modal === "account" && <><div className="eyebrow">SECURITY / WHITELIST</div><h2>Add authorized email</h2><p className="modal-intro">Only authorized people should be added to this list.</p><form onSubmit={addAccount}><label className="field-label">Email address<input required type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="name@example.com" /></label>{me?.isSuper && <label className="field-label">Role<select value={newRole} onChange={e => setNewRole(e.target.value as "student" | "admin")}><option value="student">Applicant (student, staff or external)</option><option value="admin">Admin</option></select></label>}<div className="instruction-callout"><Icon name="info" size={19} /><span>{me?.isSuper ? "Students and admins can be added here. New admins set their legal name on first sign-in." : "This workspace can only add student emails. Admin accounts require super admin access in the live system."}</span></div><button className="primary-button full" type="submit">Add to whitelist <Icon name="arrow_forward" size={18} /></button></form></>}{modal === "name" && <><div className="eyebrow">SECURITY / ACCOUNTS</div><h2>Edit name</h2><p className="modal-intro">Update the legal name for {editNameFor?.email}. This appears on filings and certificates.</p><form onSubmit={saveAccountName}><div className="form-grid"><label className="field-label">Given name<input required value={enGiven} onChange={e => setEnGiven(e.target.value)} /></label><label className="field-label">Middle name<input value={enMiddle} onChange={e => setEnMiddle(e.target.value)} placeholder="Optional" /></label><label className="field-label">Family name<input required value={enFamily} onChange={e => setEnFamily(e.target.value)} /></label><label className="field-label">Suffix<input value={enSuffix} onChange={e => setEnSuffix(e.target.value)} placeholder="Optional, e.g. Jr., III" /></label></div>{[enGiven, enMiddle, enFamily, enSuffix].some(x => x.trim()) && <p className="modal-intro">Will appear as: <strong>{[enGiven, enMiddle, enFamily, enSuffix].map(x => x.trim()).filter(Boolean).join(" ")}</strong></p>}<button className="primary-button full" type="submit">Save name <Icon name="arrow_forward" size={18} /></button></form></>}{modal === "profile" && <><div className="eyebrow">ACCOUNT / PROFILE</div><h2>Update information</h2><p className="modal-intro">This legal name is used on IPOPHIL filings and certificates.</p><form onSubmit={saveUpdateInfo}><div className="form-grid"><label className="field-label">Given name<input required value={pfGiven} onChange={e => setPfGiven(e.target.value)} /></label><label className="field-label">Middle name<input value={pfMiddle} onChange={e => setPfMiddle(e.target.value)} placeholder="Optional" /></label><label className="field-label">Family name<input required value={pfFamily} onChange={e => setPfFamily(e.target.value)} /></label><label className="field-label">Suffix<input value={pfSuffix} onChange={e => setPfSuffix(e.target.value)} placeholder="Optional, e.g. Jr., III" /></label>{me?.role === "Student" && <div className="field-label span-two">I am a…<div className="class-cards">{([["student", "school", "QCU Student"], ["staff", "badge", "QCU Faculty / Staff"], ["external", "public", "External (Non-QCU)"]] as [ApplicantType, string, string][]).map(([v, icon, label]) => <button type="button" key={v} className={`class-card ${pfType === v ? "on" : ""}`} onClick={() => setPfType(v)}><Icon name={icon} size={20} /><strong>{label}</strong></button>)}</div></div>}{me?.role === "Student" && pfType === "student" && <><label className="field-label span-two">Student ID number (optional)<input pattern="[0-9]{2}-[0-9]{4}" title="Use the format 22-0145" value={pfStudentId} onChange={e => setPfStudentId(e.target.value)} /></label><label className="field-label">College<select required value={pfCollege} onChange={e => { setPfCollege(e.target.value); setPfProgram(""); }}><option value="">Select college</option>{collegeOptions.map(c => <option key={c}>{c}</option>)}</select></label><label className="field-label">Program<select required value={pfProgram} disabled={!pfCollege} onChange={e => setPfProgram(e.target.value)}><option value="">Select program</option>{(programOptions[pfCollege] || []).map(p => <option key={p}>{p}</option>)}</select></label></>}{me?.role === "Student" && pfType === "staff" && <><label className="field-label span-two">Office / Department<input required placeholder="e.g. ITSO, Registrar's Office" value={pfAffil} onChange={e => setPfAffil(e.target.value)} /></label><label className="field-label span-two">College (optional)<select value={pfCollege} onChange={e => setPfCollege(e.target.value)}><option value="">None / Not college-based</option>{collegeOptions.map(c => <option key={c}>{c}</option>)}</select></label></>}{me?.role === "Student" && pfType === "external" && <label className="field-label span-two">Organization / Institution<input required placeholder="e.g. company, school, or 'Independent inventor'" value={pfAffil} onChange={e => setPfAffil(e.target.value)} /></label>}</div>{[pfGiven, pfMiddle, pfFamily, pfSuffix].some(x => x.trim()) && <p className="modal-intro">You'll appear as: <strong>{[pfGiven, pfMiddle, pfFamily, pfSuffix].map(x => x.trim()).filter(Boolean).join(" ")}</strong></p>}{pfError && <div className="login-message"><Icon name="error" size={18} /><span>{pfError}</span></div>}<button className="primary-button full" type="submit" disabled={pfBusy}>{pfBusy ? "Saving…" : "Save changes"} <Icon name="arrow_forward" size={18} /></button></form></>}</div></div>}
    {notice && <div className="toast"><Icon name="info" size={20} />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notification"><Icon name="close" size={17} /></button></div>}
  </div>;
}
