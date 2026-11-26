import { useState } from "react";
import { isSupabaseConfigured } from "./lib/supabase";
import { signInWithGoogle } from "./lib/db";
import { ITSO_EMAIL, copyItsoEmail } from "./lib/contact";

type Props = { onEnter: (role: "Admin" | "Student") => void };

export default function LoginScreen({ onEnter }: Props) {
  const [signingIn, setSigningIn] = useState(false);
  const [copied, setCopied] = useState(false);
  const googleSignIn = () => {
    setSigningIn(true);
    if (isSupabaseConfigured) {
      void signInWithGoogle().catch(() => setSigningIn(false));
      return;
    }
    window.setTimeout(() => onEnter("Student"), 1100);
  };
  return <main className="login-page">
    <section className="login-story">
      <div className="login-brand"><span className="brand-logos"><img src={`${import.meta.env.BASE_URL}brand/qcu-logo.png`} alt="Quezon City University seal" /><img className="itso" src={`${import.meta.env.BASE_URL}brand/itso-logo.jpg`} alt="ITSO logo" /></span><span><strong>QCU <em>ITSO</em></strong><small>Innovation and Technology Support Office</small></span></div>
      <div className="login-story-content"><span className="login-kicker"><span /> QUEZON CITY UNIVERSITY · INNOVATION AND TECHNOLOGY SUPPORT OFFICE</span><h1>Great ideas<br />deserve to be<br /><em>protected.</em></h1><p>A dedicated space for QCU innovators to file research, track intellectual property, and turn possibilities into progress.</p><div className="login-story-rule" /><div className="login-story-foot"><span className="material-symbols-outlined">verified_user</span> Your ideas. Your ownership. Your future.</div></div>
      <div className="login-decor login-ring-one" /><div className="login-decor login-ring-two" /><div className="login-orb"><span className="material-symbols-outlined">lightbulb</span></div>
      <div className="login-bottom">© {new Date().getFullYear()} Quezon City University · Innovation and Technology Support Office</div>
    </section>
    <section className="login-form-side"><div className="login-form-wrap"><div className="login-mobile-logo"><span className="brand-logos small"><img src={`${import.meta.env.BASE_URL}brand/qcu-logo.png`} alt="QCU seal" /><img className="itso" src={`${import.meta.env.BASE_URL}brand/itso-logo.jpg`} alt="ITSO logo" /></span> QCU <em>ITSO</em></div><div className="login-eyebrow">WELCOME TO YOUR WORKSPACE</div><h2>Sign in to ITSO<span>.</span></h2><p className="login-subtitle">One secure place for every step of your IP journey.</p><div className="login-card"><div className="login-card-heading"><span className="material-symbols-outlined">lock_person</span><div><strong>Continue with your Google account</strong><small>Use an email authorized by the ITSO office</small></div></div><button className="google-signin" onClick={googleSignIn} disabled={signingIn}>{signingIn ? <span className="google-spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M21.35 12.22c0-.78-.07-1.52-.2-2.24H12v4.24h5.23a4.46 4.46 0 0 1-1.94 2.93v2.44h3.14c1.84-1.7 2.92-4.2 2.92-7.37Z"/><path fill="#34A853" d="M12 21.72c2.63 0 4.84-.87 6.45-2.36l-3.14-2.44c-.87.59-1.98.93-3.31.93a5.95 5.95 0 0 1-5.59-4.13H3.17v2.51A9.72 9.72 0 0 0 12 21.72Z"/><path fill="#FBBC05" d="M6.41 13.72a5.83 5.83 0 0 1 0-3.78V7.43H3.17a9.72 9.72 0 0 0 0 8.8l3.24-2.51Z"/><path fill="#EA4335" d="M12 5.81c1.43 0 2.71.49 3.71 1.45l2.79-2.79A9.33 9.33 0 0 0 12 1.94a9.72 9.72 0 0 0-8.83 5.49l3.24 2.51A5.95 5.95 0 0 1 12 5.81Z"/></svg>}{signingIn ? "Signing you in…" : "Continue with Google"} <span className="material-symbols-outlined">{signingIn ? "hourglass_top" : "arrow_forward"}</span></button>{!isSupabaseConfigured && <><div className="login-divider"><span>OR CONTINUE AS</span></div><p className="login-preview-description">Choose a workspace role to explore the system.</p><div className="login-preview-buttons"><button onClick={() => onEnter("Student")}><span className="material-symbols-outlined">school</span> Continue as Student</button><button onClick={() => onEnter("Admin")}><span className="material-symbols-outlined">admin_panel_settings</span> Continue as Admin</button></div></>}</div><div className="login-help"><span className="material-symbols-outlined">help_outline</span> Not on the authorized list? <button type="button" className="contact-link" onClick={() => void copyItsoEmail().then(ok => { setCopied(ok); window.setTimeout(() => setCopied(false), 2500); })} title="Copy ITSO's email address">{copied ? "Email copied!" : `Contact ITSO (${ITSO_EMAIL})`}</button></div></div></section>
  </main>;
}
