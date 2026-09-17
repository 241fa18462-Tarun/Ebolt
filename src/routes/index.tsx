import { FormEvent, ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { create } from "zustand";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  Copy,
  Eye,
  EyeOff,
  FileText,
  Home,
  LogOut,
  NotebookText,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

export const Route = createFileRoute("/")({ component: App });

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}


export type EboltPage = "home" | "new" | "saved" | "chat";

export type Note = {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

export type Account = {
  email: string;
  password: string;
  fullName?: string;
};

export type Toast = {
  id: number;
  message: string;
  tone: "ok" | "warn";
  actionLabel?: string;
  action?: () => void;
};

type ChatMsg = { role: "user" | "bot"; text: string };

export type SortKey = "updated" | "created" | "title";

const NOTES_PREFIX = "ebolt_notes_v2::";
const LEGACY_NOTES_KEY = "ebolt_notes";
const REMEMBER_KEY = "ebolt_remember";
const ACCOUNTS_KEY = "ebolt_accounts";

const BLANK_TITLE = "Untitled note";
const BLANK_TEXT = "";

/* ------------------------------------------------------------------ */
/* storage helpers                                                     */
/* ------------------------------------------------------------------ */

function hasStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

export function newId() {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return `note_${crypto.randomUUID()}`;
    }
  } catch {
    /* ignore */
  }
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function notesKey(email: string) {
  return `${NOTES_PREFIX}${email.trim().toLowerCase()}`;
}

/**
 * Coerce whatever is in storage into valid notes. Anything that is not an
 * object is dropped instead of throwing, ids are only invented when genuinely
 * missing, and duplicate ids are repaired so edit/delete can never hit the
 * wrong record.
 */
function coerceNotes(raw: unknown): { notes: Note[]; changed: boolean } {
  if (!Array.isArray(raw)) return { notes: [], changed: false };
  const seen = new Set<string>();
  let changed = false;
  const notes: Note[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      changed = true;
      continue;
    }
    const n = entry as Record<string, unknown>;

    let id = typeof n.id === "string" && n.id.trim() ? n.id : "";
    if (!id || seen.has(id)) {
      id = newId();
      changed = true;
    }
    seen.add(id);

    // v1 stored `updated` as a locale string, which cannot be sorted and
    // differs between server and client. Migrate it to epoch milliseconds.
    let updatedAt = typeof n.updatedAt === "number" ? n.updatedAt : NaN;
    if (!Number.isFinite(updatedAt)) {
      const parsed = typeof n.updated === "string" ? Date.parse(n.updated) : NaN;
      updatedAt = Number.isFinite(parsed) ? parsed : Date.now();
      changed = true;
    }
    let createdAt = typeof n.createdAt === "number" ? n.createdAt : NaN;
    if (!Number.isFinite(createdAt)) {
      createdAt = updatedAt;
      changed = true;
    }

    notes.push({
      id,
      title: typeof n.title === "string" && n.title.trim() ? n.title : BLANK_TITLE,
      text: typeof n.text === "string" ? n.text : "",
      createdAt,
      updatedAt,
    });
  }

  return { notes, changed };
}

