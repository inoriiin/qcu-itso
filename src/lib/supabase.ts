import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey && url !== "https://YOUR-PROJECT-REF.supabase.co");

export const supabase = isSupabaseConfigured
  ? createClient(url!, anonKey!)
  : null;

export type DbCollege = { id: number; name: string };
export type DbProgram = { id: number; college_id: number; name: string };
export type DbRole = "student" | "admin" | "super_admin";
export type DbSubmissionStatus =
  | "Paper Submitted" | "Under Review" | "Submitted to IPOPHIL" | "Revisions Needed"
  | "Passed" | "Received eSOA" | "Paid" | "Approved with Certificate"
  | "Withdrawn" | "Disapproved";
export type DbFilingType = "Copyright" | "Patent" | "Utility Model" | "Industrial Design";

export type DbSubmission = {
  id: string;
  reference_number: string;
  student_id: string;
  student_submitted_id_number: string;
  title: string;
  program_id: number;
  college_id: number;
  filing_type: DbFilingType;
  current_status: DbSubmissionStatus;
  filing_date: string | null;
  drive_folder_link: string | null;
  date_created: string;
  completion_date: string | null;
  last_activity_date: string;
  archived: boolean;
  archived_date: string | null;
  archive_reason: string | null;
};

export type DbAuthor = {
  id: string;
  submission_id: string;
  author_name: string;
  order_index: number;
  added_by_role: DbRole;
};

export type DbStatusHistory = {
  id: string;
  submission_id: string;
  old_status: DbSubmissionStatus | null;
  new_status: DbSubmissionStatus;
  changed_by_email: string | null;
  timestamp: string;
};

export type DbRemark = {
  id: string;
  submission_id: string;
  admin_email: string | null;
  comment_text: string;
  timestamp: string;
};

export type DbProblem = {
  id: string;
  submission_id: string;
  problem_type: "Substantive Examination Request" | "Formality Defect";
  date_triggered: string;
  deadline_date: string;
  status: "open" | "resolved";
  resolved_date: string | null;
  resolution_note: string | null;
};

export type DbFormalityDefect = {
  id: string;
  problem_id: string;
  submission_id: string;
  round_number: number;
  notice_date: string;
  deadline_date: string;
  status: "open" | "resolved";
  resolved_date: string | null;
};

export type DbDefectComment = {
  id: string;
  formality_defect_id: string;
  admin_email: string | null;
  comment_text: string;
  timestamp: string;
};

export type DbEvent = {
  id: string;
  title: string;
  activity_type: string;
  activity_type_other: string | null;
  mode_of_delivery: "Onsite" | "Online";
  event_date: string;
  duration_days: number;
  duration_hours: number;
  participants_involved: string[];
  sector: string[];
  participants_male: number;
  participants_female: number;
  participants_total: number;
  age_range: string[];
  drive_link: string | null;
  date_created: string;
};

export type DbRegistration = {
  id: string;
  event_id: string;
  student_id: string;
  registration_date: string;
  status: "pending" | "approved" | "declined";
};

export type DbAuthorizedEmail = {
  id: string;
  email: string;
  role: DbRole;
  status: "active" | "inactive";
  date_added: string;
};

/** Fetch the caller's whitelist role after Google sign-in. */
export async function fetchMyRole(): Promise<DbRole | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("my_role");
  if (error) return null;
  return (data as DbRole) ?? null;
}

/** Fetch reference data (colleges + programs) for cascading dropdowns. */
export async function fetchCollegesPrograms(): Promise<{ colleges: DbCollege[]; programs: DbProgram[] }> {
  if (!supabase) return { colleges: [], programs: [] };
  const [{ data: colleges }, { data: programs }] = await Promise.all([
    supabase.from("colleges").select("id, name").order("id"),
    supabase.from("programs").select("id, college_id, name").order("id"),
  ]);
  return { colleges: (colleges ?? []) as DbCollege[], programs: (programs ?? []) as DbProgram[] };
}
