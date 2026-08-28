/**
 * Sign in / create account.
 *
 * One component for both modes — the fields and layout are identical, and the
 * only differences are the submit handler and the copy, so splitting them
 * would duplicate the form for no benefit.
 */

import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CircuitBoard } from "lucide-react";

import { ApiError } from "../api";
import { useAuth } from "../auth/AuthContext";

type Mode = "signin" | "signup";

function SignIn() {
  const { signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Where the user was headed before being redirected here, so signing in
  // resumes what they were doing instead of dumping them on the dashboard.
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (mode === "signin") {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
      navigate(from, { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="auth-brand">
          <CircuitBoard size={22} />
          <span>CircuitLoop</span>
        </div>

        <h3>{mode === "signin" ? "Sign in" : "Create your account"}</h3>
        <p className="auth-subtitle">
          {mode === "signin"
            ? "Sign in to reach your scan history."
            : "Your scans and their images are saved to your account."}
        </p>

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </label>

        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={8}
            required
          />
          {mode === "signup" && <small>At least 8 characters.</small>}
        </label>

        {error !== null && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="auth-submit" disabled={submitting}>
          {submitting ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          className="auth-toggle"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
        >
          {mode === "signin"
            ? "Need an account? Create one"
            : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}

export default SignIn;