function loadNotes(email: string): Note[] {
  if (!hasStorage()) return [];
  const key = notesKey(email);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    return [];
  }

  // One-time migration: v1 kept every account's notes in a single global
  // bucket, so signing in as a second person exposed the first person's notes.
  if (stored === null) {
    try {
      const legacy = localStorage.getItem(LEGACY_NOTES_KEY);
      if (legacy !== null) {
        const migrated = coerceNotes(safeParse(legacy)).notes;
        saveNotes(email, migrated);
        localStorage.removeItem(LEGACY_NOTES_KEY);
        return sortNotes(migrated, "updated");
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  const { notes, changed } = coerceNotes(safeParse(stored));
  if (changed) saveNotes(email, notes);
  return sortNotes(notes, "updated");
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Returns false when the write failed (private mode, quota exceeded, ...). */
function saveNotes(email: string, notes: Note[]): boolean {
  if (!hasStorage()) return false;
  try {
    localStorage.setItem(notesKey(email), JSON.stringify(notes));
    return true;
  } catch {
    return false;
  }
}

export function sortNotes(notes: Note[], key: SortKey): Note[] {
  const copy = [...notes];
  if (key === "title") {
    copy.sort((a, b) => a.title.localeCompare(b.title) || b.updatedAt - a.updatedAt);
  } else if (key === "created") {
    copy.sort((a, b) => b.createdAt - a.createdAt);
  } else {
    copy.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return copy;
}

export function readAccounts(): Record<string, Account> {
  if (!hasStorage()) return {};
  try {
    const parsed = safeParse(localStorage.getItem(ACCOUNTS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, Account>;
  } catch {
    return {};
  }
}

export function writeAccounts(accounts: Record<string, Account>) {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    /* ignore */
  }
}

export function tryRememberedUser(): Account | null {
  if (!hasStorage()) return null;
  const parsed = safeParse(localStorage.getItem(REMEMBER_KEY) || "null");
  if (!parsed || typeof parsed !== "object") return null;
  const u = parsed as Partial<Account>;
  if (typeof u.email !== "string" || typeof u.password !== "string") return null;
  return { email: u.email, password: u.password, fullName: u.fullName };
}

export function rememberUser(user: Account) {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function displayName(email: string, fullName?: string) {
  if (fullName?.trim()) return fullName.trim();
  return email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Formatted on the client only — never during SSR, so locales cannot mismatch. */
export function formatWhen(ts: number) {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function wordCount(text: string) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

export type State = {
  user: Account | null;
  hydrated: boolean;
  page: EboltPage;
  notes: Note[];
  currentNoteId: string | null;
  draftTitle: string;
  draftText: string;
  /** Title+text as of the last save/open — used to detect unsaved changes. */
  baseline: { title: string; text: string };
  query: string;
  sort: SortKey;
  toast: Toast | null;
  chat: ChatMsg[];

  login: (user: Account) => void;
  logout: () => void;
  hydrateNotes: () => void;
  go: (page: EboltPage) => void;
  setDraftTitle: (v: string) => void;
  setDraftText: (v: string) => void;
  newDraft: () => void;
  newNote: () => void;
  saveNote: (opts?: { asNew?: boolean }) => void;
  loadNote: (id: string) => void;
  duplicateNote: (id: string) => void;
  deleteNote: (id: string) => void;
  setQuery: (v: string) => void;
  setSort: (v: SortKey) => void;
  showToast: (message: string, opts?: Partial<Omit<Toast, "id" | "message">>) => void;
  dismissToast: () => void;
  sendChat: (text: string) => void;
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastSeq = 0;

const GREETING: ChatMsg = {
  role: "bot",
  text: "Hi! I'm your Ebolt assistant. Tell me what you want to write, organize or improve.",
};

export const useEbolt = create<State>((set, get) => ({
  // Deterministic initial state: reading localStorage here would make the
  // server and the first client render disagree and break hydration.
  user: null,
  hydrated: false,
  page: "home",
  notes: [],
  currentNoteId: null,
  draftTitle: BLANK_TITLE,
  draftText: BLANK_TEXT,
  baseline: { title: BLANK_TITLE, text: BLANK_TEXT },
  query: "",
  sort: "updated",
  toast: null,
  chat: [GREETING],

  login: (user) => {
    set({
      user,
      page: "home",
      notes: [],
      hydrated: false,
      currentNoteId: null,
      draftTitle: BLANK_TITLE,
      draftText: BLANK_TEXT,
      baseline: { title: BLANK_TITLE, text: BLANK_TEXT },
      query: "",
      chat: [GREETING],
    });
    get().hydrateNotes();
  },

  logout: () => {
    if (hasStorage()) {
      try {
        localStorage.removeItem(REMEMBER_KEY);
      } catch {
        /* ignore */
      }
    }
    // Clear notes from memory too, so the next person on this device never
    // sees the previous account's notes flash on screen.
    set({
      user: null,
      hydrated: false,
      page: "home",
      notes: [],
      currentNoteId: null,
      draftTitle: BLANK_TITLE,
      draftText: BLANK_TEXT,
      baseline: { title: BLANK_TITLE, text: BLANK_TEXT },
      query: "",
      chat: [GREETING],
    });
  },

  hydrateNotes: () => {
    const user = get().user;
    if (!user || typeof window === "undefined") return;
    set({ notes: loadNotes(user.email), hydrated: true });
  },

  go: (page) => set({ page }),
  setDraftTitle: (draftTitle) => set({ draftTitle }),
  setDraftText: (draftText) => set({ draftText }),

  /** Reset the editor without navigating — used by Home's quick pad. */
  newDraft: () =>
    set({
      currentNoteId: null,
      draftTitle: BLANK_TITLE,
      draftText: BLANK_TEXT,
      baseline: { title: BLANK_TITLE, text: BLANK_TEXT },
    }),

  newNote: () => {
    get().newDraft();
    set({ page: "new" });
  },

  saveNote: ({ asNew = false } = {}) => {
    const { draftTitle, draftText, currentNoteId, notes, user } = get();
    if (!user) return;

    // An untouched draft has the placeholder title and no body — saving it
    // would just litter the list with blank "Untitled note" cards.
    const titled = draftTitle.trim() && draftTitle.trim() !== BLANK_TITLE;
    if (!titled && !draftText.trim()) {
      get().showToast("Write something first, then save", { tone: "warn" });
      return;
    }

    const title = draftTitle.trim() || BLANK_TITLE;
    const text = draftText;

    const now = Date.now();
    let next: Note[];
    let id = asNew ? null : currentNoteId;
    const existingIndex = id ? notes.findIndex((n) => n.id === id) : -1;

    if (id && existingIndex >= 0) {
      next = [...notes];
      next[existingIndex] = { ...next[existingIndex], title, text, updatedAt: now };
    } else {
      // Either a brand-new note, an explicit "save as new", or a stale id whose
      // note was deleted elsewhere — all of these create a fresh record.
      id = newId();
      next = [{ id, title, text, createdAt: now, updatedAt: now }, ...notes];
    }

    const ok = saveNotes(user.email, next);
    if (!ok) {
      get().showToast("Couldn't save — device storage is full or blocked", { tone: "warn" });
      return;
    }

    set({
      notes: sortNotes(next, get().sort),
      currentNoteId: id,
      draftTitle: title,
      // Never rewrite the body the user is typing into; only the baseline moves.
      baseline: { title, text },
    });
    get().showToast(existingIndex >= 0 ? "Note updated" : "Note saved");
  },

  loadNote: (id) => {
    const n = get().notes.find((x) => x.id === id);
    if (!n) {
      get().showToast("That note no longer exists", { tone: "warn" });
      return;
    }
    set({
      currentNoteId: n.id,
      draftTitle: n.title,
      draftText: n.text,
      baseline: { title: n.title, text: n.text },
      page: "new",
    });
  },

  duplicateNote: (id) => {
    const { notes, user } = get();
    const source = notes.find((n) => n.id === id);
    if (!source || !user) return;
    const now = Date.now();
    const copy: Note = {
      id: newId(),
      title: `${source.title} (copy)`,
      text: source.text,
      createdAt: now,
      updatedAt: now,
    };
    const next = [copy, ...notes];
    if (!saveNotes(user.email, next)) {
      get().showToast("Couldn't duplicate — storage is full or blocked", { tone: "warn" });
      return;
    }
    set({ notes: sortNotes(next, get().sort) });
    get().showToast("Note duplicated");
  },

  deleteNote: (id) => {
    const { notes, currentNoteId, user } = get();
    if (!user) return;
    const removed = notes.find((n) => n.id === id);
    if (!removed) return;

    const next = notes.filter((n) => n.id !== id);
    if (!saveNotes(user.email, next)) {
      get().showToast("Couldn't delete — storage is blocked", { tone: "warn" });
      return;
    }

    if (currentNoteId === id) {
      set({
        notes: next,
        currentNoteId: null,
        draftTitle: BLANK_TITLE,
        draftText: BLANK_TEXT,
        baseline: { title: BLANK_TITLE, text: BLANK_TEXT },
      });
    } else {
      set({ notes: next });
    }

    get().showToast(`Deleted "${removed.title}"`, {
      actionLabel: "Undo",
      action: () => {
        const state = get();
        if (!state.user) return;
        const restored = sortNotes([...state.notes, removed], state.sort);
        if (!saveNotes(state.user.email, restored)) return;
        set({ notes: restored });
        state.showToast("Note restored");
      },
    });
  },

  setQuery: (query) => set({ query }),
  setSort: (sort) => set({ sort, notes: sortNotes(get().notes, sort) }),

  showToast: (message, opts = {}) => {
    if (toastTimer) clearTimeout(toastTimer);
    const toast: Toast = {
      id: ++toastSeq,
      message,
      tone: opts.tone ?? "ok",
      actionLabel: opts.actionLabel,
      action: opts.action,
    };
    set({ toast });
    // Leave undoable toasts on screen long enough to actually be clicked.
    toastTimer = setTimeout(() => {
      if (get().toast?.id === toast.id) set({ toast: null });
    }, toast.action ? 6000 : 2400);
  },

  dismissToast: () => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: null });
  },

  sendChat: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const notes = get().notes;
    const lower = trimmed.toLowerCase();
    let reply =
      "I can help you shape that idea. Try capturing the main goal, the next action and any key details in a note.";
    if (lower.includes("how many") || lower.includes("count")) {
      reply = `You have ${notes.length} saved ${notes.length === 1 ? "note" : "notes"} in this workspace.`;
    } else if (lower.includes("delete") || lower.includes("remove")) {
      reply = "Open Saved Notes, then use the delete button on a card. You get an Undo for a few seconds.";
    } else if (lower.includes("edit") || lower.includes("update")) {
      reply = "Click any saved note to open it in the editor. Save writes it back to the same note.";
    } else if (notes.length) {
      const match = notes.find(
        (n) => n.title.toLowerCase().includes(lower) || n.text.toLowerCase().includes(lower),
      );
      if (match) reply = `That looks related to your note "${match.title}". Open it from Saved Notes to continue.`;
    }
    set({ chat: [...get().chat, { role: "user", text: trimmed }, { role: "bot", text: reply }] });
  },
}));

/** True when the editor has changes that have not been written to storage. */
export function selectDirty(s: State) {
  return s.draftTitle !== s.baseline.title || s.draftText !== s.baseline.text;
}

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function LoginScreen() {
  const login = useEbolt((s) => s.login);
  const [signup, setSignup] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const em = email.trim().toLowerCase();
    if (!validEmail(em)) {
      setError("Please enter a valid email address.");
      return;
    }
    const accounts = readAccounts();
    if (signup) {
      if (!fullName.trim()) {
        setError("Please enter your full name.");
        return;
      }
      if (!password) {
        setError("Please enter a password.");
        return;
      }
      if (password !== confirm) {
        setError("Passwords do not match.");
        return;
      }
      if (accounts[em]) {
        setError("That account already exists. Please sign in.");
        return;
      }
      const user = { email: em, password, fullName: fullName.trim() };
      accounts[em] = user;
      writeAccounts(accounts);
      if (remember) rememberUser(user);
      login(user);
      return;
    }
    const account = accounts[em];
    const expected = account ? account.password : em.split("@")[0];
    if (password !== expected) {
      setError("Incorrect password. For the demo, use the text before @ as the password.");
      return;
    }
    const user = account || { email: em, password: expected, fullName: displayName(em) };
    if (remember) rememberUser(user);
    login(user);
  }

  return (
    <div className="login-sky relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8">
      <div className="relative grid w-full max-w-[1050px] overflow-hidden rounded-[34px] border border-white/15 bg-linear-to-br from-[#071923]/98 to-[#0a242f]/98 shadow-[0_30px_80px_rgb(4_35_48_/_0.3)] md:grid-cols-2">
        <section className="relative z-2 px-7 py-10 sm:px-12">
          <div className="mb-14 flex items-center gap-3">
            <img
              src="/ebolt-logo.png"
              alt=""
              className="size-[42px] rounded-full border-2 border-white/70 object-cover"
            />
            <span className="text-[15px] font-extrabold tracking-[1.8px]">EBOLT</span>
          </div>
          <div className="mb-8">
            <h1 className="mb-2 font-extrabold tracking-[2px] text-sky">
              {signup ? "CREATE ACCOUNT" : "WELCOME BACK!"}
            </h1>
            <p className="text-[13px] text-muted">
              {signup ? (
                <>
                  Already have an account?{" "}
                  <button type="button" className="font-bold text-sky" onClick={() => setSignup(false)}>
                    Sign in
                  </button>
                </>
              ) : (
                <>
                  Don't have an account?{" "}
                  <button type="button" className="font-bold text-sky" onClick={() => setSignup(true)}>
                    Sign up
                  </button>
                </>
              )}
            </p>
          </div>
          <form onSubmit={onSubmit} className="space-y-5">
            {signup && (
              <label className="field-in block">
                <span className="mb-2 block text-[12px] font-bold tracking-[1.2px]">FULL NAME</span>
                <input
                  className="h-12 w-full rounded-full border border-sky/70 bg-white/5 px-4 text-cream outline-none placeholder:text-dim focus:border-white"
                  placeholder="Your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </label>
            )}
            <label className="field-in block">
              <span className="mb-2 block text-[12px] font-bold tracking-[1.2px]">USERNAME</span>
              <input
                type="email"
                required
                className="h-12 w-full rounded-full border border-sky/70 bg-white/5 px-4 text-cream outline-none placeholder:text-dim focus:border-white"
                placeholder="example@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="field-in block">
              <span className="mb-2 block text-[12px] font-bold tracking-[1.2px]">PASSWORD</span>
              <span className="relative block">
                <input
                  type={showPass ? "text" : "password"}
                  required
                  className="h-12 w-full rounded-full border border-sky/70 bg-white/5 px-4 pr-12 text-cream outline-none placeholder:text-dim focus:border-white"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="absolute top-1/2 right-3 grid size-9 -translate-y-1/2 place-items-center rounded-full text-sky"
                  onClick={() => setShowPass((v) => !v)}
                  aria-label={showPass ? "Hide password" : "Show password"}
                >
                  {showPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </span>
            </label>
            {signup && (
              <label className="field-in block">
                <span className="mb-2 block text-[12px] font-bold tracking-[1.2px]">CONFIRM PASSWORD</span>
                <input
                  type={showPass ? "text" : "password"}
                  className="h-12 w-full rounded-full border border-sky/70 bg-white/5 px-4 text-cream outline-none placeholder:text-dim"
                  placeholder="Repeat your password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </label>
            )}
            {!signup && (
              <div className="flex items-center justify-between text-[10px] text-muted">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-sky"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                  />
                  Remember me
                </label>
                <span className="font-bold text-sky">Forgot password?</span>
              </div>
            )}
            {error && <p className="text-xs text-danger">{error}</p>}
            <button type="submit" className="pill pill-primary h-12 w-full text-[11px] tracking-[1px]">
              {signup ? "CREATE ACCOUNT" : "SIGN IN"}
            </button>
            <p className="text-center text-[10px] text-dim">
              Demo: use the text before @ as the password (e.g. ravi@gmail.com / ravi)
            </p>
          </form>
        </section>
        <section className="relative hidden min-h-[420px] items-center justify-center md:flex">
          <img
            src="/ebolt-logo.png"
            alt=""
            className="size-[280px] rounded-full border-[10px] border-white object-cover shadow-[0_25px_70px_rgb(0_0_0_/_0.34)]"
          />
        </section>
      </div>
    </div>
  );
}

type Props = {
  size?: number;
  className?: string;
};

export function Orb({ size = 42, className }: Props) {
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full orb-ring", className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <video
        className="h-full w-full scale-110 object-cover"
        src="/orb.mp4"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
      />
    </span>
  );
}

type Particle = {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  hue: number;
  phase: number;
};

type Streak = {
  x: number;
  y: number;
  len: number;
  speed: number;
  life: number;
  maxLife: number;
  angle: number;
};

const HUES = [193, 178, 205, 262];

/**
 * Continuously animating backdrop: drifting light motes that link into a
 * constellation mesh, with occasional streaks crossing the field. Drawn on a
 * single canvas so the cost stays flat no matter how many motes are on screen.
 *
 * Pauses entirely when the tab is hidden and draws one static frame when the
 * viewer prefers reduced motion.
 */
export function AuroraCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let particles: Particle[] = [];
    let streaks: Streak[] = [];
    let frame = 0;
    let running = true;
    let last = 0;

    function seed() {
      const area = width * height;
      // Roughly one mote per 14k css pixels, clamped so phones stay light.
      const count = Math.max(16, Math.min(94, Math.round(area / 11000)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.7 + 0.6,
        vx: (Math.random() - 0.5) * 0.14,
        vy: -(Math.random() * 0.17 + 0.04),
        hue: HUES[Math.floor(Math.random() * HUES.length)],
        phase: Math.random() * Math.PI * 2,
      }));
      streaks = [];
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function spawnStreak() {
      const fromLeft = Math.random() > 0.5;
      streaks.push({
        x: fromLeft ? -60 : width + 60,
        y: Math.random() * height * 0.7,
        len: 90 + Math.random() * 130,
        speed: (fromLeft ? 1 : -1) * (2.6 + Math.random() * 2.2),
        life: 0,
        maxLife: 90 + Math.random() * 50,
        angle: (fromLeft ? 1 : -1) * (0.12 + Math.random() * 0.1),
      });
    }

    function draw(now: number) {
      if (!running) return;
      const dt = last ? Math.min((now - last) / 16.667, 2.5) : 1;
      last = now;
      frame += dt;

      ctx!.clearRect(0, 0, width, height);

      // Constellation mesh — drawn before the motes so lines sit underneath.
      ctx!.lineWidth = 1;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 > 13000) continue;
          const alpha = (1 - dist2 / 13000) * 0.3;
          ctx!.strokeStyle = `hsla(193, 82%, 76%, ${alpha})`;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();
        }
      }

      for (const p of particles) {
        if (!reduced) {
          p.x += p.vx * dt + Math.sin((frame + p.phase * 40) / 90) * 0.12 * dt;
          p.y += p.vy * dt;
          if (p.y < -12) {
            p.y = height + 12;
            p.x = Math.random() * width;
          }
          if (p.x < -12) p.x = width + 12;
          if (p.x > width + 12) p.x = -12;
        }

        const twinkle = reduced ? 0.6 : 0.45 + Math.sin(frame / 40 + p.phase) * 0.3;
        const glow = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 7);
        glow.addColorStop(0, `hsla(${p.hue}, 92%, 82%, ${0.55 * twinkle})`);
        glow.addColorStop(1, `hsla(${p.hue}, 92%, 72%, 0)`);
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r * 7, 0, Math.PI * 2);
        ctx!.fill();

        ctx!.fillStyle = `hsla(${p.hue}, 100%, 92%, ${0.85 * twinkle})`;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fill();
      }

      if (!reduced) {
        if (streaks.length < 2 && Math.random() < 0.006 * dt) spawnStreak();

        for (const s of streaks) {
          s.life += dt;
          s.x += s.speed * dt;
          s.y += s.angle * Math.abs(s.speed) * dt;
          const fade = 1 - s.life / s.maxLife;
          if (fade <= 0) continue;
          const tailX = s.x - Math.sign(s.speed) * s.len;
          const tailY = s.y - s.angle * s.len;
          const grad = ctx!.createLinearGradient(tailX, tailY, s.x, s.y);
          grad.addColorStop(0, "hsla(193, 90%, 80%, 0)");
          grad.addColorStop(1, `hsla(188, 100%, 88%, ${0.5 * fade})`);
          ctx!.strokeStyle = grad;
          ctx!.lineWidth = 1.6;
          ctx!.beginPath();
          ctx!.moveTo(tailX, tailY);
          ctx!.lineTo(s.x, s.y);
          ctx!.stroke();
        }
        streaks = streaks.filter((s) => s.life < s.maxLife && s.x > -400 && s.x < width + 400);

        raf = requestAnimationFrame(draw);
      }
    }

    let raf = 0;
    resize();
    raf = requestAnimationFrame(draw);

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            resize();
            if (reduced) {
              cancelAnimationFrame(raf);
              raf = requestAnimationFrame(draw);
            }
          })
        : null;
    observer?.observe(canvas);
    window.addEventListener("resize", resize);

    // Stop burning frames while the tab is in the background.
    function onVisibility() {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        last = 0;
        raf = requestAnimationFrame(draw);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className={cn("pointer-events-none absolute inset-0 h-full w-full", className)} aria-hidden="true" />;
}

