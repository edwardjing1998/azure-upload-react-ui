import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, authenticate, createSession, currentUser, listUploadedFiles, tokenStore, uploadFile } from "./api";
import type { AuthUser } from "./api";
import type { SelectedFile, UploadedFile, UploadSession } from "./types";

const CONCURRENCY_OPTIONS = [1, 2, 4, 6, 8];

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function relativePath(file: File): string {
  const browserPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return browserPath || file.name;
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(Boolean(tokenStore.get()));

  useEffect(() => {
    if (!tokenStore.get()) return;
    currentUser()
      .then(setUser)
      .catch(() => tokenStore.clear())
      .finally(() => setCheckingAuth(false));
  }, []);

  function authenticated(accessToken: string, authenticatedUser: AuthUser) {
    tokenStore.set(accessToken);
    setUser(authenticatedUser);
  }

  function logout() {
    tokenStore.clear();
    setUser(null);
  }

  if (checkingAuth) return <div className="auth-loading"><div className="spinner" aria-label="Checking authentication" /></div>;
  if (!user) return <AuthScreen onAuthenticated={authenticated} />;
  return <UploadWorkspace user={user} onLogout={logout} />;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string, user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const input = mode === "signup" ? form : { email: form.email, password: form.password };
      const result = await authenticate(mode, input);
      onAuthenticated(result.accessToken, result.user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  const signup = mode === "signup";
  return <main className="auth-shell">
    <section className="auth-brand">
      <div className="brand"><span>AZ</span> Azure Upload Workspace</div>
      <div><p className="eyebrow">SECURE FILE TRANSFER</p><h1>Sign in before your files move.</h1><p className="subtitle">Authenticated users can create tracked sessions and upload folders to Azure Storage.</p></div>
      <small>Spring Security · JWT authorization</small>
    </section>
    <section className="auth-content"><div className="auth-card">
      <div className="tabs">
        <button className={!signup ? "active" : ""} type="button" onClick={() => setMode("login")}>Log in</button>
        <button className={signup ? "active" : ""} type="button" onClick={() => setMode("signup")}>Sign up</button>
      </div>
      <p className="eyebrow">{signup ? "CREATE ACCOUNT" : "WELCOME BACK"}</p>
      <h2>{signup ? "Create your profile" : "Log in to upload"}</h2>
      <form onSubmit={submit}>
        {signup && <label>Full name<input required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>}
        <label>Email address<input required type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Password<input required type="password" autoComplete={signup ? "new-password" : "current-password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Log in"}</button>
      </form>
    </div></section>
  </main>;
}

function UploadWorkspace({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [folderName, setFolderName] = useState("test-files");
  const [validForHours, setValidForHours] = useState(24);
  const [concurrency, setConcurrency] = useState(4);
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [session, setSession] = useState<UploadSession | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [loadingUploadedFiles, setLoadingUploadedFiles] = useState(true);
  const aborters = useRef(new Map<string, () => void>());

  async function refreshUploadedFiles() {
    setLoadingUploadedFiles(true);
    try {
      setUploadedFiles(await listUploadedFiles());
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        onLogout();
        return;
      }
      setMessage(error instanceof Error ? error.message : "Unable to load uploaded files");
    } finally {
      setLoadingUploadedFiles(false);
    }
  }

  useEffect(() => {
    void refreshUploadedFiles();
  }, []);

  const totals = useMemo(() => {
    const bytes = files.reduce((sum, item) => sum + item.file.size, 0);
    const completed = files.filter((item) => item.state === "completed").length;
    const failed = files.filter((item) => item.state === "failed").length;
    const progressBytes = files.reduce(
      (sum, item) => sum + item.file.size * (item.progress / 100),
      0,
    );
    return {
      bytes,
      completed,
      failed,
      percent: bytes ? Math.round((progressBytes / bytes) * 100) : 0,
    };
  }, [files]);

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;

    const firstPath = relativePath(selected[0]);
    if (firstPath.includes("/")) setFolderName(firstPath.split("/")[0]);

    setFiles(
      selected.map((file, index) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
        file,
        relativePath: relativePath(file),
        state: "queued",
        progress: 0,
      })),
    );
    setSession(null);
    setMessage(null);
  }

  function updateFile(id: string, change: Partial<SelectedFile>) {
    setFiles((current) =>
      current.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  }

  async function handleCreateSession() {
    if (!files.length) {
      setMessage("Choose a folder or files before creating a session.");
      return;
    }
    setCreating(true);
    setMessage(null);
    try {
      const created = await createSession({
        folderName: folderName.trim() || "upload",
        expectedFiles: files.length,
        expectedBytes: totals.bytes,
        validForHours,
      });
      setSession(created);
      setMessage("Session created. Your files are ready to upload.");
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        onLogout();
        return;
      }
      setMessage(error instanceof Error ? error.message : "Unable to create session");
    } finally {
      setCreating(false);
    }
  }

  async function runUpload(items: SelectedFile[]) {
    if (!session) return;
    setUploading(true);
    setMessage(null);
    let cursor = 0;

    const worker = async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        updateFile(item.id, { state: "uploading", progress: 0, error: undefined });
        const task = uploadFile(session.sessionId, item.file, item.relativePath, (progress) =>
          updateFile(item.id, { progress }),
        );
        aborters.current.set(item.id, task.abort);
        try {
          const result = await task.promise;
          updateFile(item.id, { state: "completed", progress: 100, result });
          setUploadedFiles((current) => [result, ...current.filter((file) => file.fileId !== result.fileId)]);
        } catch (error) {
          updateFile(item.id, {
            state: "failed",
            error: error instanceof Error ? error.message : "Upload failed",
          });
        } finally {
          aborters.current.delete(item.id);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
    );
    setUploading(false);
    setMessage("Upload run finished. Review any failed files below.");
  }

  function cancelUploads() {
    aborters.current.forEach((abort) => abort());
    aborters.current.clear();
  }

  const pending = files.filter((item) => item.state === "queued");
  const failed = files.filter((item) => item.state === "failed");

  return (
    <main>
      <header className="hero">
        <div className="topbar"><div className="brand"><span>AZ</span> Azure Upload Workspace</div><div className="user-menu"><span>{user.name} · {user.role}</span><button className="logout" onClick={onLogout}>Log out</button></div></div>
        <div className="hero-copy">
          <p className="eyebrow">SESSION-BASED FILE TRANSFER</p>
          <h1>Move a folder to Azure,<br /><em>with every file accounted for.</em></h1>
          <p className="subtitle">
            Create a tracked upload session, preserve folder paths, and monitor each
            transfer from your browser.
          </p>
        </div>
      </header>

      <section className="workspace">
        <div className="step-card">
          <div className="step-number">01</div>
          <div className="step-content">
            <h2>Select your files</h2>
            <p>Folder structure is preserved in Azure Blob Storage.</p>
            <div className="picker-row">
              <label className="file-button">
                Choose folder
                <input
                  type="file"
                  multiple
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  onChange={chooseFiles}
                  disabled={uploading}
                />
              </label>
              <label className="file-button secondary">
                Choose files
                <input type="file" multiple onChange={chooseFiles} disabled={uploading} />
              </label>
              <div className="selection-summary">
                <strong>{files.length}</strong> files · <strong>{formatBytes(totals.bytes)}</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="step-card">
          <div className="step-number">02</div>
          <div className="step-content">
            <h2>Create an upload session</h2>
            <div className="form-grid">
              <label>Folder name<input value={folderName} onChange={(e) => setFolderName(e.target.value)} /></label>
              <label>Valid for (hours)<input type="number" min="1" max="168" value={validForHours} onChange={(e) => setValidForHours(Number(e.target.value))} /></label>
              <label>Parallel uploads<select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>{CONCURRENCY_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select></label>
            </div>
            <button className="primary" onClick={handleCreateSession} disabled={!files.length || creating || uploading}>
              {creating ? "Creating…" : session ? "Create a new session" : "Create session"}
            </button>
            {session && (
              <div className="session-ticket">
                <div><span>Session ID</span><code>{session.sessionId}</code></div>
                <div><span>Status</span><strong>{session.status}</strong></div>
                <div><span>Expires</span><strong>{new Date(session.expiresAt).toLocaleString()}</strong></div>
              </div>
            )}
          </div>
        </div>

        <div className="step-card">
          <div className="step-number">03</div>
          <div className="step-content">
            <div className="upload-heading">
              <div><h2>Upload and monitor</h2><p>{totals.completed} completed · {totals.failed} failed · {files.length - totals.completed - totals.failed} remaining</p></div>
              <div className="actions">
                {uploading ? <button className="danger" onClick={cancelUploads}>Cancel</button> : (
                  <>
                    <button className="primary" disabled={!session || !pending.length} onClick={() => runUpload(pending)}>Upload files</button>
                    {failed.length > 0 && <button className="secondary-action" onClick={() => runUpload(failed)}>Retry failed</button>}
                  </>
                )}
              </div>
            </div>
            <div className="overall-progress"><div style={{ width: `${totals.percent}%` }} /></div>
            <div className="progress-caption"><span>Overall progress</span><strong>{totals.percent}%</strong></div>

            <div className="file-list">
              {files.length === 0 ? <div className="empty">Your selected files will appear here.</div> : files.map((item) => (
                <div className="file-row" key={item.id}>
                  <span className={`status-dot ${item.state}`} />
                  <div className="file-details"><strong title={item.relativePath}>{item.relativePath}</strong><small>{item.error || formatBytes(item.file.size)}</small></div>
                  <div className="mini-progress"><div style={{ width: `${item.progress}%` }} /></div>
                  <span className="state">{item.state}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {message && <div className="notice" role="status">{message}</div>}
      </section>
      <section className="review-card">
        <div className="review-heading">
          <div><p className="eyebrow">UPLOADED FILES</p><h2>Review your image records</h2><p>These records are loaded from <code>public.user_uploaded_files</code>.</p></div>
          <button className="secondary-action" onClick={() => void refreshUploadedFiles()} disabled={loadingUploadedFiles}>{loadingUploadedFiles ? "Refreshing…" : "Refresh"}</button>
        </div>
        {loadingUploadedFiles ? <div className="empty">Loading uploaded files…</div> : uploadedFiles.length === 0 ? <div className="empty">No uploaded files found.</div> : (
          <div className="review-table-wrap"><table className="review-table"><thead><tr><th>File</th><th>Session</th><th>Size</th><th>Status</th><th>Updated</th></tr></thead><tbody>
            {uploadedFiles.map((file) => <tr key={file.fileId}><td><strong>{file.relativePath}</strong><small>{file.fileId}</small></td><td><code>{file.blobName.split("/")[0]}</code></td><td>{formatBytes(file.sizeBytes)}</td><td><span className={`review-status ${file.status.toLowerCase()}`}>{file.status}</span></td><td>{new Date(file.updatedAt).toLocaleString()}</td></tr>)}
          </tbody></table></div>
        )}
      </section>
      <footer>Files are sent directly to your Spring Boot API over HTTPS.</footer>
    </main>
  );
}
