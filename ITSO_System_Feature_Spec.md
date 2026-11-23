# ITSO Document Filing & Tracking System — Complete Feature Specification

**Stack decision:** Plain React (Vite) frontend + Supabase (Postgres + Auth + Edge Functions) + GitHub Pages hosting. No file storage layer — documents handled via Google Drive links. No data migration — old system runs down naturally on its own ongoing cases; new system handles all new filings from an agreed cutoff date.

---

## PHASE 0 — Foundation (build first; nothing else works without this)

### 0.1 Database Schema (Supabase / Postgres)
Tables needed, and exactly what each holds:

- **`authorized_emails`** — the whitelist
  - `email` (unique, stored lowercase/trimmed), `role` (student / admin / super_admin), `status` (active / inactive), `added_by`, `date_added`

- **`students`** — profile data linked to a whitelisted student email
  - `id`, `email`, `full_name`, `student_id_number` (format: `xx-xxxx` — first two digits are year first enrolled, last four digits are a unique number, e.g., `22-0145`), `college_id`, `program_id`, `date_joined`
  - Validate this format at input (two digits, hyphen, four digits) so malformed IDs are caught immediately rather than discovered later

- **`admins`** — profile data linked to a whitelisted admin/super_admin email
  - `id`, `email`, `full_name`, `role` (admin/super_admin)

- **`colleges`** — reference table, seeded with the school's actual structure:
  - College of Business Administration and Accountancy
  - College of Education
  - College of Engineering
  - College of Computer Studies