/**
 * The full hero backdrop: layered colour fields that drift against each other,
 * a slow-scrolling grid for depth, and the canvas mesh on top.
 */
export function AuroraBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="aurora-veil aurora-veil-a" />
      <div className="aurora-veil aurora-veil-b" />
      <div className="aurora-veil aurora-veil-c" />
      <div className="aurora-grid" />
      <AuroraCanvas className="aurora-mesh" />
      <div className="aurora-core" />
      <div className="aurora-sheen" />
      <div className="aurora-vignette" />
    </div>
  );
}

type BaseProps = {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
};

function useDialogBehaviour(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const focusables = node.querySelectorAll<HTMLElement>(
        'button, input, textarea, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onClose]);

  return ref;
}

function Shell({
  open,
  title,
  description,
  onClose,
  children,
}: BaseProps & { children: ReactNode }) {
  const ref = useDialogBehaviour(open, onClose);
  const titleId = useId();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center p-4">
      <div className="dialog-scrim absolute inset-0" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog-panel relative w-full max-w-[420px] rounded-[22px] p-6"
      >
        <h2 id={titleId} className="text-[16px] font-semibold tracking-tight text-cream">
          {title}
        </h2>
        {description && <div className="mt-2 text-[12px] leading-6 text-muted">{description}</div>}
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onClose,
}: BaseProps & {
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Shell open={open} title={title} description={description} onClose={onClose}>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" className="pill" onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          type="button"
          data-autofocus
          className={cn("pill", destructive ? "pill-danger" : "pill-primary")}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Shell>
  );
}

export function PromptDialog({
  open,
  title,
  description,
  initialValue = "",
  placeholder,
  submitLabel = "Save",
  onSubmit,
  onClose,
}: BaseProps & {
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  }

  return (
    <Shell open={open} title={title} description={description} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <input
          data-autofocus
          className="mt-5 h-11 w-full rounded-xl border border-sky/25 bg-white/5 px-3.5 text-[13px] text-cream outline-none focus:border-sky/60"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="pill" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="pill pill-primary" disabled={!value.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Shell>
  );
}

const NAV: { id: EboltPage; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "new", label: "Editor", icon: Plus },
  { id: "saved", label: "Notes", icon: NotebookText },
  { id: "chat", label: "Assistant", icon: Sparkles },
];

export function Workspace() {
  const user = useEbolt((s) => s.user);
  const page = useEbolt((s) => s.page);
  const go = useEbolt((s) => s.go);
  const logout = useEbolt((s) => s.logout);
  const hydrateNotes = useEbolt((s) => s.hydrateNotes);
  const newNote = useEbolt((s) => s.newNote);
  const saveNote = useEbolt((s) => s.saveNote);
  const [confirmLogout, setConfirmLogout] = useState(false);

  // Notes are read from storage here rather than in the store's initial state,
  // so the server render and the first client render always agree.
  useEffect(() => {
    hydrateNotes();
  }, [hydrateNotes]);

  // Ctrl/Cmd+S saves from anywhere in the workspace.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveNote();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveNote]);

  if (!user) return null;
  const name = displayName(user.email, user.fullName);
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="app-bg min-h-screen text-cream">
      <div className="grid min-h-screen lg:grid-cols-[228px_1fr]">
        <aside className="sticky top-0 z-20 hidden h-screen flex-col border-r border-sky/12 bg-ink/94 px-3.5 py-6 backdrop-blur-xl lg:flex">
          <div className="mb-6 flex items-center gap-3 px-1.5">
            <img src="/ebolt-logo.png" alt="" className="size-10 rounded-full border border-white/50 object-cover" />
            <span className="text-[15px] font-bold tracking-[3px]">Ebolt</span>
          </div>

          <div className="mb-5 flex items-center gap-2.5 rounded-2xl border border-sky/12 bg-white/4 p-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-full bg-linear-to-br from-ice to-sky text-[12px] font-bold text-navy">
              {initial}
            </div>
            <div className="min-w-0">
              <b className="block truncate text-[12px] font-semibold">{name}</b>
              <small className="block truncate text-[10px] text-dim">{user.email}</small>
            </div>
          </div>

          <nav className="grid gap-1" aria-label="Workspace sections">
            {NAV.map((item) => {
              const Icon = item.icon;
              const active = page === item.id;
              return (
                <button
                  key={item.id}
                  aria-current={active ? "page" : undefined}
                  onClick={() => (item.id === "new" ? newNote() : go(item.id))}
                  className={cn(
                    "flex h-11 items-center gap-3 rounded-[13px] px-3 text-left text-[12px] font-medium text-muted transition-colors hover:text-cream",
                    active && "bg-sky/10 text-cream",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-lg bg-sky/10 text-sky transition-colors",
                      active && "bg-linear-to-br from-sky-2 to-ice text-navy",
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto">
            <NoteMeter />
            <button
              className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/8 bg-white/4 text-[11px] font-medium text-muted transition-colors hover:border-white/20 hover:text-cream"
              onClick={() => setConfirmLogout(true)}
            >
              <LogOut className="size-3.5" /> Sign out
            </button>
          </div>
        </aside>

        <main className="min-w-0 pb-24 lg:pb-0">
          <div className="mx-auto max-w-[1360px] px-4 py-5 sm:px-8 sm:py-7">
            {page === "home" && <HomeView name={name} />}
            {page === "saved" && <SavedView />}
            {page === "new" && <EditorView />}
            {page === "chat" && <ChatView />}
          </div>
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 gap-1 border-t border-sky/12 bg-ink/96 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
        aria-label="Workspace sections"
      >
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              key={item.id}
              aria-current={active ? "page" : undefined}
              onClick={() => (item.id === "new" ? newNote() : go(item.id))}
              className={cn(
                "flex h-12 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium text-muted",
                active && "bg-sky/10 text-cream",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <ToastHost />

      <ConfirmDialog
        open={confirmLogout}
        title="Sign out of Ebolt?"
        description="Your saved notes stay on this device. Unsaved editor changes are lost."
        confirmLabel="Sign out"
        onConfirm={logout}
        onClose={() => setConfirmLogout(false)}
      />
    </div>
  );
}

function NoteMeter() {
  const notes = useEbolt((s) => s.notes);
  const words = useMemo(() => notes.reduce((sum, n) => sum + wordCount(n.text), 0), [notes]);
  return (
    <div className="rounded-xl border border-sky/12 bg-white/3 px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[19px] font-semibold text-cream tabular-nums">{notes.length}</span>
        <span className="text-[10px] text-dim">{notes.length === 1 ? "note" : "notes"}</span>
      </div>
      <div className="mt-1 text-[10px] text-dim">{words.toLocaleString()} words written</div>
    </div>
  );
}

function ToastHost() {
  const toast = useEbolt((s) => s.toast);
  const dismissToast = useEbolt((s) => s.dismissToast);
  if (!toast) return null;

  return (
    <div
      key={toast.id}
      role="status"
      aria-live="polite"
      className={cn(
        "toast-in fixed right-4 bottom-24 z-[90] flex items-center gap-3 rounded-xl border bg-navy/96 px-4 py-3 text-[12px] shadow-2xl backdrop-blur lg:bottom-6",
        toast.tone === "warn" ? "border-danger/40 text-danger" : "border-sky/25 text-ice",
      )}
    >
      <span>{toast.message}</span>
      {toast.action && toast.actionLabel && (
        <button
          className="rounded-lg border border-sky/30 px-2.5 py-1 text-[11px] font-semibold text-cream transition-colors hover:bg-sky/15"
          onClick={() => {
            toast.action?.();
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <button aria-label="Dismiss" className="text-dim transition-colors hover:text-cream" onClick={dismissToast}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

function HomeView({ name }: { name: string }) {
  const go = useEbolt((s) => s.go);
  const newNote = useEbolt((s) => s.newNote);
  const saveNote = useEbolt((s) => s.saveNote);
  const loadNote = useEbolt((s) => s.loadNote);
  const draftTitle = useEbolt((s) => s.draftTitle);
  const draftText = useEbolt((s) => s.draftText);
  const setDraftTitle = useEbolt((s) => s.setDraftTitle);
  const setDraftText = useEbolt((s) => s.setDraftText);
  const currentNoteId = useEbolt((s) => s.currentNoteId);
  const notes = useEbolt((s) => s.notes);
  const dirty = useEbolt(selectDirty);

  const openNote = currentNoteId ? notes.find((n) => n.id === currentNoteId) : undefined;
  const recent = useMemo(() => sortNotes(notes, "updated").slice(0, 3), [notes]);

  // Rendered after mount only — the date string depends on the viewer's locale
  // and timezone, which the server cannot know.
  const [today, setToday] = useState<{ day: string; date: string } | null>(null);
  useEffect(() => {
    const now = new Date();
    setToday({
      day: now.toLocaleDateString(undefined, { weekday: "long" }),
      date: now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }),
    });
  }, []);

  return (
    <section>
      <div className="mb-5 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h2 className="font-display text-[27px] leading-tight tracking-tight">Hey, {name}</h2>
          <p className="mt-1 text-[12px] text-dim">Pick up where you left off.</p>
        </div>
        <div className="flex min-w-[210px] items-center gap-3 rounded-2xl border border-sky/12 bg-navy/70 px-3.5 py-2.5">
          <Orb size={40} />
          <div className="text-right">
            <strong className="block text-[12px] font-semibold">{today?.day ?? "\u00a0"}</strong>
            <span className="mt-0.5 block text-[10px] text-dim">{today?.date ?? "\u00a0"}</span>
          </div>
        </div>
      </div>

      <div className="relative isolate flex min-h-[420px] items-center justify-center overflow-hidden rounded-[30px] border border-sky/15 bg-[#04121a] text-center">
        <AuroraBackdrop />
        <div className="relative z-10 max-w-[760px] px-6 py-16">
          <h1 className="font-display text-[clamp(34px,6vw,70px)] leading-[1.04] font-semibold tracking-tight text-balance">
            <span className="aurora-text">Explore your ideas clearly.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-[54ch] text-[13.5px] leading-7 text-muted">
            A quiet place to write, save and reshape what you are working on — every note kept on this
            device, ready the moment you come back.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-2.5">
            <button className="pill pill-primary pill-lg" onClick={newNote}>
              Start a new note
            </button>
            <button className="pill pill-lg" onClick={() => go("saved")}>
              Browse {notes.length} {notes.length === 1 ? "note" : "notes"}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="overflow-hidden rounded-[20px] border border-sky/18 bg-[#02080c]">
          <div className="flex h-12 flex-wrap items-center gap-2 border-b border-sky/10 px-3">
            <FileText className="size-3.5 shrink-0 text-sky" />
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-sky/18 bg-white/5 px-2.5 text-[12px] text-ice outline-none focus:border-sky/50"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              aria-label="Note title"
            />
            {openNote && (
              <button className="pill" onClick={() => saveNote({ asNew: true })} title="Keep the original and save a copy">
                Save as new
              </button>
            )}
            <button className="pill pill-primary" onClick={() => saveNote()}>
              {openNote ? "Update" : "Save"}
            </button>
          </div>

          {/* The quick pad and the editor share one draft, so say plainly which
              note a save will overwrite. */}
          <div className="flex items-center justify-between gap-2 border-b border-sky/8 px-3.5 py-2 text-[11px] text-dim">
            <span className="truncate">
              {openNote ? (
                <>
                  Editing <b className="font-medium text-muted">{openNote.title}</b>
                </>
              ) : (
                "New note — not saved yet"
              )}
            </span>
            <span className={cn("shrink-0", dirty ? "text-sky" : "text-dim")}>
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
          </div>

          <textarea
            className="min-h-[280px] w-full resize-y border-0 bg-transparent p-4 font-mono text-[12.5px] leading-7 text-ice outline-none placeholder:text-dim"
            value={draftText}
            placeholder="Start writing here. Ideas, commands, documentation — whatever you need to keep."
            onChange={(e) => setDraftText(e.target.value)}
            aria-label="Note text"
          />
        </div>

        <aside className="glass-card rounded-[20px] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold">Recent</h3>
            <button className="text-[11px] text-sky transition-colors hover:text-ice" onClick={() => go("saved")}>
              See all
            </button>
          </div>
          {recent.length === 0 ? (
            <p className="py-6 text-[12px] leading-6 text-dim">
              Nothing saved yet. Write something in the pad and press Save — it will appear here.
            </p>
          ) : (
            <ul className="grid gap-1.5">
              {recent.map((n) => (
                <li key={n.id}>
                  <button
                    className="w-full rounded-xl border border-sky/10 bg-white/3 px-3 py-2.5 text-left transition-colors hover:border-sky/30 hover:bg-sky/5"
                    onClick={() => loadNote(n.id)}
                  >
                    <b className="block truncate text-[12px] font-medium text-cream">{n.title}</b>
                    <span className="mt-0.5 block truncate text-[10.5px] text-dim">
                      <ClientTime ts={n.updatedAt} /> · {wordCount(n.text)} words
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </section>
  );
}

/** Relative timestamps are client-only to keep SSR output deterministic. */
function ClientTime({ ts }: { ts: number }) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    setLabel(formatWhen(ts));
    const id = setInterval(() => setLabel(formatWhen(ts)), 60000);
    return () => clearInterval(id);
  }, [ts]);
  return <>{label || "\u00a0"}</>;
}

/* ------------------------------------------------------------------ */
/* Saved notes                                                         */
/* ------------------------------------------------------------------ */

function SavedView() {
  const notes = useEbolt((s) => s.notes);
  const query = useEbolt((s) => s.query);
  const sort = useEbolt((s) => s.sort);
  const setQuery = useEbolt((s) => s.setQuery);
  const setSort = useEbolt((s) => s.setSort);
  const loadNote = useEbolt((s) => s.loadNote);
  const deleteNote = useEbolt((s) => s.deleteNote);
  const duplicateNote = useEbolt((s) => s.duplicateNote);
  const newNote = useEbolt((s) => s.newNote);
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q))
      : notes;
    return sortNotes(filtered, sort);
  }, [notes, query, sort]);

  return (
    <section>
      <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="font-display text-[24px] tracking-tight">Your notes</h2>
          <p className="mt-1 text-[12px] text-dim">
            {notes.length} saved · open any note to keep editing it.
          </p>
        </div>
        <button className="pill pill-primary self-start sm:self-auto" onClick={newNote}>
          New note
        </button>
      </div>

      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-dim" />
          <input
            className="h-11 w-full rounded-xl border border-sky/15 bg-white/4 pr-3 pl-10 text-[13px] text-cream outline-none placeholder:text-dim focus:border-sky/45"
            placeholder="Search titles and text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search notes"
          />
        </div>
        <label className="flex h-11 items-center gap-2 rounded-xl border border-sky/15 bg-white/4 px-3 text-[12px] text-dim">
          Sort
          <select
            className="bg-transparent text-[12px] text-cream outline-none"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option className="bg-navy" value="updated">
              Last edited
            </option>
            <option className="bg-navy" value="created">
              Date created
            </option>
            <option className="bg-navy" value="title">
              Title A–Z
            </option>
          </select>
        </label>
      </div>

      {notes.length === 0 ? (
        <EmptyState
          title="No notes here yet"
          body="Everything you save shows up on this page. Start with one and build from there."
          actionLabel="Write your first note"
          onAction={newNote}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title={`Nothing matches “${query.trim()}”`}
          body="Try a shorter search term, or clear the search to see every note."
          actionLabel="Clear search"
          onAction={() => setQuery("")}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((n) => (
            <article
              key={n.id}
              className="glass-card relative flex min-h-[176px] flex-col rounded-[18px] p-4 transition-[transform,border-color] hover:-translate-y-0.5 hover:border-sky/35"
            >
              <button className="text-left" onClick={() => loadNote(n.id)} aria-label={`Open ${n.title}`}>
                <h3 className="mb-2 pr-16 text-[14px] leading-snug font-medium">{n.title}</h3>
                <p className="line-clamp-4 text-[11.5px] leading-6 text-dim">
                  {n.text.trim() || "This note is empty."}
                </p>
              </button>

              <div className="absolute top-3 right-3 flex gap-1">
                <button
                  type="button"
                  className="grid size-8 place-items-center rounded-[9px] border border-sky/15 bg-white/4 text-muted transition-colors hover:border-sky/40 hover:text-cream"
                  aria-label={`Duplicate ${n.title}`}
                  title="Duplicate"
                  onClick={() => duplicateNote(n.id)}
                >
                  <Copy className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="grid size-8 place-items-center rounded-[9px] border border-sky/15 bg-white/4 text-muted transition-colors hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
                  aria-label={`Delete ${n.title}`}
                  title="Delete"
                  onClick={() => setPendingDelete(n)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>

              <div className="mt-auto flex items-center justify-between pt-4">
                <small className="text-[10px] text-dim">
                  <ClientTime ts={n.updatedAt} /> · {wordCount(n.text)} words
                </small>
                <button type="button" className="pill inline-flex h-8 items-center gap-1.5" onClick={() => loadNote(n.id)}>
                  <Pencil className="size-3" /> Edit
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`Delete “${pendingDelete?.title ?? ""}”?`}
        description="You can undo this from the message that appears, until it disappears."
        confirmLabel="Delete note"
        destructive
        onConfirm={() => {
          if (pendingDelete) deleteNote(pendingDelete.id);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </section>
  );
}

function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="glass-card grid place-items-center rounded-[22px] px-6 py-16 text-center">
      <NotebookText className="mb-4 size-8 text-sky/60" />
      <h3 className="text-[16px] font-medium">{title}</h3>
      <p className="mx-auto mt-2 max-w-[42ch] text-[12px] leading-6 text-dim">{body}</p>
      <button className="pill pill-primary mt-5" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

function EditorView() {
  const currentNoteId = useEbolt((s) => s.currentNoteId);
  const notes = useEbolt((s) => s.notes);
  const draftTitle = useEbolt((s) => s.draftTitle);
  const draftText = useEbolt((s) => s.draftText);
  const setDraftTitle = useEbolt((s) => s.setDraftTitle);
  const setDraftText = useEbolt((s) => s.setDraftText);
  const saveNote = useEbolt((s) => s.saveNote);
  const newDraft = useEbolt((s) => s.newDraft);
  const deleteNote = useEbolt((s) => s.deleteNote);
  const go = useEbolt((s) => s.go);
  const dirty = useEbolt(selectDirty);

  const [renaming, setRenaming] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);

  const openNote = currentNoteId ? notes.find((n) => n.id === currentNoteId) : undefined;
  const editing = Boolean(openNote);

  // Warn before a reload or tab close would throw away unsaved text.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function clearEditor() {
    if (dirty) setConfirmClear(true);
    else newDraft();
  }

  return (
    <section>
      <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="font-display text-[24px] tracking-tight">{editing ? "Edit note" : "New note"}</h2>
          <p className="mt-1 text-[12px] text-dim">
            {editing
              ? "Saving writes back to this note. Use Save as new to keep both versions."
              : "Saving creates a new note. Press Ctrl+S or Cmd+S any time."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="pill" onClick={clearEditor}>
            New
          </button>
          <button className="pill" onClick={() => go("saved")}>
            All notes
          </button>
          {editing && (
            <button className="pill" onClick={() => saveNote({ asNew: true })}>
              Save as new
            </button>
          )}
          <button className="pill pill-primary" onClick={() => saveNote()}>
            {editing ? "Update note" : "Save note"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="glass-card rounded-[20px] p-4">
          <input
            className="mb-3 h-12 w-full rounded-xl border border-sky/18 bg-white/5 px-3.5 text-[14px] font-medium text-cream outline-none focus:border-sky/50"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="Note title"
            aria-label="Note title"
          />
          <textarea
            className="min-h-[400px] w-full resize-y rounded-xl border border-sky/10 bg-black/20 p-3.5 font-mono text-[12.5px] leading-7 text-ice outline-none placeholder:text-dim focus:border-sky/35"
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            placeholder="Write here…"
            aria-label="Note text"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-dim">
              {wordCount(draftText)} words · {draftText.length} characters ·{" "}
              <span className={dirty ? "text-sky" : undefined}>
                {dirty ? "Unsaved changes" : "All changes saved"}
              </span>
            </span>
            <div className="flex gap-2">
              <button className="pill" onClick={() => setRenaming(true)}>
                Rename
              </button>
              {editing && (
                <button className="pill pill-danger" onClick={() => setPendingDelete(true)}>
                  Delete
                </button>
              )}
              <button className="pill pill-primary" onClick={() => saveNote()}>
                {editing ? "Update" : "Save"}
              </button>
            </div>
          </div>
        </div>

        <aside className="glass-card rounded-[20px] p-4">
          <h3 className="mb-3 text-[13px] font-semibold">How saving works</h3>
          <dl className="grid gap-3">
            {[
              ["Save", "Creates a new note the first time, then updates that same note."],
              ["Save as new", "Keeps the original untouched and stores a second copy."],
              ["Delete", "Removes the note, with a few seconds to undo."],
              ["Storage", "Notes live in this browser, separately for each account."],
            ].map(([term, detail]) => (
              <div key={term} className="border-b border-sky/8 pb-3 last:border-0 last:pb-0">
                <dt className="text-[11.5px] font-medium text-sky">{term}</dt>
                <dd className="mt-1 text-[11px] leading-5 text-dim">{detail}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>

      <PromptDialog
        open={renaming}
        title="Rename note"
        description="This changes the title only. Save to write it to the note."
        initialValue={draftTitle}
        placeholder="Note title"
        submitLabel="Rename"
        onSubmit={(value) => setDraftTitle(value)}
        onClose={() => setRenaming(false)}
      />

      <ConfirmDialog
        open={confirmClear}
        title="Discard unsaved changes?"
        description="The editor will be cleared and your unsaved text will be lost."
        confirmLabel="Discard"
        destructive
        onConfirm={newDraft}
        onClose={() => setConfirmClear(false)}
      />

      <ConfirmDialog
        open={pendingDelete}
        title={`Delete “${openNote?.title ?? ""}”?`}
        description="You can undo this from the message that appears, until it disappears."
        confirmLabel="Delete note"
        destructive
        onConfirm={() => {
          if (currentNoteId) {
            deleteNote(currentNoteId);
            go("saved");
          }
        }}
        onClose={() => setPendingDelete(false)}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Assistant                                                           */
/* ------------------------------------------------------------------ */

function ChatView() {
  const chat = useEbolt((s) => s.chat);
  const sendChat = useEbolt((s) => s.sendChat);
  const [value, setValue] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [chat.length]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    sendChat(value);
    setValue("");
  }

  return (
    <section>
      <div className="mb-5">
        <h2 className="font-display text-[24px] tracking-tight">Assistant</h2>
        <p className="mt-1 text-[12px] text-dim">Ask about your notes, or talk an idea through.</p>
      </div>
      <div className="glass-card flex min-h-[600px] flex-col overflow-hidden rounded-[22px]">
        <div className="flex items-center gap-3 border-b border-sky/10 px-4 py-4">
          <img src="/ebolt-logo.png" alt="" className="size-10 rounded-xl object-cover" />
          <div>
            <b className="text-[13px] font-semibold">Ebolt assistant</b>
            <span className="mt-0.5 block text-[10.5px] text-dim">Knows what is in your workspace</span>
          </div>
        </div>
        <div ref={box} className="flex flex-1 flex-col gap-3 overflow-auto p-5">
          {chat.map((m, i) => (
            <div
              key={i}
              className={cn(
                "max-w-[75%] rounded-[16px] px-4 py-3 text-[12px] leading-6",
                m.role === "bot"
                  ? "self-start border border-sky/10 bg-sky/8 text-ice"
                  : "self-end bg-linear-to-r from-sky-2 to-ice text-navy",
              )}
            >
              {m.text}
            </div>
          ))}
        </div>
        <form className="flex gap-2 border-t border-sky/10 p-3" onSubmit={onSubmit}>
          <input
            className="h-11 flex-1 rounded-xl border border-sky/18 bg-white/5 px-3.5 text-[13px] text-cream outline-none placeholder:text-dim focus:border-sky/50"
            placeholder="Ask something about your notes…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Message"
          />
          <button className="pill pill-primary h-11" type="submit" disabled={!value.trim()}>
            Send
          </button>
        </form>
      </div>
    </section>
  );
}


function App() {
  const user = useEbolt((s) => s.user);
  const login = useEbolt((s) => s.login);

  useEffect(() => {
    if (user) return;
    const remembered = tryRememberedUser();
    if (remembered) login(remembered);
  }, [user, login]);

  if (!user) return <LoginScreen />;
  return <Workspace />;
}