- **`programs`** — reference table, tied to a college, seeded as:
  - Under **College of Business Administration and Accountancy**: BS Accountancy (BSA), BS Entrepreneurship (BSEntrep)
  - Under **College of Education**: Bachelor of Early Childhood Education (BECEd)
  - Under **College of Engineering**: BS Industrial Engineering (BSIE), BS Electronics Engineering (BSECE), BS Computer Engineering (BSCpE)
  - Under **College of Computer Studies**: BS Information Technology (BSIT)
  - *(Meant to be admin-editable later if new programs are added — seed as data, don't hardcode permanently in code)*

- **`submissions`** — the core record of a filing
  - `id`, `reference_number` (system-generated, unique), `student_id`, `student_submitted_id_number`, `title`, `program_id`, `college_id` (derived from program, stored for fast filtering)
  - `filing_type` (Copyright / Patent / Utility Model / Industrial Design)
  - `current_status` (see status list below)
  - `filing_date` (nullable until actually filed with IPOPHIL)
  - `drive_folder_link`, `date_created`
  - `completion_date` (set when status reaches a terminal state — Approved w/ Certificate, Withdrawn, or Disapproved), `last_activity_date` (updated on any status change, remark, or defect action — used for archiving)
  - `archived` (boolean), `archived_date`

- **`submission_authors`** — ordered list of authors per submission
  - `id`, `submission_id`, `author_name`, `order_index`, `added_by_role` (student/admin)
  - **Students** can add and delete rows. **Admins** can only edit the text of an existing row — never add or delete one.

- **`status_history`** — append-only audit trail of every status change
  - `submission_id`, `old_status`, `new_status`, `changed_by`, `timestamp`
  - **Append-only rule:** never update or delete rows here — corrections happen by adding a new row

- **`remarks`** — general admin feedback tied to a submission (separate from formality-defect-specific comments, see below)
  - `submission_id`, `admin_id`, `comment_text`, `timestamp`

- **`certificates`** — issued certificate records
  - `submission_id`, `file_reference`, `issued_by`, `date_issued`

- **`problems`** — the separate "Problems" tracking layer, distinct from `current_status`
  - `id`, `submission_id`, `problem_type` (Substantive Examination Request / Formality Defect), `date_triggered`, `deadline_date`, `status` (open/resolved), `resolved_date`, `resolved_by`
  - This is the parent record; **Substantive Examination Request** problems don't need a separate table (deadline = filing_date + 18 months, single occurrence). **Formality Defect** problems do need more detail — see `formality_defects` below.

- **`formality_defects`** — one row per defect *round* (a submission can have multiple rounds over its life — iterative)
  - `id`, `problem_id` (links to the parent `problems` row), `submission_id`, `round_number`, `notice_date`, `deadline_date` (auto-calculated: notice_date + 2 months), `status` (open/resolved), `resolved_date`, `resolved_by`

- **`formality_defect_comments`** — its own comment thread, separate from general `remarks`, tied to a specific defect round
  - `formality_defect_id`, `admin_id`, `comment_text`, `timestamp`

- **`notifications_log`** — record of every email sent
  - `recipient`, `type`, `timestamp`, `delivery_status`

- **`admin_action_log`** — every meaningful admin action, for accountability
  - `admin_id`, `action_type`, `target_record`, `timestamp`
  - **Visible only to super_admin** — regular admins cannot see this at all, not even their own entries

- **`events`** — IP-related events/activities run by ITSO
  - `id`, `title`, `activity_type` (IP Awareness / Patent Search / Patent Drafting / IPA and PS / IPA and PD / PS and PD / IPS, PA, and PD / Others [free text if selected])
  - `mode_of_delivery` (Onsite / Online), `event_date`, `duration_days`, `duration_hours`
  - `participants_involved` (multi-select: Students / Researcher / Academic-Faculty / Entrepreneur-Business Person)
  - `sector` (multi-select: LGU / Government Agency / Academic Institution / MSME)
  - `participants_male`, `participants_female`, `participants_total`
  - `age_range` (multi-select: 13–20 / 21–30 / 31–45 / 46–59 / 60 and above)
  - `drive_link` (optional), `created_by`, `date_created`

- **`event_registrations`** — student sign-ups for upcoming events
  - `event_id`, `student_id`, `registration_date`

### 0.2 Authentication
- Google Sign-In (OAuth) via Supabase Auth, no domain restriction — the whitelist is the sole gate
- Post-login whitelist check: case-insensitive, trimmed match against `authorized_emails`
- Not on the whitelist → "You are not authorized — please contact ITSO," no access granted

### 0.3 Admin Bootstrapping
- First admin(s) seeded directly into the database before launch (one-time SQL insert / Supabase table editor)
- "Break-glass" super admin: one email hardcoded in environment config, always has super_admin access as a permanent safety net

### 0.4 Row Level Security (RLS)
Since the frontend calls Supabase directly, RLS is the entire access-control enforcement layer:

- Students: `SELECT`/`INSERT` only on their own rows (submissions, authors, event registrations)
- Admins: `SELECT`/`UPDATE` on all submissions, remarks, defects, problems, certificates, events
- Super_admin only: full control on `authorized_emails` and `admin_action_log`
- **Must be tested deliberately and thoroughly** — this is the highest-risk technical bug surface given the IP-sensitivity of the data

### 0.5 Role System
Three tiers: **Student / Admin / Super Admin**, stored on `authorized_emails`, checked on every relevant action.

---

## PHASE 1 — Homepage

| Feature | What it entails |
|---|---|
| **What is ITSO (explainer section)** | A plain-language block explaining what the Intellectual Property & Technology Support/Transfer Office does, its role as the go-between for students and IPOPHIL, and what this system is for — this is often the very first thing a new student sees, so it should orient them before they even look at a form |
| **Site directory / "what can I do here" navigation** | A set of clear, clickable entry points laid out on the homepage itself (not just a nav bar) that route the visitor to each major part of the site relevant to their role — e.g., for students: "Submit a Paper," "Track My Submissions," "View Upcoming Events"; for admins: "Review Papers Submitted," "View Analytics," "Manage Events," "Security." Each entry point is a short label plus one line describing what it does, not just a bare link |
| **Overview summary** | A condensed view of analytics (not the full dashboard) — a handful of headline numbers/charts pulled from Phase 7 |
| **Quick insight** | Short callouts — e.g., total active submissions, most recent activity — same "quick insight" data as the Analytics tab, just surfaced here for at-a-glance context |

*Confirmed: the Homepage Overview/Quick Insight sections show only the most important few numbers (e.g. total active submissions, action-required count, recent activity) — not an attempt to mirror the full Analytics tab. The role-based directory can reuse the same component with a different set of links depending on who's logged in.*

---

## PHASE 2 — Student Features

| Feature | What it entails |
|---|---|
| **Login** | Google Sign-In → whitelist check → session created if authorized |
| **Read sharing instructions (mandatory, every time)** | Popup fires every time "Submissions" is clicked, requires "I understand — proceed," includes a screenshot of the correct Drive sharing setting |
| **Read sharing instructions (anytime)** | Standing homepage link: "Read Document Sharing Instructions" |
| **Submit new paper** | Form: title, **college** (dropdown, seeded per the school's four colleges), **program** (dropdown, filters to only that college's programs once a college is selected — a cascading dropdown pair, not one flat list), filing type (dropdown: **Copyright / Patent / Utility Model / Industrial Design**), Google Drive folder link, required sharing-confirmation checkbox |
| **Enter authors** | Names entered **one at a time** — each entry is automatically added to a running author list as it's typed and confirmed. Student can add more or delete any entry. (Admin can later edit the text of an existing entry, but cannot add or remove authors.) |
| **Version handling** | New files go into the same Drive folder, named by convention (v1_initial, v2_revised, etc.) |
| **View my submissions** | List of the student's own submissions only (RLS-enforced) |
| **View submission detail** | Status, full timeline, remarks, filing date, any open Problems (SER pending / formality defect pending) and their deadlines |
| **Download certificate** | Enabled once issued |
| **Receive email notifications** | Status changes, remarks, certificate issuance, and (see Phase 6) problem-related deadlines |
| **Events tab (student view)** | See upcoming ITSO events, register for one with a click (writes to `event_registrations`) |

---

## PHASE 3 — Admin Features: Papers Submitted

This is the core admin workspace — the submissions list, with everything layered on top of it.

### 3.1 Quick overview strip (top of page)
Total Submitted · Total Approved · Total Pending · Action Required (submissions with an open Problem)

### 3.2 Filters
College, College Program (cascading — selecting a college narrows the program dropdown to that college's programs only), Status, Date Filed (range), Type Category (filing type) — all combinable.

### 3.3 Columns / classification shown per paper
Reference number, Student-submitted ID number, Title / Program, Author(s), Status, Date of Filing (with an alert indicator if a Problem is open on it)

### 3.4 Status list (color-coded)
Each status gets a distinct badge color for quick scanning:
1. Paper Submitted
2. Under Review
3. Submitted to IPOPHIL
4. Revisions Needed
5. Passed
6. Received eSOA
7. Paid
8. Approved with Certificate
9. Withdrawn
10. Disapproved

*(Confirmed: use a generic, standard color set — e.g. common status-badge colors like green/yellow/red/blue/gray — rather than a custom bespoke palette per status. Just needs to stay consistent across the whole app, including Homepage/Analytics badges.)*

### 3.5 PROBLEMS — separate tracking layer from status
A submission's `current_status` describes where it is in the pipeline. **Problems** are a separate, parallel flag layer that can be open *alongside* whatever status the submission is in:

| Problem type | Trigger | Deadline |
|---|---|---|
| **Substantive Examination Request (SER)** | Auto-triggered the moment `filing_date` is recorded | 18 months from filing date (see Phase 6) |
| **Formality Defect** | Admin manually logs a defect notice against a submission | 2 months from the notice date — and this can repeat: a new round starts each time a new defect is logged |

- The admin dashboard shows a **Problems count** per submission (and a system-wide Problems count in the overview strip's "Action Required" figure)
- Formality Defects are **iterative**: each round is its own record with its own deadline, its own comment thread (separate from general remarks), and its own resolved/open status
- Marking a Formality Defect resolved does not require deleting its history — it just closes that round; a new notice later starts a fresh round

### 3.6 Excel / PDF Export
Download button next to the submissions table, using the **exact same filter panel** as browsing (college, program, status, date range, type category):
1. Apply filters (or select specific rows via checkboxes)
2. Click "Download as Excel" or "Download as PDF"
3. Confirmation step shows record count before exporting
4. Excel exports client-side via SheetJS; PDF exports via a client-side PDF library (e.g., jsPDF) formatting the same filtered table
5. **Confirmed columns:** title, authors, date submitted, course/program (this is the finalized export column set — no other fields needed unless requested later)

### 3.7 Archiving
- A submission is flagged for archiving **10 years after `completion_date`** (reaching Approved/Withdrawn/Disapproved) **or 10 years of pure inactivity** (`last_activity_date` never advancing), whichever applies
- Archived papers move out of the main Papers Submitted table entirely — they no longer appear there once archived
- **Confirmed: this moves automatically** — no admin approval/review step needed at the 10-year mark. The submission is moved directly to the Archives page on its own, since the Unarchive action (Phase 3.8) already covers the case where something needs to come back

### 3.9 Archives — its own dedicated page (not a filter on Papers Submitted)
A separate tab/page in the admin nav, distinct from Papers Submitted, listing every archived paper:

- Same core columns as Papers Submitted (reference number, student ID, title/program, author(s), status at time of archiving, filing date) plus `archived_date` and the reason it was archived (completion-based vs. inactivity-based)
- Same filter/search capability as Papers Submitted (college, program, status, date range, type category), scoped to this archived set
- Same Excel/PDF export option, reusing the same export pattern as Phase 3.6, scoped to archived records
- Records here are **read-only for browsing/export**, but **admins (both admin and super_admin) get an "Unarchive" action** — restores a mistakenly archived record back into Papers Submitted (writes an entry to `admin_action_log`, and resets `archived`/`archived_date` on the submission record). Editing a paper's actual history otherwise stays locked once archived — unarchiving is the only write action available here.

### 3.8 Standard admin actions
Open a submission (view metadata, open Drive folder link, browse file versions by name), update status (mandatory remark only when moving to Revisions Needed; cascades to `status_history`, notification email, and dependent fields like `completion_date`), leave remarks, record filing date (auto-starts the SER 18-month clock), log a formality defect (auto-starts its own 2-month clock and comment thread), issue certificate.

---

## PHASE 4 — Security Tab (confirmed permission split)

| Feature | Regular Admin | Super Admin |
|---|---|---|
| Manage student whitelist | Yes | Yes |
| Manage admin/super_admin accounts | No | Yes only |
| View admin action log | No | Yes, full system-wide log |
| Role management (students) | Yes | Yes |
| Role management (admins/super_admins) | No | Yes only |

---

## PHASE 5 — Automated Notifications

- Status change → student
- New remark → student
- Certificate issued → student
- New submission received → admin(s)
- SER 18-month deadline reminder → admin(s), starting one month before the deadline, then monthly until marked handled (see Phase 6)
- Formality Defect deadline approaching/overdue → admin(s), starting one month before the deadline, then monthly until marked resolved
- Event registration confirmation → student (when they register for an event)

---

## PHASE 6 — Problems Module (Deadline Tracking)

### 6.1 Substantive Examination Request (18 months from filing date)
- Triggered automatically the moment `filing_date` is recorded
- `deadline_date` = filing_date + 18 months
- **Reminder emails start in the last month before the deadline** — i.e., no monthly nudging for the full 18 months; the first reminder fires once the submission enters month 17 (one month out from the deadline), then **continues monthly** for as long as it remains unresolved (so if it goes past the 18-month mark unhandled, it keeps nudging monthly until an admin acts)
- Marking handled requires a short one-line justification (e.g., "SER filed," "certificate already issued") — stored so there's a record of why the nudges stopped; it must never silently stop just because the deadline passed

### 6.2 Formality Defect (2 months from notice date, iterative)
- Manually triggered when an admin logs a defect against a submission
- `deadline_date` = notice_date + 2 months
- **Reminder emails start in the last month before the deadline** — i.e., the first reminder fires once the defect enters its final month (one month out from the 2-month deadline), then continues monthly if it remains unresolved past the deadline
- Each new defect notice on the same submission starts a **new round** — full history of all rounds is kept, never overwritten
- Has its **own dedicated comment thread** per round, separate from the submission's general remarks

Both problem types are logged in `notifications_log` like every other automated email, and both are architecturally time-triggered (scheduled jobs via `pg_cron`), not user-action-triggered — budget dedicated learning time for this pattern.

---

## PHASE 7 — Admin Analytics

### 7.1 Filters
Date range filter applies across the whole analytics view.

### 7.2 Core charts
- **Individual file type count** — how many Copyright / Patent / Utility Model / Industrial Design submissions
- **Submissions over time** — weekly / monthly / yearly view toggle, **color-coded by college**
- **Submissions by college** — comparative breakdown

### 7.3 Quick Insight panel
Total researches (submissions), most common type category, top college (by volume), recent activity

### 7.4 Recent Activity feed
A running log of the latest meaningful actions system-wide (new submissions, status changes, certificates issued) — a lighter, analytics-facing view, distinct from the super-admin-only `admin_action_log` audit trail

---

## PHASE 8 — Events Module (New Tab)

### 8.1 Student side
- View upcoming events
- Register for an event (writes an `event_registrations` row)

### 8.2 Admin side
- **Overview strip:** Total Events, Upcoming Events, Total Participants
- **Add new event** — form fields:
  - Event title
  - Type of activity: IP Awareness / Patent Search / Patent Drafting / IPA and PS / IPA and PD / PS and PD / IPS, PA, and PD / Others (free-text entry appears when "Others" is selected)
  - Mode of delivery: Onsite / Online
  - Event date, duration in days, duration in hours
  - Participants involved (multi-select): Students / Researcher / Academic-Faculty / Entrepreneur-Business Person
  - Sector (multi-select): LGU / Government Agency / Academic Institution / MSME
  - Number of participants: male, female, total
  - Age range (multi-select): 13–20 / 21–30 / 31–45 / 46–59 / 60 and above
  - Google Drive link (optional)
- **View, edit, delete events**
- **Filter:** by month/year, by type of activity
- **Search:** free-text keyword search across logged events
- **Event log table:** event title, type of activity, date, mode, participant count, hours — viewable and editable

---

## PHASE 9 — Hardening & Security Polish

- RLS policy testing — deliberately attempt cross-student and cross-admin-tier access, confirm it's blocked at the database level
- Whitelist input handling — lowercase/trim on storage and lookup
- Friendly error handling — expired sessions, failed emails, broken Drive links (a "report broken link" action)
- Drive link sharing safeguard — the mandatory popup, standing instructions page, and submission checkbox remain the only non-technical safeguard, since this isn't API-enforced

---

## Explicit Scope Boundaries

- **No data migration** from the old system — old system completes its own ongoing cases; new system takes all filings from an agreed cutoff date
- **No file storage/upload system** — Google Drive folder links only; confidentiality enforcement relies on student-followed sharing procedures, a documented boss-approved tradeoff
- **No password-based login** — Google Sign-In only
- **No in-app messaging/chat** — email remains the notification channel
- **No automated document review/approval** — pass/fail judgment stays human; the system automates logging, notifying, and record-keeping around that decision

---

## Remaining Open Decisions for Boss / ITSO

All five previously open items are now confirmed:

1. Export columns: title, authors, date submitted, course/program
2. Status colors: generic standard palette, not custom per-status colors
3. Archiving: automatic at the 10-year mark, no admin approval step, unarchive remains available
4. Homepage overview: shows only the most important few numbers, not the full analytics set
5. Events "Others" activity type: free-text entry confirmed acceptable

No open decisions remain blocking the build at this time.

---

## Confirmed Architecture Summary

- **Frontend:** React (Vite), calling Supabase directly from the browser — no separate backend server
- **Hosting:** GitHub Pages (free), auto-deployable via GitHub Actions on push
- **Database / Auth / Backend logic:** Supabase (Postgres + Auth + Edge Functions + `pg_cron`)
- **Email:** Resend (or similar), triggered via Supabase Edge Functions
- **Documents:** Google Drive folder links (no API integration) — stored as plain text URLs
- **Exports:** Client-side generation (SheetJS for Excel, jsPDF for PDF) — no separate export backend needed
- **Version control:** Private GitHub repository
- **Cost:** $0 on free tiers at this project's expected scale
