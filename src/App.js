import { useState, useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://dshvliybyubrdjgzvzol.supabase.co";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzaHZsaXlieXVicmRqZ3p2em9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMDQyODIsImV4cCI6MjA4NzY4MDI4Mn0.ztImMoyN4C2t_0lNVG9qwOTrx2rh7-r8G2SQ_WcEdlY";

const SLACK_EDGE_URL =
  "https://dshvliybyubrdjgzvzol.supabase.co/functions/v1/smart-function";
const DRIVE_FOLDER_ID = "0ALT5LIUYvlWYUk9PVA";

// ══════════════════════════════════════════════════════════════
// ── 클라이언트 생성 전: 만료된 토큰 미리 제거 ─────────────────────
// ── (autoRefreshToken이 만료 토큰으로 /auth/v1/user 403 뿜는 것 방지)
// ══════════════════════════════════════════════════════════════
try {
  const projectId = SUPABASE_URL.split("//")[1].split(".")[0]; // dshvliybyubrdjgzvzol
  const storageKey = `sb-${projectId}-auth-token`;
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    const parsed = JSON.parse(raw);
    const accessToken = parsed?.access_token;
    if (accessToken) {
      // JWT exp 클레임 디코딩 (라이브러리 불필요)
      const payload = JSON.parse(
        atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
      );
      const expiredSec = payload.exp - Math.floor(Date.now() / 1000);
      if (expiredSec < -60) {
        // 1분 이상 만료된 토큰 → 클라이언트 생성 전에 제거
        console.warn(
          "[Auth] Pre-clearing expired token (expired",
          -expiredSec,
          "sec ago)"
        );
        localStorage.removeItem(storageKey);
      }
    }
  }
} catch {}

// ── Supabase client (세션·토큰 갱신 자동 처리) ─────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true, // localStorage에 세션 자동 저장
    autoRefreshToken: false, // SDK 자동갱신 OFF → 수동 제어
    detectSessionInUrl: true, // OAuth redirect 자동 처리
    flowType: "implicit", // PKCE 대신 implicit flow (SPA에서 안정적)
  },
});

// onAuthStateChange 콜백에서 최신 토큰을 동기적으로 읽을 수 있도록 캐시
let _cachedAccessToken = null;
let _googleToken = null;

const getToken = () => _cachedAccessToken || SUPABASE_KEY;

// ── API helpers ──────────────────────────────────────────────
const api = async (path, options = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "",
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};

// ── Slack notifications ──────────────────────────────────────
const STATUS_LABELS = {
  todo: "📥 요청 접수",
  reviewing: "👀 검토 및 할당",
  "in-progress": "🏃 진행 중",
  done: "✅ 완료",
};

const slackNotify = async (blocks) => {
  try {
    await fetch(SLACK_EDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getToken()}`,
      },
      body: JSON.stringify({ type: "slack", blocks }),
    });
  } catch (e) {
    console.warn("Slack notify failed", e);
  }
};

const slackStatusChange = (ticket, newStatus, actor) =>
  slackNotify([
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${STATUS_LABELS[newStatus]}* 으로 상태가 변경되었습니다.`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*요청*\n${ticket.title}` },
        { type: "mrkdwn", text: `*티켓 ID*\n${ticket.id}` },
        { type: "mrkdwn", text: `*요청자*\n${ticket.requester}` },
        { type: "mrkdwn", text: `*변경자*\n${actor}` },
        {
          type: "mrkdwn",
          text: `*이전 상태*\n${STATUS_LABELS[ticket.status] || ticket.status}`,
        },
        { type: "mrkdwn", text: `*마감 희망일*\n${ticket.dueDate}` },
      ],
    },
    { type: "divider" },
  ]);

const slackNewRequest = (ticket) =>
  slackNotify(
    [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*📥 새 디자인 요청이 접수되었습니다!*" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*제목*\n${ticket.title}` },
          { type: "mrkdwn", text: `*티켓 ID*\n${ticket.id}` },
          { type: "mrkdwn", text: `*요청자*\n${ticket.requester}` },
          { type: "mrkdwn", text: `*마감 희망일*\n${ticket.dueDate}` },
          { type: "mrkdwn", text: `*유형*\n${ticket.type || "미지정"}` },
          {
            type: "mrkdwn",
            text: `*우선순위*\n${
              ticket.priority === "high"
                ? "🔴 높음"
                : ticket.priority === "medium"
                ? "🟡 보통"
                : "🟢 낮음"
            }`,
          },
        ],
      },
      ticket.meetingRequested
        ? {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "☕ *구두 미팅 요청됨* — 일정을 잡아주세요!",
            },
          }
        : null,
      { type: "divider" },
    ].filter(Boolean)
  );

const slackComment = (ticket, comment) =>
  slackNotify([
    { type: "section", text: { type: "mrkdwn", text: "*💬 새 코멘트*" } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*요청*\n${ticket.title}` },
        { type: "mrkdwn", text: `*티켓 ID*\n${ticket.id}` },
        { type: "mrkdwn", text: `*작성자*\n${comment.author}` },
        { type: "mrkdwn", text: `*내용*\n${comment.text}` },
      ],
    },
    { type: "divider" },
  ]);

const slackEditNotify = (ticket, changes, actor) =>
  slackNotify([
    {
      type: "section",
      text: { type: "mrkdwn", text: "*✏️ 요청 내용이 수정되었습니다*" },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*요청*\n${ticket.title}` },
        { type: "mrkdwn", text: `*티켓 ID*\n${ticket.id}` },
        { type: "mrkdwn", text: `*수정자*\n${actor}` },
        { type: "mrkdwn", text: `*변경 항목*\n${changes}` },
      ],
    },
    { type: "divider" },
  ]);

// ── Data mappers ─────────────────────────────────────────────
const dbToTicket = (r) => ({
  id: r.id,
  title: r.title,
  status: r.status,
  type: r.type || "",
  requester: r.requester,
  requesterEmail: r.requester_email || "",
  designer: r.designer || "",
  requestDate: r.request_date,
  dueDate: r.due_date,
  priority: r.priority,
  description: r.description || "",
  comments: r.comments || [],
  publishType: r.publish_type || "",
  projectSchedule: r.project_schedule || "",
  workSize: r.work_size || "",
  reference: r.reference || "",
  meetingRequested: r.meeting_requested || false,
  attachments: r.attachments || [],
});

const ticketToDb = (t) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  type: t.type || null,
  requester: t.requester,
  requester_email: t.requesterEmail || null,
  designer: t.designer || null,
  request_date: t.requestDate,
  due_date: t.dueDate,
  priority: t.priority,
  description: t.description || null,
  comments: t.comments || [],
  publish_type: t.publishType || null,
  project_schedule: t.projectSchedule || null,
  work_size: t.workSize || null,
  reference: t.reference || null,
  meeting_requested: t.meetingRequested || false,
  attachments: t.attachments || [],
});

// ── Constants ────────────────────────────────────────────────
const STATUSES = [
  {
    id: "todo",
    label: { ko: "📥 요청 접수", en: "📥 Requested" },
    color: "#6366f1",
    bg: "#eef2ff",
  },
  {
    id: "reviewing",
    label: { ko: "👀 디자인 검토 및 할당", en: "👀 Reviewing" },
    color: "#f59e0b",
    bg: "#fffbeb",
  },
  {
    id: "in-progress",
    label: { ko: "🏃 진행 중", en: "🏃 In Progress" },
    color: "#10b981",
    bg: "#ecfdf5",
  },
  {
    id: "done",
    label: { ko: "✅ 완료", en: "✅ Done" },
    color: "#6b7280",
    bg: "#f9fafb",
  },
];
const TYPES = [
  "배너/광고",
  "SNS 콘텐츠",
  "PT/문서",
  "인포그래픽",
  "UI/UX",
  "영상",
  "기타",
];
const DESIGNERS = ["Jinsol Seo", "Sunmin Jeong"];
const PRIORITIES = [
  { id: "high", label: { ko: "높음", en: "High" }, color: "#ef4444" },
  { id: "medium", label: { ko: "보통", en: "Medium" }, color: "#f59e0b" },
  { id: "low", label: { ko: "낮음", en: "Low" }, color: "#10b981" },
];
function getPriority(p) {
  return PRIORITIES.find((x) => x.id === p) || PRIORITIES[1];
}
const PUBLISH_TYPES = [
  {
    id: "online",
    label: "🖥️ 온라인",
    sub: "RGB",
    desc: "웹 · SNS · 디지털 배너",
  },
  {
    id: "offline",
    label: "🖨️ 오프라인",
    sub: "CMYK",
    desc: "인쇄물 · 현수막 · 명함",
  },
  {
    id: "both",
    label: "🖥️🖨️ 온·오프라인",
    sub: "RGB+CMYK",
    desc: "둘 다 필요한 경우",
  },
];
const EMPTY_FORM = {
  title: "",
  type: "",
  designer: "",
  dueDate: "",
  priority: "medium",
  description: "",
  publishType: "",
  projectSchedule: "",
  workSize: "",
  reference: "",
  meetingRequested: false,
  attachments: [],
};

function getStatus(s) {
  return STATUSES.find((x) => x.id === s) || STATUSES[0];
}
function formatFileSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

// ── 첨부파일 업로드 제약 ─────────────────────────────────────
// Supabase Storage의 객체 키는 ASCII 일부 문자만 허용한다.
// 한글/특수문자가 든 파일명은 "Invalid key"로 거부되므로,
// 저장 경로에는 안전하게 변환한 이름을 쓰고 화면에 보이는 이름은 원본을 유지한다.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Supabase Free 플랜 상한
const UPLOAD_RETRIES = 3; // 대용량 파일은 간헐적으로 실패하므로 재시도한다

function safeStorageName(name) {
  const dot = name.lastIndexOf(".");
  const ext =
    dot > 0
      ? name
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 10)
      : "";
  let stem = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 50);
  if (!stem) stem = "file"; // 한글만으로 된 파일명 등
  // 이름이 뭉개져 겹칠 수 있으므로 짧은 무작위 접미사로 키를 고유하게 만든다.
  const rand = Math.random().toString(36).slice(2, 8);
  return ext ? `${stem}-${rand}.${ext}` : `${stem}-${rand}`;
}

// ── CSS ──────────────────────────────────────────────────────
const CSS = `
  *{box-sizing:border-box;margin:0;padding:0;}
  ::-webkit-scrollbar{width:5px;height:5px;}
  ::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:99px;}
  .card{transition:transform .15s,box-shadow .15s;cursor:pointer;}
  .card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.12)!important;}
  .btn{cursor:pointer;border:none;transition:opacity .15s;}
  .btn:hover{opacity:.8;}
  .navbtn{cursor:pointer;border:none;background:none;padding:8px 16px;border-radius:8px;font-weight:600;font-size:14px;transition:background .15s;font-family:inherit;}
  .navbtn:hover{background:rgba(0,0,0,.06);}
  .navbtn.on{background:#1a1a1a;color:white;}
  .inp{width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;outline:none;font-family:inherit;background:white;}
  .inp:focus{border-color:#6366f1;}
  .tag{display:inline-flex;align-items:center;padding:2px 10px;border-radius:99px;font-size:11px;font-weight:600;}
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;}
  .modal{background:white;border-radius:18px;max-height:88vh;overflow-y:auto;width:100%;max-width:680px;box-shadow:0 24px 64px rgba(0,0,0,.22);}
  .small-modal{background:white;border-radius:16px;width:100%;max-width:420px;box-shadow:0 24px 64px rgba(0,0,0,.22);padding:36px;}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .spin{animation:spin .8s linear infinite;display:inline-block;}
  .pulse{animation:pulse 2s ease-in-out infinite;}
  .section-title{font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:14px;padding-bottom:8px;}
  .attach-row:hover{background:#eef2ff!important;}
  .realtime-dot{width:7px;height:7px;border-radius:50%;background:#10b981;display:inline-block;margin-right:5px;box-shadow:0 0 0 2px #d1fae5;}
  @keyframes rtpulse{0%,100%{box-shadow:0 0 0 2px #d1fae5}50%{box-shadow:0 0 0 4px #a7f3d0}}
  .realtime-dot.active{animation:rtpulse 2s ease-in-out infinite;}
  .realtime-dot.off{background:#d1d5db;box-shadow:0 0 0 2px #f3f4f6;}
`;

// ══════════════════════════════════════════════════════════════
// ── Supabase Realtime hook (WebSocket + 폴링 이중 구조) ───────
// ══════════════════════════════════════════════════════════════
/**
 * 1차: Supabase Realtime WebSocket (즉시 반영)
 * 2차: 5초 폴링 폴백 (WebSocket 실패 시 또는 항상 병행)
 *
 * Supabase Realtime v2 Phoenix 프로토콜:
 *   - topic: "realtime:{channelName}" (임의 문자열)
 *   - incoming postgres_changes: payload.data.type / .record / .old_record
 */
function useSupabaseRealtime({ session, onFetch }) {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const heartbeatTimer = useRef(null);
  const pollTimer = useRef(null);
  const [connected, setConnected] = useState(false);
  const refCounter = useRef(1);
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // ── WebSocket ──────────────────────────────────────────────
  const connect = () => {
    const sess = sessionRef.current;
    if (!sess) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const token = getToken();
    const wsUrl = `${SUPABASE_URL.replace(
      "https://",
      "wss://"
    )}/realtime/v1/websocket?apikey=${SUPABASE_KEY}&vsn=1.0.0`;

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Supabase Realtime v2: 채널명은 임의 문자열
      ws.send(
        JSON.stringify({
          topic: "realtime:tickets-sync",
          event: "phx_join",
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: "" },
              postgres_changes: [
                { event: "*", schema: "public", table: "tickets" },
              ],
            },
            access_token: token,
          },
          ref: String(refCounter.current++),
        })
      );

      // 25초마다 heartbeat
      heartbeatTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              topic: "phoenix",
              event: "heartbeat",
              payload: {},
              ref: String(refCounter.current++),
            })
          );
        }
      }, 25000);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Supabase Realtime v2 postgres_changes 페이로드:
        //   msg.event === "postgres_changes"
        //   msg.payload.data.type  → "INSERT" | "UPDATE" | "DELETE"
        //   msg.payload.data.record      → 새 레코드 (INSERT/UPDATE)
        //   msg.payload.data.old_record  → 이전 레코드 (UPDATE/DELETE)
        if (msg.event === "postgres_changes" && msg.payload?.data) {
          onFetch(); // 변경 감지 시 즉시 fetch
        }
      } catch {}
    };

    ws.onclose = () => {
      setConnected(false);
      clearInterval(heartbeatTimer.current);
      reconnectTimer.current = setTimeout(() => {
        if (sessionRef.current) connect();
      }, 5000);
    };

    ws.onerror = () => {
      ws.close();
    };
  };

  // ── 폴링 (5초, 확실한 동기화 보장) ──────────────────────────
  const startPolling = () => {
    clearInterval(pollTimer.current);
    pollTimer.current = setInterval(() => {
      if (sessionRef.current) onFetch();
    }, 5000);
  };

  useEffect(() => {
    if (!session) return;
    connect();
    startPolling();
    return () => {
      clearTimeout(reconnectTimer.current);
      clearInterval(heartbeatTimer.current);
      clearInterval(pollTimer.current);
      wsRef.current?.close();
    };
  }, [session]);

  return connected;
}

// ════════════════════════════════════════════════════════════
export default function App() {
  // Auth state
  const [session, setSession] = useState(null);
  const [userRole, setUserRole] = useState(null); // 'admin' | 'user'
  const [authLoading, setAuthLoading] = useState(true);

  // App state
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState("dashboard");
  const [adminSubView, setAdminSubView] = useState("board");
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [newComment, setNewComment] = useState("");
  const [dragging, setDragging] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editData, setEditData] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [driveQuery, setDriveQuery] = useState("");
  const [driveResults, setDriveResults] = useState([]);
  const [driveLoading, setDriveLoading] = useState(false);
  const [driveSearched, setDriveSearched] = useState(false);
  // 실시간 업데이트 토스트
  const [realtimeToast, setRealtimeToast] = useState(null);

  const isAdmin = userRole === "admin";
  const [lang, setLang] = useState("ko");
  const t = (ko, en) => (lang === "ko" ? ko : en);

  // ── Realtime refs ────────────────────────────────────────────
  const userRoleRef = useRef(userRole);
  const sessionRef = useRef(session);
  useEffect(() => {
    userRoleRef.current = userRole;
  }, [userRole]);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const toastTimerRef = useRef(null);
  const showToast = (label, title) => {
    clearTimeout(toastTimerRef.current);
    setRealtimeToast({ label, title, id: Date.now() });
    toastTimerRef.current = setTimeout(() => setRealtimeToast(null), 3000);
  };

  // 백그라운드 silent fetch — 변경 있을 때만 state 업데이트
  const silentFetch = async () => {
    try {
      const sess = sessionRef.current;
      const role = userRoleRef.current;
      if (!sess || !role) return;
      let data;
      if (role === "admin") {
        data = await api("tickets?order=request_date.desc");
      } else {
        data = await api(
          `tickets?requester_email=eq.${encodeURIComponent(
            sess.email
          )}&order=request_date.desc`
        );
      }
      const incoming = (data || []).map(dbToTicket);
      setTickets((prev) => {
        const prevStr = JSON.stringify(
          prev.map(
            (t) => t.id + t.status + (t.comments?.length || 0) + t.designer
          )
        );
        const nextStr = JSON.stringify(
          incoming.map(
            (t) => t.id + t.status + (t.comments?.length || 0) + t.designer
          )
        );
        if (prevStr === nextStr) return prev; // 변경 없음
        // 열려있는 모달 티켓도 동기화
        setSelectedTicket((sel) => {
          if (!sel) return sel;
          return incoming.find((t) => t.id === sel.id) || null;
        });
        showToast("🔄 업데이트됨", `${incoming.length}개 티켓 동기화 완료`);
        return incoming;
      });
    } catch {}
  };

  const realtimeConnected = useSupabaseRealtime({
    session,
    onFetch: silentFetch,
  });

  // ── Auth ────────────────────────────────────────────────────
  useEffect(() => {
    let refreshTimer = null;

    // JWT exp 디코딩
    const getExp = (token) => {
      try {
        return JSON.parse(
          atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
        ).exp;
      } catch {
        return 0;
      }
    };

    // 로컬 세션 완전 초기화 (서버 호출 없음)
    const clearLocal = () => {
      clearTimeout(refreshTimer);
      try {
        localStorage.removeItem(`sb-dshvliybyubrdjgzvzol-auth-token`);
      } catch {}
      _cachedAccessToken = null;
      _googleToken = null;
      setSession(null);
      setUserRole(null);
      setAuthLoading(false);
    };

    // 세션 적용 (로그인 완료 후 공통)
    const applySession = async (s) => {
      _cachedAccessToken = s.access_token;
      if (s.provider_token) {
        _googleToken = s.provider_token;
        try {
          localStorage.setItem("g_token", s.provider_token);
        } catch {}
      }
      setSession(s.user);
      try {
        const d = await api(
          `user_roles?email=eq.${encodeURIComponent(s.user.email)}&select=role`
        );
        setUserRole(d?.[0]?.role || "user");
      } catch {
        setUserRole("user");
      }
      setAuthLoading(false);

      // 만료 55분 전에 자동 갱신 예약
      const exp = getExp(s.access_token);
      const msUntilRefresh = Math.max(
        (exp - Math.floor(Date.now() / 1000) - 300) * 1000,
        5000
      );
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(doRefresh, msUntilRefresh);
      console.log(
        "[Auth] session applied, next refresh in",
        Math.round(msUntilRefresh / 1000),
        "sec"
      );
    };

    // 수동 토큰 갱신
    const doRefresh = async () => {
      console.log("[Auth] refreshing token...");
      const {
        data: { session: s },
        error,
      } = await supabase.auth.refreshSession();
      if (error || !s) {
        console.warn("[Auth] refresh failed — logging out:", error?.message);
        clearLocal();
      } else {
        await applySession(s);
      }
    };

    // 마운트 시: 만료 여부를 로컬에서만 판단 — 만료 시 네트워크 호출 없이 즉시 정리
    (async () => {
      const {
        data: { session: stored },
      } = await supabase.auth.getSession();
      if (!stored) {
        setAuthLoading(false);
        return;
      }

      const exp = getExp(stored.access_token);
      const secLeft = exp - Math.floor(Date.now() / 1000);
      console.log("[Auth] token secLeft:", secLeft);

      if (secLeft <= 0) {
        // access_token 만료 → 네트워크 호출 없이 즉시 로컬 정리
        console.warn(
          "[Auth] access_token expired — clearing without network call"
        );
        clearLocal();
      } else if (secLeft < 300) {
        // 5분 이내 만료 예정 → 아직 유효하니 갱신
        console.log("[Auth] token expiring soon, refreshing...");
        await doRefresh();
      } else {
        // 유효 → 그냥 적용
        await applySession(stored);
      }
    })();

    // 탭 복귀 시 만료 체크 — 만료됐으면 네트워크 없이 정리, 곧 만료면 갱신
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!_cachedAccessToken) return;
      const secLeft =
        getExp(_cachedAccessToken) - Math.floor(Date.now() / 1000);
      if (secLeft <= 0) clearLocal();
      else if (secLeft < 300) doRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    // onAuthStateChange: SIGNED_IN(OAuth 직후)만 처리
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, s) => {
      console.log("[Auth] event:", event);
      if (event === "SIGNED_IN" && s) await applySession(s);
      if (event === "SIGNED_OUT") clearLocal();
    });

    return () => {
      clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", onVisible);
      subscription.unsubscribe();
    };
  }, []);

  const signInWithGoogle = async () => {
    const redirectTo = window.location.href.split("#")[0].split("?")[0];
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        scopes: "https://www.googleapis.com/auth/drive.readonly",
      },
    });
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    _cachedAccessToken = null;
    _googleToken = null;
    setSession(null);
    setUserRole(null);
    setView("dashboard");
  };

  // ── Data fetching ────────────────────────────────────────
  useEffect(() => {
    if (session) fetchTickets();
  }, [session]);

  useEffect(() => {
    if (!session || !userRole) return;
    if (userRole === "admin") setView("dashboard");
    else setView("my-tickets");
  }, [userRole]);

  const searchDrive = async (q) => {
    if (!q.trim()) return;
    setDriveLoading(true);
    setDriveSearched(true);
    try {
      const googleToken =
        _googleToken ||
        (() => {
          try {
            return localStorage.getItem("g_token");
          } catch {
            return null;
          }
        })();
      const authHeader = googleToken
        ? `Bearer ${googleToken}`
        : `Bearer ${getToken()}`;
      const res = await fetch(SLACK_EDGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({
          type: "drive",
          query: q.trim(),
          folderId: DRIVE_FOLDER_ID,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setDriveResults([]);
      } else {
        setDriveResults(data.files || []);
      }
    } catch (e) {
      console.error("Drive search error:", e);
      setDriveResults([]);
    }
    setDriveLoading(false);
  };

  const fetchTickets = async () => {
    setLoading(true);
    try {
      let data;
      if (userRoleRef.current === "admin") {
        data = await api("tickets?order=request_date.desc");
      } else {
        data = await api(
          `tickets?requester_email=eq.${encodeURIComponent(
            sessionRef.current.email
          )}&order=request_date.desc`
        );
      }
      setTickets((data || []).map(dbToTicket));
    } catch (e) {
      console.error("fetchTickets error:", e);
      alert("데이터를 불러오지 못했습니다. " + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (session && userRole) fetchTickets();
  }, [userRole]);

  // ── Ticket actions ───────────────────────────────────────
  const actorName = () =>
    session?.user_metadata?.full_name || session?.email || "알 수 없음";

  const updateStatus = async (id, newStatus) => {
    const ticket = tickets.find((t) => t.id === id);
    setTickets((p) =>
      p.map((t) => (t.id === id ? { ...t, status: newStatus } : t))
    );
    setSelectedTicket((p) => (p?.id === id ? { ...p, status: newStatus } : p));
    try {
      await api(`tickets?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      if (ticket) slackStatusChange(ticket, newStatus, actorName());
    } catch {
      fetchTickets();
    }
  };

  const updateField = async (id, field, value) => {
    const dbField = { dueDate: "due_date" }[field] || field;
    setTickets((p) =>
      p.map((t) => (t.id === id ? { ...t, [field]: value } : t))
    );
    setSelectedTicket((p) => (p?.id === id ? { ...p, [field]: value } : p));
    try {
      await api(`tickets?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ [dbField]: value }),
      });
    } catch {
      fetchTickets();
    }
  };

  const addComment = async (id) => {
    if (!newComment.trim()) return;
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket) return;
    const comment = {
      author: isAdmin ? "디자인팀" : actorName(),
      text: newComment,
      date: new Date().toISOString().split("T")[0],
    };
    const updatedComments = [...ticket.comments, comment];
    setTickets((p) =>
      p.map((t) => (t.id === id ? { ...t, comments: updatedComments } : t))
    );
    setSelectedTicket((p) =>
      p?.id === id ? { ...p, comments: updatedComments } : p
    );
    setNewComment("");
    try {
      await api(`tickets?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ comments: updatedComments }),
      });
      slackComment(ticket, comment);
    } catch {
      fetchTickets();
    }
  };

  const submitForm = async () => {
    if (!formData.title || !formData.dueDate) {
      alert("필수 항목을 입력해주세요: 제목, 마감 희망일");
      return;
    }
    setSaving(true);
    const newTicket = {
      ...formData,
      id: `DR-${String(Date.now()).slice(-6)}`,
      requester: session.user_metadata?.full_name || session.email,
      requesterEmail: session.email,
      status: "todo",
      requestDate: new Date().toISOString().split("T")[0],
      comments: [],
    };
    try {
      await api("tickets", {
        method: "POST",
        prefer: "return=minimal",
        body: JSON.stringify(ticketToDb(newTicket)),
      });
      slackNewRequest(newTicket);
      await fetchTickets();
      setFormData(EMPTY_FORM);
      setView("my-tickets");
    } catch {
      alert("저장 중 오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const diffTicket = (orig, updated) => {
    const FIELD_LABELS = {
      title: "제목",
      type: "유형",
      dueDate: "마감일",
      priority: "우선순위",
      description: "작업내용",
      publishType: "Publish유형",
      projectSchedule: "프로젝트일정",
      workSize: "사이즈",
      reference: "레퍼런스",
    };
    return (
      Object.keys(FIELD_LABELS)
        .filter((k) => orig[k] !== updated[k])
        .map(
          (k) =>
            `${FIELD_LABELS[k]}: "${orig[k] || "-"}" → "${updated[k] || "-"}"`
        )
        .join(", ") || "내용 변경"
    );
  };

  const saveEdit = async () => {
    if (!editData.title || !editData.dueDate) {
      alert("제목과 마감일은 필수입니다.");
      return;
    }
    setSaving(true);
    const origTicket = tickets.find((t) => t.id === editData.id);
    const changes = origTicket ? diffTicket(origTicket, editData) : "내용 변경";
    const changeComment = {
      author: actorName(),
      text: `[수정] ${changes}`,
      date: new Date().toISOString().split("T")[0],
      isSystem: true,
    };
    const updatedComments = [...(origTicket?.comments || []), changeComment];
    try {
      await api(`tickets?id=eq.${editData.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: editData.title,
          type: editData.type || null,
          due_date: editData.dueDate,
          priority: editData.priority,
          description: editData.description || null,
          publish_type: editData.publishType || null,
          project_schedule: editData.projectSchedule || null,
          work_size: editData.workSize || null,
          reference: editData.reference || null,
          attachments: editData.attachments || [],
          comments: updatedComments,
        }),
      });
      slackEditNotify(editData, changes, actorName());
      await fetchTickets();
      setSelectedTicket({
        ...selectedTicket,
        ...editData,
        comments: updatedComments,
      });
      setEditMode(false);
    } catch {
      alert("저장 중 오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const deleteTicket = async (id) => {
    try {
      await api(`tickets?id=eq.${id}`, { method: "DELETE" });
      setTickets((p) => p.filter((t) => t.id !== id));
      setSelectedTicket(null);
      setShowDeleteConfirm(false);
    } catch {
      alert("삭제 중 오류가 발생했습니다.");
    }
  };

  // ── File upload ──────────────────────────────────────────
  // 성공하면 null, 실패하면 { message, retryable }을 돌려준다.
  const attemptUpload = async (file, path) => {
    let res;
    try {
      res = await fetch(
        `${SUPABASE_URL}/storage/v1/object/attachments/${path}`,
        {
          method: "POST",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${getToken()}`,
            "Content-Type": file.type || "application/octet-stream",
          },
          body: file,
        }
      );
    } catch {
      // 연결 끊김·타임아웃. 대용량 파일에서 주로 발생한다.
      return { message: "네트워크 오류 (연결 끊김 또는 시간 초과)", retryable: true };
    }
    if (res.ok) return null;
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.message || body?.error || "";
    } catch {
      detail = "";
    }
    return {
      message: detail
        ? `${res.status} ${detail}`
        : `업로드 실패 (${res.status})`,
      // 5xx·429는 일시적인 문제로 보고 재시도한다.
      // 4xx(용량 초과, 권한 등)는 재시도해도 결과가 같으므로 즉시 중단한다.
      retryable: res.status >= 500 || res.status === 429,
    };
  };

  const uploadFile = async (file, ticketId) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `용량 초과 (${formatFileSize(file.size)} / 최대 ${formatFileSize(
          MAX_UPLOAD_BYTES
        )})`
      );
    }
    let err = null;
    for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
      // 이전 시도가 일부만 올라갔을 수 있으므로 시도마다 새 경로를 쓴다.
      const path = `${ticketId}/${Date.now()}_${safeStorageName(file.name)}`;
      err = await attemptUpload(file, path);
      if (!err) {
        return {
          name: file.name,
          url: `${SUPABASE_URL}/storage/v1/object/public/attachments/${path}`,
          size: file.size,
          type: file.type,
        };
      }
      if (!err.retryable) break;
      if (attempt < UPLOAD_RETRIES) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw new Error(err.message);
  };

  const handleFileUpload = async (files, isEdit = false) => {
    if (!files?.length) return;
    setUploading(true);
    const list = Array.from(files);
    const uploaded = [];
    const failed = [];
    try {
      const tempId = isEdit ? editData.id : `TEMP-${Date.now()}`;
      // 순차 업로드 + 개별 실패 격리:
      // 한 파일이 실패해도 나머지 성공분은 그대로 첨부된다.
      for (const f of list) {
        try {
          uploaded.push(await uploadFile(f, tempId));
        } catch (e) {
          failed.push(`· ${f.name} — ${e?.message || "알 수 없는 오류"}`);
        }
      }
      if (uploaded.length) {
        if (isEdit)
          setEditData((p) => ({
            ...p,
            attachments: [...(p.attachments || []), ...uploaded],
          }));
        else
          setFormData((p) => ({
            ...p,
            attachments: [...p.attachments, ...uploaded],
          }));
      }
      if (failed.length) {
        alert(
          `파일 ${list.length}개 중 ${uploaded.length}개가 첨부되었습니다.\n\n` +
            `실패한 파일:\n${failed.join("\n")}`
        );
      }
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (i, isEdit = false) => {
    if (isEdit)
      setEditData((p) => ({
        ...p,
        attachments: p.attachments.filter((_, j) => j !== i),
      }));
    else
      setFormData((p) => ({
        ...p,
        attachments: p.attachments.filter((_, j) => j !== i),
      }));
  };

  // ── Derived data ─────────────────────────────────────────
  const allTickets = tickets;
  const myTickets = tickets;

  const filteredTickets = allTickets.filter((t) => {
    if (filterStatus !== "all" && t.status !== filterStatus) return false;
    if (filterType !== "all" && t.type !== filterType) return false;
    if (
      searchQuery &&
      !t.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !t.requester.toLowerCase().includes(searchQuery.toLowerCase())
    )
      return false;
    return true;
  });

  const stats = {
    total: allTickets.length,
    todo: allTickets.filter((t) => t.status === "todo").length,
    reviewing: allTickets.filter((t) => t.status === "reviewing").length,
    inProgress: allTickets.filter((t) => t.status === "in-progress").length,
    done: allTickets.filter((t) => t.status === "done").length,
  };

  // ════════════════════════════════════════════════════════════
  // RENDER: Loading
  // ════════════════════════════════════════════════════════════
  if (authLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f4f3ef",
          fontFamily: "'Apple SD Gothic Neo','Malgun Gothic',sans-serif",
        }}
      >
        <style>{CSS}</style>
        <div style={{ textAlign: "center", color: "#9ca3af" }}>
          <div className="spin" style={{ fontSize: 36, marginBottom: 12 }}>
            ⏳
          </div>
          <div>로딩 중...</div>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════
  // RENDER: Login screen
  // ════════════════════════════════════════════════════════════
  if (!session) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg,#eef2ff 0%,#fdf4ff 100%)",
          fontFamily: "'Apple SD Gothic Neo','Malgun Gothic',sans-serif",
        }}
      >
        <style>{CSS}</style>
        <div style={{ position: "fixed", top: 18, right: 20 }}>
          <button
            className="btn"
            onClick={() => setLang(lang === "ko" ? "en" : "ko")}
            style={{
              padding: "6px 13px",
              borderRadius: 99,
              background: "white",
              border: "1px solid #e5e7eb",
              fontSize: 13,
              fontWeight: 700,
              color: "#6b7280",
              boxShadow: "0 1px 4px rgba(0,0,0,.08)",
            }}
          >
            {lang === "ko" ? "🇺🇸 EN" : "🇰🇷 KO"}
          </button>
        </div>
        <div
          style={{
            background: "white",
            borderRadius: 24,
            padding: "52px 48px",
            maxWidth: 420,
            width: "100%",
            boxShadow: "0 24px 64px rgba(0,0,0,.12)",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 18,
              background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
              margin: "0 auto 20px",
            }}
          >
            🎨
          </div>
          <div style={{ fontWeight: 800, fontSize: 24, marginBottom: 8 }}>
            Design Request Hub
          </div>
          <div
            style={{
              fontSize: 14,
              color: "#6b7280",
              marginBottom: 36,
              lineHeight: 1.6,
            }}
          >
            {t(
              "디자인 요청 및 진행 현황을 관리하는 공간입니다.",
              "Manage design requests and track their progress."
            )}
            <br />
            {t(
              "구글 계정으로 로그인해주세요.",
              "Please sign in with your Google account."
            )}
          </div>
          <button
            className="btn"
            onClick={signInWithGoogle}
            style={{
              width: "100%",
              padding: "14px 0",
              borderRadius: 12,
              background: "white",
              border: "2px solid #e5e7eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              fontSize: 15,
              fontWeight: 700,
              color: "#374151",
            }}
          >
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.35-8.16 2.35-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
            {t("Google로 로그인", "Sign in with Google")}
          </button>
          <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 20 }}>
            {t(
              "playtag.ai 계정으로 로그인해주세요",
              "Please use your playtag.ai account"
            )}
          </div>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════
  // RENDER: Main app
  // ════════════════════════════════════════════════════════════
  const userName = session.user_metadata?.full_name || session.email;
  const userAvatar = session.user_metadata?.avatar_url;

  return (
    <div
      style={{
        background: "#f4f3ef",
        minHeight: "100vh",
        color: "#1a1a1a",
        fontFamily: "'Apple SD Gothic Neo','Malgun Gothic',sans-serif",
      }}
    >
      <style>{CSS}</style>

      {/* ── 실시간 업데이트 토스트 ── */}
      {realtimeToast && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 999,
            background: "white",
            borderRadius: 14,
            padding: "14px 18px",
            boxShadow: "0 8px 32px rgba(0,0,0,.18)",
            border: "1.5px solid #d1fae5",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: 320,
            animation: "fadeIn .3s ease",
          }}
        >
          <span style={{ fontSize: 20 }}>🔔</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: "#065f46" }}>
              {realtimeToast.label}
            </div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
              {realtimeToast.title}
            </div>
          </div>
        </div>
      )}

      {/* ── HEADER ── */}
      <div
        style={{
          background: "white",
          borderBottom: "1px solid #e5e7eb",
          padding: "0 24px",
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
        <div
          style={{
            maxWidth: 1400,
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            gap: 4,
            height: 58,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginRight: 16,
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 15,
              }}
            >
              🎨
            </div>
            <span style={{ fontWeight: 800, fontSize: 15 }}>
              Design Request Hub
            </span>
          </div>

          <nav style={{ display: "flex", gap: 2 }}>
            {!isAdmin ? (
              <>
                <button
                  className={`navbtn${view === "my-tickets" ? " on" : ""}`}
                  onClick={() => {
                    setView("my-tickets");
                    setSelectedTicket(null);
                  }}
                >
                  🎫 {t("내 요청작업", "My Requests")}
                </button>
                <button
                  className={`navbtn${view === "form" ? " on" : ""}`}
                  onClick={() => {
                    setView("form");
                    setSelectedTicket(null);
                  }}
                >
                  📝 {t("요청하기", "New Request")}
                </button>
                <button
                  className={`navbtn${view === "files" ? " on" : ""}`}
                  onClick={() => {
                    setView("files");
                    setSelectedTicket(null);
                  }}
                >
                  📂 {t("파일 찾기", "Find Files")}
                </button>
              </>
            ) : (
              <>
                <button
                  className={`navbtn${view === "dashboard" ? " on" : ""}`}
                  onClick={() => {
                    setView("dashboard");
                    setSelectedTicket(null);
                  }}
                >
                  📊 {t("현황", "Dashboard")}
                </button>
                <button
                  className={`navbtn${view === "form" ? " on" : ""}`}
                  onClick={() => {
                    setView("form");
                    setSelectedTicket(null);
                  }}
                >
                  📝 {t("요청하기", "New Request")}
                </button>
                <button
                  className={`navbtn${view === "files" ? " on" : ""}`}
                  onClick={() => {
                    setView("files");
                    setSelectedTicket(null);
                  }}
                >
                  📂 {t("파일 찾기", "Find Files")}
                </button>
              </>
            )}
          </nav>

          <div style={{ flex: 1 }} />

          {/* 실시간 연결 상태 인디케이터 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              background: realtimeConnected ? "#f0fdf4" : "#f9fafb",
              border: `1px solid ${realtimeConnected ? "#bbf7d0" : "#e5e7eb"}`,
              borderRadius: 8,
              padding: "4px 10px",
              fontSize: 12,
              fontWeight: 600,
              color: realtimeConnected ? "#15803d" : "#9ca3af",
              marginRight: 8,
              gap: 4,
            }}
          >
            <span
              className={`realtime-dot ${realtimeConnected ? "active" : "off"}`}
            />
            {realtimeConnected
              ? t("실시간", "Live")
              : t("연결 중...", "Connecting...")}
          </div>

          <button
            className="btn"
            onClick={fetchTickets}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              background: "#f3f4f6",
              color: "#374151",
              fontWeight: 600,
              fontSize: 13,
              marginRight: 8,
            }}
          >
            {loading ? <span className="spin">↻</span> : "↻"}
          </button>

          {isAdmin && (
            <div
              style={{
                background: "#fef3c7",
                border: "1px solid #fde68a",
                borderRadius: 8,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 700,
                color: "#92400e",
                marginRight: 8,
              }}
            >
              👑 {t("관리자", "Admin")}
            </div>
          )}

          <button
            className="btn"
            onClick={() => setLang((l) => (l === "ko" ? "en" : "ko"))}
            style={{
              padding: "5px 10px",
              borderRadius: 8,
              background: "#f3f4f6",
              color: "#374151",
              fontWeight: 700,
              fontSize: 12,
              marginRight: 4,
            }}
          >
            {lang === "ko" ? "🇺🇸 EN" : "🇰🇷 KO"}
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {userAvatar ? (
              <img
                src={userAvatar}
                alt=""
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 99,
                  border: "2px solid #e5e7eb",
                }}
              />
            ) : (
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 99,
                  background: "#6366f1",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  fontWeight: 800,
                  fontSize: 13,
                }}
              >
                {userName[0]?.toUpperCase()}
              </div>
            )}
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#374151",
                maxWidth: 120,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {userName}
            </span>
            <button
              className="btn"
              onClick={signOut}
              style={{
                padding: "5px 10px",
                borderRadius: 8,
                background: "#f3f4f6",
                color: "#6b7280",
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              {t("로그아웃", "Sign out")}
            </button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: 24 }}>
        {loading && (
          <div
            style={{ textAlign: "center", padding: "60px 0", color: "#9ca3af" }}
          >
            <div className="spin" style={{ fontSize: 32, marginBottom: 12 }}>
              ⏳
            </div>
            <div>불러오는 중...</div>
          </div>
        )}

        {!loading && view === "my-tickets" && (
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 20,
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 20 }}>
                🎫 {t("내 요청 목록", "My Requests")}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn"
                  onClick={() => setView("files")}
                  style={{
                    padding: "8px 16px",
                    background: "white",
                    border: "1.5px solid #e5e7eb",
                    borderRadius: 10,
                    fontWeight: 600,
                    fontSize: 13,
                    color: "#374151",
                  }}
                >
                  📂 {t("파일 찾기", "Find Files")}
                </button>
                <button
                  className="btn"
                  onClick={() => setView("form")}
                  style={{
                    padding: "8px 16px",
                    background: "#6366f1",
                    color: "white",
                    borderRadius: 10,
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  📝 {t("요청하기", "New Request")}
                </button>
              </div>
            </div>
            {myTickets.length === 0 ? (
              <div
                style={{
                  background: "white",
                  borderRadius: 16,
                  padding: "60px 32px",
                  textAlign: "center",
                  color: "#9ca3af",
                  boxShadow: "0 2px 8px rgba(0,0,0,.06)",
                }}
              >
                <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: 18,
                    color: "#374151",
                    marginBottom: 8,
                  }}
                >
                  {t("아직 요청한 내역이 없어요", "No requests yet")}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: "#9ca3af",
                    marginBottom: 28,
                    lineHeight: 1.6,
                  }}
                >
                  {t(
                    "요청 전에 먼저 파일을 찾아보세요.",
                    "Check if a file already exists before requesting."
                  )}
                  <br />
                  {t(
                    "원하는 파일이 없으면 디자인팀에 요청해주세요!",
                    "If not found, submit a design request!"
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    justifyContent: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    className="btn"
                    onClick={() => setView("files")}
                    style={{
                      padding: "12px 28px",
                      background: "white",
                      border: "2px solid #6366f1",
                      color: "#6366f1",
                      borderRadius: 12,
                      fontWeight: 700,
                      fontSize: 14,
                    }}
                  >
                    📂 {t("파일 찾기", "Find Files")}
                  </button>
                  <button
                    className="btn"
                    onClick={() => setView("form")}
                    style={{
                      padding: "12px 28px",
                      background: "#6366f1",
                      color: "white",
                      borderRadius: 12,
                      fontWeight: 700,
                      fontSize: 14,
                    }}
                  >
                    📝 {t("요청하기 →", "New Request →")}
                  </button>
                </div>
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                {myTickets.map((ticket) => {
                  const st = getStatus(ticket.status);
                  const pr = getPriority(ticket.priority);
                  return (
                    <div
                      key={ticket.id}
                      className="card"
                      onClick={() => setSelectedTicket(ticket)}
                      style={{
                        background: "white",
                        borderRadius: 14,
                        padding: "18px 20px",
                        boxShadow: "0 2px 8px rgba(0,0,0,.06)",
                        borderLeft: `5px solid ${st.color}`,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: 12,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              marginBottom: 6,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11,
                                color: "#9ca3af",
                                fontWeight: 600,
                              }}
                            >
                              {ticket.id}
                            </span>
                            <span
                              className="tag"
                              style={{ background: st.bg, color: st.color }}
                            >
                              {st.label[lang]}
                            </span>
                            {ticket.meetingRequested && (
                              <span
                                className="tag"
                                style={{
                                  background: "#fdf4ff",
                                  color: "#a21caf",
                                }}
                              >
                                ☕
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontWeight: 700,
                              fontSize: 16,
                              marginBottom: 8,
                            }}
                          >
                            {ticket.title}
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            {ticket.type && (
                              <span
                                className="tag"
                                style={{
                                  background: "#f3f4f6",
                                  color: "#374151",
                                }}
                              >
                                {ticket.type}
                              </span>
                            )}
                            <span
                              className="tag"
                              style={{
                                background: pr.color + "22",
                                color: pr.color,
                              }}
                            >
                              {pr.label[lang]}
                            </span>
                            {ticket.publishType && (
                              <span
                                className="tag"
                                style={{
                                  background: "#ecfdf5",
                                  color: "#059669",
                                }}
                              >
                                {ticket.publishType === "online"
                                  ? "RGB"
                                  : ticket.publishType === "offline"
                                  ? "CMYK"
                                  : "RGB+CMYK"}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div
                            style={{
                              fontSize: 13,
                              color: "#6366f1",
                              fontWeight: 700,
                              marginBottom: 4,
                            }}
                          >
                            {ticket.designer ? (
                              `🎨 ${ticket.designer}`
                            ) : (
                              <span style={{ color: "#9ca3af" }}>
                                {t("담당자 배정 중", "Assigning designer")}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: "#9ca3af" }}>
                            {t("마감", "Due")} {ticket.dueDate}
                          </div>
                          <div style={{ fontSize: 12, color: "#9ca3af" }}>
                            {t("요청일", "Requested")} {ticket.requestDate}
                          </div>
                          {ticket.comments.length > 0 && (
                            <div
                              style={{
                                fontSize: 12,
                                color: "#6366f1",
                                marginTop: 4,
                              }}
                            >
                              💬 {ticket.comments.length}
                              {t("개 코멘트", " comments")}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {!loading && isAdmin && view === "dashboard" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 18,
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <div
              style={{
                display: "flex",
                background: "#f3f4f6",
                borderRadius: 10,
                padding: 4,
                gap: 2,
              }}
            >
              <button
                className="btn"
                onClick={() => setAdminSubView("board")}
                style={{
                  padding: "7px 18px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  background:
                    adminSubView === "board" ? "white" : "transparent",
                  color: adminSubView === "board" ? "#1a1a1a" : "#6b7280",
                  boxShadow:
                    adminSubView === "board"
                      ? "0 1px 4px rgba(0,0,0,.1)"
                      : "none",
                }}
              >
                📋 {t("보드", "Board")}
              </button>
              <button
                className="btn"
                onClick={() => setAdminSubView("list")}
                style={{
                  padding: "7px 18px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  background: adminSubView === "list" ? "white" : "transparent",
                  color: adminSubView === "list" ? "#1a1a1a" : "#6b7280",
                  boxShadow:
                    adminSubView === "list"
                      ? "0 1px 4px rgba(0,0,0,.1)"
                      : "none",
                }}
              >
                📄 {t("리스트", "List")}
              </button>
            </div>
            <div
              style={{
                display: "flex",
                gap: 10,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <input
                className="inp"
                style={{ width: 210 }}
                placeholder={t("🔍 검색...", "🔍 Search...")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <select
                className="inp"
                style={{ width: 160 }}
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="all">{t("전체 상태", "All Statuses")}</option>
                {STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label[lang]}
                  </option>
                ))}
              </select>
              <select
                className="inp"
                style={{ width: 150 }}
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
              >
                <option value="all">{t("전체 유형", "All Types")}</option>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 13, color: "#9ca3af" }}>
                {filteredTickets.length}
                {t("개", "")}
              </span>
            </div>
          </div>
        )}

        {!loading &&
          isAdmin &&
          view === "dashboard" &&
          adminSubView === "board" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4,1fr)",
                gap: 14,
              }}
            >
              {STATUSES.map((status) => {
                const cols = filteredTickets.filter(
                  (t) => t.status === status.id
                );
                const isOver = dragOver === status.id;
                return (
                  <div
                    key={status.id}
                    style={{
                      background: isOver ? "#dbeafe" : "#ebe9f8",
                      borderRadius: 16,
                      padding: 14,
                      minHeight: 380,
                      border: isOver
                        ? "2px dashed #3b82f6"
                        : "2px solid transparent",
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(status.id);
                    }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={() => {
                      if (dragging) updateStatus(dragging.id, status.id);
                      setDragging(null);
                      setDragOver(null);
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 12,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: status.color,
                        }}
                      >
                        {status.label[lang]}
                      </span>
                      <span
                        style={{
                          background: status.color,
                          color: "white",
                          width: 20,
                          height: 20,
                          borderRadius: 99,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {cols.length}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      {cols.map((ticket) => {
                        const pr = getPriority(ticket.priority);
                        return (
                          <div
                            key={ticket.id}
                            className="card"
                            draggable
                            onDragStart={() => setDragging(ticket)}
                            onDragEnd={() => setDragging(null)}
                            onClick={() => setSelectedTicket(ticket)}
                            style={{
                              background: "white",
                              borderRadius: 12,
                              padding: 14,
                              boxShadow: "0 2px 8px rgba(0,0,0,.07)",
                              borderLeft: `4px solid ${status.color}`,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                              }}
                            >
                              <span style={{ fontSize: 11, color: "#9ca3af" }}>
                                {ticket.id}
                              </span>
                              {ticket.meetingRequested && (
                                <span
                                  style={{
                                    fontSize: 10,
                                    background: "#fdf4ff",
                                    border: "1px solid #e9d5ff",
                                    borderRadius: 4,
                                    padding: "1px 5px",
                                    color: "#a21caf",
                                    fontWeight: 700,
                                  }}
                                >
                                  ☕
                                </span>
                              )}
                            </div>
                            <div
                              style={{
                                fontWeight: 700,
                                fontSize: 13,
                                margin: "6px 0 10px",
                                lineHeight: 1.4,
                              }}
                            >
                              {ticket.title}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                gap: 5,
                                flexWrap: "wrap",
                                marginBottom: 8,
                              }}
                            >
                              {ticket.type && (
                                <span
                                  className="tag"
                                  style={{
                                    background: "#f3f4f6",
                                    color: "#374151",
                                  }}
                                >
                                  {ticket.type}
                                </span>
                              )}
                              <span
                                className="tag"
                                style={{
                                  background: pr.color + "22",
                                  color: pr.color,
                                }}
                              >
                                {pr.label[lang]}
                              </span>
                              {ticket.publishType && (
                                <span
                                  className="tag"
                                  style={{
                                    background: "#ecfdf5",
                                    color: "#059669",
                                  }}
                                >
                                  {ticket.publishType === "online"
                                    ? "RGB"
                                    : ticket.publishType === "offline"
                                    ? "CMYK"
                                    : "RGB+CMYK"}
                                </span>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                fontSize: 12,
                                color: "#6b7280",
                              }}
                            >
                              <span>👤 {ticket.requester}</span>
                              <span>📅 {ticket.dueDate}</span>
                            </div>
                            {ticket.designer && (
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "#6366f1",
                                  marginTop: 5,
                                }}
                              >
                                🎨 {ticket.designer}
                              </div>
                            )}
                            {ticket.comments.length > 0 && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "#9ca3af",
                                  marginTop: 5,
                                }}
                              >
                                💬 {ticket.comments.length}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {!cols.length && (
                        <div
                          style={{
                            textAlign: "center",
                            padding: "28px 0",
                            color: "#d1d5db",
                            fontSize: 13,
                          }}
                        >
                          {t("티켓 없음", "No tickets")}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

        {!loading &&
          isAdmin &&
          view === "dashboard" &&
          adminSubView === "list" && (
            <div
              style={{
                background: "white",
                borderRadius: 16,
                overflow: "hidden",
                boxShadow: "0 1px 4px rgba(0,0,0,.06)",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr
                    style={{
                      background: "#f9fafb",
                      borderBottom: "2px solid #e5e7eb",
                    }}
                  >
                    {[
                      "ID",
                      "제목",
                      "상태",
                      "유형",
                      "우선순위",
                      "Publish",
                      "요청자",
                      "담당자",
                      "마감일",
                      "",
                    ].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "12px 14px",
                          textAlign: "left",
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#6b7280",
                          textTransform: "uppercase",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredTickets.map((ticket, i) => {
                    const st = getStatus(ticket.status);
                    const pr = getPriority(ticket.priority);
                    return (
                      <tr
                        key={ticket.id}
                        style={{
                          borderBottom: "1px solid #f3f4f6",
                          background: i % 2 === 0 ? "white" : "#fafafa",
                          cursor: "pointer",
                        }}
                        onClick={() => setSelectedTicket(ticket)}
                      >
                        <td
                          style={{
                            padding: "11px 14px",
                            fontSize: 11,
                            color: "#9ca3af",
                            fontWeight: 600,
                          }}
                        >
                          {ticket.id}
                        </td>
                        <td
                          style={{
                            padding: "11px 14px",
                            fontWeight: 600,
                            fontSize: 14,
                          }}
                        >
                          {ticket.title}
                          {ticket.meetingRequested && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 11,
                                background: "#fdf4ff",
                                border: "1px solid #e9d5ff",
                                borderRadius: 4,
                                padding: "1px 5px",
                                color: "#a21caf",
                              }}
                            >
                              ☕
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "11px 14px" }}>
                          <span
                            className="tag"
                            style={{
                              background: st.bg,
                              color: st.color,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {st.label[lang]}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "11px 14px",
                            fontSize: 13,
                            color: "#6b7280",
                          }}
                        >
                          {ticket.type || "-"}
                        </td>
                        <td style={{ padding: "11px 14px" }}>
                          <span
                            className="tag"
                            style={{
                              background: pr.color + "22",
                              color: pr.color,
                            }}
                          >
                            {pr.label[lang]}
                          </span>
                        </td>
                        <td style={{ padding: "11px 14px" }}>
                          {ticket.publishType ? (
                            <span
                              className="tag"
                              style={{
                                background: "#ecfdf5",
                                color: "#059669",
                              }}
                            >
                              {ticket.publishType === "online"
                                ? "RGB"
                                : ticket.publishType === "offline"
                                ? "CMYK"
                                : "RGB+CMYK"}
                            </span>
                          ) : (
                            <span style={{ color: "#d1d5db" }}>-</span>
                          )}
                        </td>
                        <td style={{ padding: "11px 14px", fontSize: 13 }}>
                          {ticket.requester}
                        </td>
                        <td
                          style={{
                            padding: "11px 14px",
                            fontSize: 13,
                            color: ticket.designer ? "#6366f1" : "#d1d5db",
                          }}
                        >
                          {ticket.designer || "미배정"}
                        </td>
                        <td
                          style={{
                            padding: "11px 14px",
                            fontSize: 13,
                            color: "#6b7280",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {ticket.dueDate}
                        </td>
                        <td style={{ padding: "11px 14px" }}>
                          <button
                            className="btn"
                            style={{
                              padding: "4px 12px",
                              background: "#f3f4f6",
                              borderRadius: 8,
                              fontSize: 12,
                              fontWeight: 600,
                            }}
                          >
                            보기 →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!filteredTickets.length && (
                    <tr>
                      <td
                        colSpan={10}
                        style={{
                          padding: 40,
                          textAlign: "center",
                          color: "#9ca3af",
                        }}
                      >
                        검색 결과가 없습니다.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

        {view === "files" && (
          <div style={{ maxWidth: 860, margin: "0 auto" }}>
            <div style={{ marginBottom: 24 }}>
              <div
                style={{
                  fontWeight: 900,
                  fontSize: 26,
                  letterSpacing: "-0.5px",
                  marginBottom: 6,
                }}
              >
                🔍 {t("파일 찾기", "File Search")}
              </div>
              <div style={{ fontSize: 14, color: "#6b7280", lineHeight: 1.6 }}>
                {t(
                  "디자인 파일, 로고, 브랜드 에셋 등을 요청 전에 먼저 찾아보세요.",
                  "Search for design files, logos, brand assets, and more before submitting a request."
                )}
                <br />
                <span style={{ fontSize: 12, color: "#9ca3af" }}>
                  {t(
                    "playtag.ai 공유 드라이브에서 검색합니다.",
                    "Searching within the playtag.ai shared Drive."
                  )}
                </span>
              </div>
            </div>
            <div
              style={{
                background: "white",
                borderRadius: 16,
                padding: 20,
                boxShadow: "0 2px 8px rgba(0,0,0,.06)",
                marginBottom: 20,
              }}
            >
              <div style={{ display: "flex", gap: 10 }}>
                <input
                  className="inp"
                  style={{ fontSize: 15, flex: 1 }}
                  placeholder={t(
                    "파일명으로 검색... 예) 로고, logo, brand, icon",
                    "Search by file name... e.g. logo, brand, icon"
                  )}
                  value={driveQuery}
                  onChange={(e) => setDriveQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") searchDrive(driveQuery);
                  }}
                />
                <button
                  className="btn"
                  onClick={() => searchDrive(driveQuery)}
                  disabled={driveLoading}
                  style={{
                    padding: "10px 22px",
                    background: "#6366f1",
                    color: "white",
                    borderRadius: 10,
                    fontWeight: 700,
                    fontSize: 14,
                    flexShrink: 0,
                  }}
                >
                  {driveLoading ? (
                    <span className="spin">⏳</span>
                  ) : (
                    t("검색", "Search")
                  )}
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 12,
                  flexWrap: "wrap",
                }}
              >
                {[
                  "로고",
                  "logo",
                  "brand",
                  "icon",
                  "banner",
                  "template",
                  "font",
                ].map((tag) => (
                  <button
                    key={tag}
                    className="btn"
                    onClick={() => {
                      setDriveQuery(tag);
                      searchDrive(tag);
                    }}
                    style={{
                      padding: "4px 12px",
                      borderRadius: 99,
                      fontSize: 12,
                      fontWeight: 600,
                      background: "#f3f4f6",
                      color: "#374151",
                      border: "1px solid #e5e7eb",
                    }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
            {driveLoading && (
              <div
                style={{
                  textAlign: "center",
                  padding: "48px 0",
                  color: "#9ca3af",
                }}
              >
                <div
                  className="spin"
                  style={{ fontSize: 32, display: "block", marginBottom: 12 }}
                >
                  ⏳
                </div>
                <div>{t("드라이브 검색 중...", "Searching Drive...")}</div>
              </div>
            )}
            {!driveLoading && driveSearched && driveResults.length === 0 && (
              <div
                style={{
                  background: "white",
                  borderRadius: 16,
                  padding: "48px 0",
                  textAlign: "center",
                  boxShadow: "0 2px 8px rgba(0,0,0,.06)",
                }}
              >
                <div style={{ fontSize: 36, marginBottom: 12 }}>🔎</div>
                <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
                  {t("파일을 찾지 못했어요", "No files found")}
                </div>
                <div
                  style={{ fontSize: 14, color: "#6b7280", marginBottom: 20 }}
                >
                  {t(
                    "다른 검색어로 시도해보거나, 디자인팀에 요청해주세요.",
                    "Try a different keyword or submit a design request."
                  )}
                </div>
                <button
                  className="btn"
                  onClick={() => setView("form")}
                  style={{
                    padding: "10px 24px",
                    background: "#6366f1",
                    color: "white",
                    borderRadius: 10,
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  📝 {t("디자인 요청하기", "Submit a Design Request")}
                </button>
              </div>
            )}
            {!driveLoading && driveResults.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: 13,
                    color: "#6b7280",
                    marginBottom: 12,
                    fontWeight: 600,
                  }}
                >
                  {driveResults.length}
                  {t("개 파일 발견", " files found")}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(260px, 1fr))",
                    gap: 12,
                  }}
                >
                  {driveResults.map((file) => {
                    const isFolder =
                      file.mimeType === "application/vnd.google-apps.folder";
                    const isImage = file.mimeType?.startsWith("image/");
                    const icon = isFolder
                      ? "📁"
                      : file.mimeType === "application/vnd.google-apps.document"
                      ? "📄"
                      : file.mimeType ===
                        "application/vnd.google-apps.spreadsheet"
                      ? "📊"
                      : file.mimeType ===
                        "application/vnd.google-apps.presentation"
                      ? "📑"
                      : file.mimeType === "application/pdf"
                      ? "📕"
                      : isImage
                      ? "🖼️"
                      : file.mimeType?.startsWith("video/")
                      ? "🎬"
                      : "📎";
                    return (
                      <a
                        key={file.id}
                        href={file.webViewLink}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          background: "white",
                          borderRadius: 14,
                          padding: 18,
                          boxShadow: "0 2px 8px rgba(0,0,0,.06)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                          textDecoration: "none",
                          color: "inherit",
                          border: "2px solid transparent",
                          transition: "border-color .15s, box-shadow .15s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = "#6366f1";
                          e.currentTarget.style.boxShadow =
                            "0 4px 16px rgba(99,102,241,.15)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = "transparent";
                          e.currentTarget.style.boxShadow =
                            "0 2px 8px rgba(0,0,0,.06)";
                        }}
                      >
                        <div
                          style={{
                            height: 100,
                            borderRadius: 8,
                            background:
                              isImage && file.thumbnailLink
                                ? "transparent"
                                : "#f3f4f6",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            overflow: "hidden",
                            flexShrink: 0,
                          }}
                        >
                          {isImage && file.thumbnailLink ? (
                            <img
                              src={file.thumbnailLink}
                              alt={file.name}
                              style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                              }}
                            />
                          ) : (
                            <span style={{ fontSize: 40 }}>{icon}</span>
                          )}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 700,
                              fontSize: 14,
                              lineHeight: 1.4,
                              marginBottom: 4,
                              overflow: "hidden",
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                            }}
                          >
                            {file.name}
                          </div>
                          <div style={{ fontSize: 11, color: "#9ca3af" }}>
                            {file.modifiedTime
                              ? new Date(file.modifiedTime).toLocaleDateString(
                                  "ko-KR"
                                )
                              : ""}
                            {file.size
                              ? ` · ${formatFileSize(parseInt(file.size))}`
                              : ""}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                          }}
                        >
                          <span
                            style={{
                              fontSize: 11,
                              background: "#f3f4f6",
                              borderRadius: 6,
                              padding: "2px 8px",
                              color: "#6b7280",
                              fontWeight: 600,
                            }}
                          >
                            {isFolder
                              ? t("폴더", "Folder")
                              : file.mimeType?.includes("google-apps")
                              ? "Google Doc"
                              : file.mimeType?.split("/")[1]?.toUpperCase() ||
                                t("파일", "File")}
                          </span>
                          <span
                            style={{
                              fontSize: 12,
                              color: "#6366f1",
                              fontWeight: 700,
                            }}
                          >
                            {t("열기 →", "Open →")}
                          </span>
                        </div>
                      </a>
                    );
                  })}
                </div>
                <div
                  style={{
                    marginTop: 20,
                    padding: 16,
                    background: "#f0fdf4",
                    borderRadius: 12,
                    border: "1px solid #bbf7d0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div
                    style={{ fontSize: 13, color: "#15803d", fontWeight: 600 }}
                  >
                    {t(
                      "필요한 파일을 못 찾으셨나요?",
                      "Couldn't find what you need?"
                    )}
                  </div>
                  <button
                    className="btn"
                    onClick={() => setView("form")}
                    style={{
                      padding: "8px 18px",
                      background: "#16a34a",
                      color: "white",
                      borderRadius: 8,
                      fontWeight: 700,
                      fontSize: 13,
                    }}
                  >
                    📝 {t("디자인 요청하기", "Submit a Design Request")}
                  </button>
                </div>
              </div>
            )}
            {!driveSearched && (
              <div
                style={{
                  background: "white",
                  borderRadius: 16,
                  padding: "40px 0",
                  textAlign: "center",
                  boxShadow: "0 2px 8px rgba(0,0,0,.06)",
                }}
              >
                <div style={{ fontSize: 40, marginBottom: 16 }}>📂</div>
                <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
                  {t("파일명으로 검색해보세요", "Search by file name")}
                </div>
                <div style={{ fontSize: 14, color: "#6b7280" }}>
                  {t(
                    "로고, 브랜드 에셋, 템플릿 등을 찾을 수 있어요",
                    "Find logos, brand assets, templates, and more"
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {view === "form" && (
          <div style={{ maxWidth: 680, margin: "0 auto" }}>
            <div style={{ marginBottom: 24 }}>
              <div
                style={{
                  fontWeight: 900,
                  fontSize: 26,
                  letterSpacing: "-0.5px",
                  marginBottom: 6,
                }}
              >
                {t("디자인 요청하기", "New Design Request")}
              </div>
              <div style={{ fontSize: 13, color: "#9ca3af", lineHeight: 1.6 }}>
                {t(
                  "아는 선에서 최대한 자세히 적어주세요. 빈칸이 많을수록 확인 미팅이 길어집니다 😉",
                  "Please fill in as much detail as possible. The more info, the faster we can start 😉"
                )}
                <span
                  style={{
                    marginLeft: 10,
                    background: "#fef3c7",
                    color: "#92400e",
                    borderRadius: 6,
                    padding: "2px 8px",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {t(
                    "마감 최소 3일 전 요청",
                    "Request at least 3 days before deadline"
                  )}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* ① 제목 */}
              <div
                style={{
                  background: "white",
                  borderRadius: 14,
                  padding: "20px 22px",
                  boxShadow: "0 1px 4px rgba(0,0,0,.06)",
                  borderLeft: "4px solid #6366f1",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                  }}
                >
                  <label
                    style={{
                      fontWeight: 800,
                      fontSize: 13,
                      color: "#6366f1",
                      textTransform: "uppercase",
                      letterSpacing: "0.6px",
                    }}
                  >
                    01 — {t("요청 제목", "Request Title")}{" "}
                    <span style={{ color: "#ef4444" }}>*</span>
                  </label>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    {userAvatar && (
                      <img
                        src={userAvatar}
                        alt=""
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 99,
                          border: "1.5px solid #e5e7eb",
                        }}
                      />
                    )}
                    <span
                      style={{
                        fontSize: 12,
                        color: "#6b7280",
                        fontWeight: 600,
                      }}
                    >
                      {userName}
                    </span>
                  </div>
                </div>
                <input
                  className="inp"
                  placeholder={t(
                    "예) 3월 이벤트 SNS 배너 제작",
                    "e.g. March event SNS banner design"
                  )}
                  value={formData.title}
                  onChange={(e) =>
                    setFormData({ ...formData, title: e.target.value })
                  }
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    padding: "12px 16px",
                    border: "2px solid #e5e7eb",
                    borderRadius: 10,
                  }}
                />
              </div>

              {/* ② 유형 + 스펙 */}
              <div
                style={{
                  background: "white",
                  borderRadius: 14,
                  padding: "20px 22px",
                  boxShadow: "0 1px 4px rgba(0,0,0,.06)",
                  borderLeft: "4px solid #10b981",
                }}
              >
                <label
                  style={{
                    display: "block",
                    fontWeight: 800,
                    fontSize: 13,
                    color: "#10b981",
                    textTransform: "uppercase",
                    letterSpacing: "0.6px",
                    marginBottom: 16,
                  }}
                >
                  02 — {t("요청 유형 및 작업 스펙", "Request Type & Specs")}
                </label>
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#6b7280",
                      marginBottom: 8,
                    }}
                  >
                    {t("요청 유형", "Type")}{" "}
                    <span style={{ fontWeight: 400, color: "#9ca3af" }}>
                      ({t("선택", "optional")})
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {TYPES.map((t) => (
                      <button
                        key={t}
                        className="btn"
                        onClick={() =>
                          setFormData({
                            ...formData,
                            type: formData.type === t ? "" : t,
                          })
                        }
                        style={{
                          padding: "6px 13px",
                          borderRadius: 99,
                          fontSize: 12,
                          fontWeight: 600,
                          background:
                            formData.type === t ? "#10b981" : "#f3f4f6",
                          color: formData.type === t ? "white" : "#374151",
                          border: "none",
                          transition: "all .15s",
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div
                  style={{ height: 1, background: "#f3f4f6", margin: "16px 0" }}
                />
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#6b7280",
                      marginBottom: 8,
                    }}
                  >
                    Publish 유형{" "}
                    <span style={{ fontWeight: 400, color: "#9ca3af" }}>
                      (RGB / CMYK)
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {PUBLISH_TYPES.map((opt) => {
                      const on = formData.publishType === opt.id;
                      return (
                        <button
                          key={opt.id}
                          className="btn"
                          onClick={() =>
                            setFormData({
                              ...formData,
                              publishType: on ? "" : opt.id,
                            })
                          }
                          style={{
                            flex: 1,
                            padding: "11px 6px",
                            borderRadius: 10,
                            border: on
                              ? "2px solid #10b981"
                              : "2px solid #e5e7eb",
                            background: on ? "#ecfdf5" : "#fafafa",
                            textAlign: "center",
                            transition: "all .15s",
                          }}
                        >
                          <div style={{ fontSize: 12, marginBottom: 2 }}>
                            {opt.label}
                          </div>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 800,
                              color: on ? "#10b981" : "#374151",
                            }}
                          >
                            {opt.sub}
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              color: "#9ca3af",
                              marginTop: 2,
                            }}
                          >
                            {opt.desc}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div
                  style={{ height: 1, background: "#f3f4f6", margin: "16px 0" }}
                />
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#6b7280",
                        marginBottom: 8,
                      }}
                    >
                      {t("작업 사이즈", "Work Size")}{" "}
                      <span style={{ fontWeight: 400, color: "#9ca3af" }}>
                        ({t("선택", "optional")})
                      </span>
                    </div>
                    <input
                      className="inp"
                      placeholder={t(
                        "예) 1920×1080px  /  A4  /  1:1",
                        "e.g. 1920×1080px / A4 / 1:1"
                      )}
                      value={formData.workSize}
                      onChange={(e) =>
                        setFormData({ ...formData, workSize: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#6b7280",
                        marginBottom: 8,
                      }}
                    >
                      {t("파일 첨부", "Attachments")}{" "}
                      <span style={{ fontWeight: 400, color: "#9ca3af" }}>
                        (
                        {t(
                          "기획서·시안·참고자료",
                          "briefs, drafts, references"
                        )}
                        )
                      </span>
                    </div>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        height: 42,
                        border: "2px dashed #d1d5db",
                        borderRadius: 10,
                        cursor: "pointer",
                        background: "#fafafa",
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleFileUpload(e.dataTransfer.files);
                      }}
                    >
                      <input
                        type="file"
                        multiple
                        style={{ display: "none" }}
                        onChange={(e) => handleFileUpload(e.target.files)}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: uploading ? "#6366f1" : "#6b7280",
                        }}
                      >
                        {uploading
                          ? t("⏳ 업로드 중...", "⏳ Uploading...")
                          : t(
                              "📎 파일 선택 / 드래그",
                              "📎 Select / Drop files"
                            )}
                      </span>
                    </label>
                  </div>
                </div>
                {formData.attachments.length > 0 && (
                  <div
                    style={{
                      marginTop: 10,
                      display: "flex",
                      flexDirection: "column",
                      gap: 5,
                    }}
                  >
                    {formData.attachments.map((f, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          background: "#f9fafb",
                          borderRadius: 8,
                          padding: "7px 11px",
                        }}
                      >
                        <span style={{ fontSize: 14 }}>📄</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {f.name}
                          </div>
                          <div style={{ fontSize: 10, color: "#9ca3af" }}>
                            {formatFileSize(f.size)}
                          </div>
                        </div>
                        <button
                          className="btn"
                          onClick={() => removeAttachment(i)}
                          style={{
                            color: "#ef4444",
                            fontSize: 16,
                            lineHeight: 1,
                            background: "none",
                            padding: 2,
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ③ 일정 */}
              <div
                style={{
                  background: "white",
                  borderRadius: 14,
                  padding: "20px 22px",
                  boxShadow: "0 1px 4px rgba(0,0,0,.06)",
                  borderLeft: "4px solid #f59e0b",
                }}
              >
                <label
                  style={{
                    display: "block",
                    fontWeight: 800,
                    fontSize: 13,
                    color: "#d97706",
                    textTransform: "uppercase",
                    letterSpacing: "0.6px",
                    marginBottom: 16,
                  }}
                >
                  03 — {t("일정", "Schedule")}
                </label>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 14,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#6b7280",
                        marginBottom: 8,
                      }}
                    >
                      {t("디자인 마감 희망일", "Design Due Date")}{" "}
                      <span style={{ color: "#ef4444" }}>*</span>
                    </div>
                    <input
                      type="date"
                      className="inp"
                      value={formData.dueDate}
                      onChange={(e) =>
                        setFormData({ ...formData, dueDate: e.target.value })
                      }
                    />
                    <div
                      style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}
                    >
                      {t(
                        "검토 후 실제 일정으로 조율될 수 있어요",
                        "Actual schedule may be adjusted after review"
                      )}
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#6b7280",
                        marginBottom: 8,
                      }}
                    >
                      {t("전체 프로젝트 일정", "Overall Project Timeline")}{" "}
                      <span style={{ fontWeight: 400, color: "#9ca3af" }}>
                        ({t("선택", "optional")})
                      </span>
                    </div>
                    <input
                      className="inp"
                      placeholder={t(
                        "예) 3/1 기획 ~ 3/31 런칭",
                        "e.g. 3/1 planning ~ 3/31 launch"
                      )}
                      value={formData.projectSchedule}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          projectSchedule: e.target.value,
                        })
                      }
                    />
                    <div
                      style={{ fontSize: 11, color: "#9ca3af", marginTop: 5 }}
                    >
                      {t(
                        "전체 맥락 파악에 도움이 됩니다",
                        "Helps us understand the full context"
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* ④ 작업 내용 */}
              <div
                style={{
                  background: "white",
                  borderRadius: 14,
                  padding: "20px 22px",
                  boxShadow: "0 1px 4px rgba(0,0,0,.06)",
                  borderLeft: "4px solid #8b5cf6",
                }}
              >
                <label
                  style={{
                    display: "block",
                    fontWeight: 800,
                    fontSize: 13,
                    color: "#7c3aed",
                    textTransform: "uppercase",
                    letterSpacing: "0.6px",
                    marginBottom: 16,
                  }}
                >
                  04 — {t("작업 내용", "Work Details")}
                </label>
                <div style={{ marginBottom: 14 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#6b7280",
                      marginBottom: 8,
                    }}
                  >
                    {t("상세 설명", "Description")}
                  </div>
                  <div
                    style={{
                      border: "1.5px solid #e5e7eb",
                      borderRadius: 10,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        background: "#faf9ff",
                        borderBottom: "1px solid #ede9fe",
                        padding: "10px 14px",
                      }}
                    >
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: "3px 16px",
                        }}
                      >
                        {(lang === "ko"
                          ? [
                              "어떤 디자인이 필요한가요?",
                              "들어가야 할 텍스트/내용이 있나요?",
                              "톤앤매너나 분위기 방향이 있나요?",
                              "특별히 요청할 사항이 있나요?",
                            ]
                          : [
                              "What kind of design do you need?",
                              "Any specific text or content to include?",
                              "Any preferred tone, mood, or style?",
                              "Any other special requests?",
                            ]
                        ).map((q, i) => (
                          <div
                            key={i}
                            style={{
                              fontSize: 11,
                              color: "#a78bfa",
                              fontWeight: 600,
                            }}
                          >
                            · {q}
                          </div>
                        ))}
                      </div>
                    </div>
                    <textarea
                      style={{
                        width: "100%",
                        border: "none",
                        outline: "none",
                        padding: "12px 14px",
                        fontSize: 14,
                        fontFamily: "inherit",
                        resize: "vertical",
                        minHeight: 110,
                        background: "white",
                        display: "block",
                        lineHeight: 1.7,
                      }}
                      placeholder={t(
                        "위 항목을 참고해서 자유롭게 작성해주세요",
                        "Feel free to write based on the prompts above"
                      )}
                      value={formData.description}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          description: e.target.value,
                        })
                      }
                    />
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#6b7280",
                      marginBottom: 8,
                    }}
                  >
                    {t("레퍼런스", "References")}{" "}
                    <span style={{ fontWeight: 400, color: "#9ca3af" }}>
                      ({t("선택", "optional")})
                    </span>
                  </div>
                  <div
                    style={{
                      border: "1.5px solid #e5e7eb",
                      borderRadius: 10,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        background: "#faf9ff",
                        borderBottom: "1px solid #ede9fe",
                        padding: "8px 14px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          color: "#a78bfa",
                          fontWeight: 600,
                        }}
                      >
                        ·{" "}
                        {t(
                          "참고할 이미지 URL, 링크, 핀터레스트 보드 등을 자유롭게 붙여넣어 주세요",
                          "Paste any reference image URLs, links, Pinterest boards, etc."
                        )}
                      </div>
                    </div>
                    <textarea
                      style={{
                        width: "100%",
                        border: "none",
                        outline: "none",
                        padding: "12px 14px",
                        fontSize: 14,
                        fontFamily: "inherit",
                        resize: "vertical",
                        minHeight: 72,
                        background: "white",
                        display: "block",
                      }}
                      placeholder="https://..."
                      value={formData.reference}
                      onChange={(e) =>
                        setFormData({ ...formData, reference: e.target.value })
                      }
                    />
                  </div>
                </div>
              </div>

              {/* ⑤ 우선순위 + 미팅 */}
              <div
                style={{
                  background: "white",
                  borderRadius: 14,
                  padding: "20px 22px",
                  boxShadow: "0 1px 4px rgba(0,0,0,.06)",
                  borderLeft: "4px solid #ec4899",
                }}
              >
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 14 }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#6b7280",
                        marginBottom: 10,
                      }}
                    >
                      {t("우선순위", "Priority")}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {PRIORITIES.map((p) => (
                        <button
                          key={p.id}
                          className="btn"
                          onClick={() =>
                            setFormData({ ...formData, priority: p.id })
                          }
                          style={{
                            flex: 1,
                            padding: "9px 0",
                            borderRadius: 9,
                            fontWeight: 700,
                            fontSize: 13,
                            background:
                              formData.priority === p.id ? p.color : "#f3f4f6",
                            color:
                              formData.priority === p.id ? "white" : "#6b7280",
                            border: "none",
                            transition: "all .15s",
                          }}
                        >
                          {p.label[lang]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ height: 1, background: "#f9fafb" }} />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      cursor: "pointer",
                      padding: "4px 0",
                    }}
                    onClick={() =>
                      setFormData({
                        ...formData,
                        meetingRequested: !formData.meetingRequested,
                      })
                    }
                  >
                    <div
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        border: `2px solid ${
                          formData.meetingRequested ? "#d946ef" : "#d1d5db"
                        }`,
                        background: formData.meetingRequested
                          ? "#d946ef"
                          : "white",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        marginTop: 1,
                        transition: "all .15s",
                      }}
                    >
                      {formData.meetingRequested && (
                        <span
                          style={{
                            color: "white",
                            fontSize: 12,
                            fontWeight: 900,
                            lineHeight: 1,
                          }}
                        >
                          ✓
                        </span>
                      )}
                    </div>
                    <div>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: 14,
                          color: formData.meetingRequested
                            ? "#a21caf"
                            : "#374151",
                        }}
                      >
                        ☕ {t("구두 미팅 요청", "Request a Meeting")}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "#9ca3af",
                          marginTop: 2,
                          lineHeight: 1.5,
                        }}
                      >
                        {t(
                          "직접 설명이 필요한 경우 선택해주세요. 디자인팀에서 슬랙으로 일정을 잡아드립니다.",
                          "Select if you need to explain in person. The design team will schedule via Slack."
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, paddingBottom: 8 }}>
                <button
                  className="btn"
                  onClick={submitForm}
                  disabled={saving}
                  style={{
                    flex: 1,
                    padding: "15px 0",
                    background: saving ? "#a5b4fc" : "#6366f1",
                    color: "white",
                    borderRadius: 12,
                    fontWeight: 800,
                    fontSize: 15,
                    letterSpacing: "-0.2px",
                  }}
                >
                  {saving
                    ? t("⏳ 저장 중...", "⏳ Saving...")
                    : t("요청 제출하기 →", "Submit Request →")}
                </button>
                <button
                  className="btn"
                  onClick={() => setFormData(EMPTY_FORM)}
                  style={{
                    padding: "15px 18px",
                    background: "#f3f4f6",
                    color: "#6b7280",
                    borderRadius: 12,
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {t("초기화", "Reset")}
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedTicket && !editMode && (
          <div
            className="overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) setSelectedTicket(null);
            }}
          >
            <div className="modal">
              <div style={{ padding: "28px 28px 0" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    marginBottom: 18,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#9ca3af",
                        fontWeight: 700,
                        marginBottom: 4,
                      }}
                    >
                      {selectedTicket.id}
                    </div>
                    <div
                      style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.3 }}
                    >
                      {selectedTicket.title}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    {(isAdmin ||
                      selectedTicket.requesterEmail === session?.email) && (
                      <button
                        className="btn"
                        onClick={() => {
                          setEditData({ ...selectedTicket });
                          setEditMode(true);
                        }}
                        style={{
                          padding: "6px 14px",
                          background: "#f0fdf4",
                          border: "1px solid #bbf7d0",
                          borderRadius: 8,
                          fontSize: 13,
                          fontWeight: 700,
                          color: "#15803d",
                        }}
                      >
                        ✏️ 편집
                      </button>
                    )}
                    {isAdmin && (
                      <button
                        className="btn"
                        onClick={() => setShowDeleteConfirm(true)}
                        style={{
                          padding: "6px 14px",
                          background: "#fef2f2",
                          border: "1px solid #fecaca",
                          borderRadius: 8,
                          fontSize: 13,
                          fontWeight: 700,
                          color: "#dc2626",
                        }}
                      >
                        🗑️ 삭제
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={() => setSelectedTicket(null)}
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 99,
                        background: "#f3f4f6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 18,
                        color: "#6b7280",
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginBottom: 22,
                    flexWrap: "wrap",
                  }}
                >
                  {STATUSES.map((s) => (
                    <button
                      key={s.id}
                      className="btn"
                      onClick={() =>
                        isAdmin && updateStatus(selectedTicket.id, s.id)
                      }
                      style={{
                        padding: "6px 13px",
                        borderRadius: 99,
                        fontSize: 12,
                        fontWeight: 700,
                        background:
                          selectedTicket.status === s.id ? s.color : "#f3f4f6",
                        color:
                          selectedTicket.status === s.id ? "white" : "#6b7280",
                        cursor: isAdmin ? "pointer" : "default",
                        opacity:
                          !isAdmin && selectedTicket.status !== s.id ? 0.5 : 1,
                      }}
                    >
                      {s.label[lang]}
                    </button>
                  ))}
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 10,
                    marginBottom: 18,
                  }}
                >
                  {[
                    {
                      label: t("요청자", "Requester"),
                      value: selectedTicket.requester,
                    },
                    {
                      label: t("디자인 마감 희망일", "Due Date"),
                      value: selectedTicket.dueDate,
                    },
                    {
                      label: t("요청 유형", "Type"),
                      value: selectedTicket.type || t("미지정", "Unspecified"),
                    },
                    {
                      label: t("우선순위", "Priority"),
                      value: getPriority(selectedTicket.priority).label[lang],
                    },
                    {
                      label: t("요청일", "Request Date"),
                      value: selectedTicket.requestDate,
                    },
                    {
                      label: t("프로젝트 일정", "Project Timeline"),
                      value: selectedTicket.projectSchedule || "-",
                    },
                  ].map((f) => (
                    <div
                      key={f.label}
                      style={{
                        background: "#f9fafb",
                        borderRadius: 10,
                        padding: "10px 14px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          color: "#9ca3af",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          marginBottom: 3,
                        }}
                      >
                        {f.label}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>
                        {f.value}
                      </div>
                    </div>
                  ))}
                  <div
                    style={{
                      background: "#f9fafb",
                      borderRadius: 10,
                      padding: "10px 14px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        color: "#9ca3af",
                        fontWeight: 700,
                        textTransform: "uppercase",
                        marginBottom: 3,
                      }}
                    >
                      {t("담당 디자이너", "Designer")}
                    </div>
                    {isAdmin ? (
                      <select
                        style={{
                          background: "transparent",
                          border: "none",
                          fontSize: 14,
                          fontWeight: 700,
                          color: selectedTicket.designer
                            ? "#6366f1"
                            : "#9ca3af",
                          cursor: "pointer",
                          padding: 0,
                          outline: "none",
                          width: "100%",
                          fontFamily: "inherit",
                        }}
                        value={selectedTicket.designer}
                        onChange={(e) =>
                          updateField(
                            selectedTicket.id,
                            "designer",
                            e.target.value
                          )
                        }
                      >
                        <option value="">미배정</option>
                        {DESIGNERS.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: selectedTicket.designer
                            ? "#6366f1"
                            : "#9ca3af",
                        }}
                      >
                        {selectedTicket.designer || t("배정 중", "Pending")}
                      </div>
                    )}
                  </div>
                  {selectedTicket.publishType && (
                    <div
                      style={{
                        background: "#ecfdf5",
                        borderRadius: 10,
                        padding: "10px 14px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          color: "#9ca3af",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          marginBottom: 3,
                        }}
                      >
                        Publish
                      </div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: "#059669",
                        }}
                      >
                        {selectedTicket.publishType === "online"
                          ? t("🖥️ 온라인 (RGB)", "🖥️ Online (RGB)")
                          : selectedTicket.publishType === "offline"
                          ? t("🖨️ 오프라인 (CMYK)", "🖨️ Offline (CMYK)")
                          : t(
                              "🖥️🖨️ 온·오프라인 (RGB+CMYK)",
                              "🖥️🖨️ Both (RGB+CMYK)"
                            )}
                      </div>
                    </div>
                  )}
                  {selectedTicket.workSize && (
                    <div
                      style={{
                        background: "#f9fafb",
                        borderRadius: 10,
                        padding: "10px 14px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          color: "#9ca3af",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          marginBottom: 3,
                        }}
                      >
                        {t("작업 사이즈", "Work Size")}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>
                        {selectedTicket.workSize}
                      </div>
                    </div>
                  )}
                </div>

                {selectedTicket.description && (
                  <div style={{ marginBottom: 14 }}>
                    <div
                      style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}
                    >
                      📋 {t("작업 내용", "Work Details")}
                    </div>
                    <div
                      style={{
                        background: "#f9fafb",
                        borderRadius: 10,
                        padding: 14,
                        fontSize: 14,
                        lineHeight: 1.7,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {selectedTicket.description}
                    </div>
                  </div>
                )}
                {selectedTicket.reference && (
                  <div style={{ marginBottom: 14 }}>
                    <div
                      style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}
                    >
                      🔗 {t("레퍼런스", "References")}
                    </div>
                    <div
                      style={{
                        background: "#f9fafb",
                        borderRadius: 10,
                        padding: 14,
                        fontSize: 14,
                        lineHeight: 1.7,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      {selectedTicket.reference}
                    </div>
                  </div>
                )}
                {selectedTicket.attachments?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div
                      style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}
                    >
                      📎 {t("첨부파일", "Attachments")} (
                      {selectedTicket.attachments.length})
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      {selectedTicket.attachments.map((f, i) => (
                        <a
                          key={i}
                          href={f.url}
                          target="_blank"
                          rel="noreferrer"
                          className="attach-row"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            background: "#f9fafb",
                            borderRadius: 8,
                            padding: "8px 12px",
                            textDecoration: "none",
                            border: "1px solid #e5e7eb",
                          }}
                        >
                          <span>📄</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: "#374151",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {f.name}
                            </div>
                            <div style={{ fontSize: 11, color: "#9ca3af" }}>
                              {formatFileSize(f.size)}
                            </div>
                          </div>
                          <span
                            style={{
                              fontSize: 12,
                              color: "#6366f1",
                              fontWeight: 600,
                            }}
                          >
                            {t("다운로드 ↓", "Download ↓")}
                          </span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {selectedTicket.meetingRequested && (
                  <div
                    style={{
                      marginBottom: 14,
                      background: "#fdf4ff",
                      border: "1px solid #e9d5ff",
                      borderRadius: 10,
                      padding: "10px 14px",
                      fontSize: 13,
                      color: "#a21caf",
                      fontWeight: 700,
                    }}
                  >
                    ☕ {t("구두 미팅 요청됨", "Meeting Requested")}{" "}
                    {isAdmin
                      ? t(
                          "— 슬랙으로 일정을 잡아주세요!",
                          "— Please schedule via Slack!"
                        )
                      : t(
                          "— 디자인팀에서 슬랙으로 연락드릴 예정입니다.",
                          "— The design team will reach out via Slack."
                        )}
                  </div>
                )}

                <div style={{ marginBottom: 28 }}>
                  <div
                    style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}
                  >
                    💬 {t("코멘트", "Comments")} (
                    {selectedTicket.comments.length})
                  </div>
                  {selectedTicket.comments.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        marginBottom: 12,
                      }}
                    >
                      {selectedTicket.comments.map((c, i) => (
                        <div
                          key={i}
                          style={{
                            background: c.isSystem
                              ? "#fffbeb"
                              : c.author === "디자인팀"
                              ? "#ecfdf5"
                              : "#f0f9ff",
                            border: `1px solid ${
                              c.isSystem
                                ? "#fde68a"
                                : c.author === "디자인팀"
                                ? "#bbf7d0"
                                : "#bae6fd"
                            }`,
                            borderRadius: 10,
                            padding: "10px 14px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              marginBottom: 3,
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 700,
                                fontSize: 13,
                                color: c.isSystem
                                  ? "#92400e"
                                  : c.author === "디자인팀"
                                  ? "#15803d"
                                  : "#0369a1",
                              }}
                            >
                              {c.isSystem
                                ? t("🔧 시스템", "🔧 System")
                                : c.author}
                            </span>
                            <span style={{ fontSize: 11, color: "#9ca3af" }}>
                              {c.date}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: c.isSystem ? 12 : 14,
                              color: c.isSystem ? "#78716c" : "inherit",
                              fontStyle: c.isSystem ? "italic" : "normal",
                            }}
                          >
                            {c.text}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      className="inp"
                      style={{ flex: 1 }}
                      placeholder={t(
                        "코멘트 입력... (Enter)",
                        "Add a comment... (Enter)"
                      )}
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addComment(selectedTicket.id);
                      }}
                    />
                    <button
                      className="btn"
                      onClick={() => addComment(selectedTicket.id)}
                      style={{
                        padding: "10px 16px",
                        background: "#6366f1",
                        color: "white",
                        borderRadius: 10,
                        fontWeight: 700,
                      }}
                    >
                      {t("전송", "Send")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {editMode &&
          editData &&
          (isAdmin || selectedTicket?.requesterEmail === session?.email) && (
            <div
              className="overlay"
              onClick={(e) => {
                if (e.target === e.currentTarget) setEditMode(false);
              }}
            >
              <div className="modal">
                <div style={{ padding: 28 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 24,
                    }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 18 }}>
                      ✏️ {t("티켓 편집", "Edit Ticket")}
                    </div>
                    <button
                      className="btn"
                      onClick={() => setEditMode(false)}
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 99,
                        background: "#f3f4f6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 18,
                        color: "#6b7280",
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 16,
                    }}
                  >
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 700,
                          fontSize: 13,
                          marginBottom: 7,
                        }}
                      >
                        {t("제목", "Title")} *
                      </label>
                      <input
                        className="inp"
                        value={editData.title}
                        onChange={(e) =>
                          setEditData({ ...editData, title: e.target.value })
                        }
                      />
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 14,
                      }}
                    >
                      <div>
                        <label
                          style={{
                            display: "block",
                            fontWeight: 700,
                            fontSize: 13,
                            marginBottom: 7,
                          }}
                        >
                          {t("요청 유형", "Type")}
                        </label>
                        <select
                          className="inp"
                          value={editData.type}
                          onChange={(e) =>
                            setEditData({ ...editData, type: e.target.value })
                          }
                        >
                          <option value="">{t("선택 안함", "None")}</option>
                          {TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label
                          style={{
                            display: "block",
                            fontWeight: 700,
                            fontSize: 13,
                            marginBottom: 7,
                          }}
                        >
                          {t("마감일", "Due Date")} *
                        </label>
                        <input
                          type="date"
                          className="inp"
                          value={editData.dueDate}
                          onChange={(e) =>
                            setEditData({
                              ...editData,
                              dueDate: e.target.value,
                            })
                          }
                        />
                      </div>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 14,
                      }}
                    >
                      <div>
                        <label
                          style={{
                            display: "block",
                            fontWeight: 700,
                            fontSize: 13,
                            marginBottom: 7,
                          }}
                        >
                          {t("프로젝트 일정", "Project Timeline")}
                        </label>
                        <input
                          className="inp"
                          placeholder={t("예) 3/1 ~ 3/31", "e.g. 3/1 ~ 3/31")}
                          value={editData.projectSchedule}
                          onChange={(e) =>
                            setEditData({
                              ...editData,
                              projectSchedule: e.target.value,
                            })
                          }
                        />
                      </div>
                      <div>
                        <label
                          style={{
                            display: "block",
                            fontWeight: 700,
                            fontSize: 13,
                            marginBottom: 7,
                          }}
                        >
                          {t("작업 사이즈", "Work Size")}
                        </label>
                        <input
                          className="inp"
                          placeholder={t(
                            "예) 1920x1080px / A4",
                            "e.g. 1920x1080px / A4"
                          )}
                          value={editData.workSize}
                          onChange={(e) =>
                            setEditData({
                              ...editData,
                              workSize: e.target.value,
                            })
                          }
                        />
                      </div>
                    </div>
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 700,
                          fontSize: 13,
                          marginBottom: 7,
                        }}
                      >
                        Publish
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        {PUBLISH_TYPES.map((opt) => (
                          <button
                            key={opt.id}
                            className="btn"
                            onClick={() =>
                              setEditData({
                                ...editData,
                                publishType:
                                  editData.publishType === opt.id ? "" : opt.id,
                              })
                            }
                            style={{
                              flex: 1,
                              padding: "8px 4px",
                              borderRadius: 10,
                              border:
                                editData.publishType === opt.id
                                  ? "2px solid #10b981"
                                  : "2px solid #e5e7eb",
                              background:
                                editData.publishType === opt.id
                                  ? "#ecfdf5"
                                  : "white",
                              textAlign: "center",
                              fontSize: 12,
                              fontWeight: 700,
                              color:
                                editData.publishType === opt.id
                                  ? "#10b981"
                                  : "#374151",
                            }}
                          >
                            {opt.sub}
                            <div
                              style={{
                                fontSize: 10,
                                fontWeight: 400,
                                color: "#9ca3af",
                              }}
                            >
                              {opt.desc}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 700,
                          fontSize: 13,
                          marginBottom: 7,
                        }}
                      >
                        {t("우선순위", "Priority")}
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        {PRIORITIES.map((p) => (
                          <button
                            key={p.id}
                            className="btn"
                            onClick={() =>
                              setEditData({ ...editData, priority: p.id })
                            }
                            style={{
                              flex: 1,
                              padding: "8px 0",
                              borderRadius: 10,
                              fontWeight: 700,
                              fontSize: 13,
                              background:
                                editData.priority === p.id
                                  ? p.color
                                  : "#f3f4f6",
                              color:
                                editData.priority === p.id
                                  ? "white"
                                  : "#6b7280",
                              border:
                                editData.priority === p.id
                                  ? "none"
                                  : "1.5px solid #e5e7eb",
                            }}
                          >
                            {p.label[lang]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 700,
                          fontSize: 13,
                          marginBottom: 7,
                        }}
                      >
                        {t("작업 내용 설명", "Work Description")}
                      </label>
                      <textarea
                        className="inp"
                        rows={4}
                        value={editData.description}
                        onChange={(e) =>
                          setEditData({
                            ...editData,
                            description: e.target.value,
                          })
                        }
                        style={{ resize: "vertical" }}
                      />
                    </div>
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 700,
                          fontSize: 13,
                          marginBottom: 7,
                        }}
                      >
                        {t("레퍼런스", "References")}
                      </label>
                      <textarea
                        className="inp"
                        rows={3}
                        value={editData.reference}
                        onChange={(e) =>
                          setEditData({
                            ...editData,
                            reference: e.target.value,
                          })
                        }
                        style={{ resize: "vertical" }}
                      />
                    </div>
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 700,
                          fontSize: 13,
                          marginBottom: 7,
                        }}
                      >
                        {t("첨부파일", "Attachments")}
                      </label>
                      <label
                        style={{
                          display: "block",
                          border: "2px dashed #d1d5db",
                          borderRadius: 10,
                          padding: 14,
                          textAlign: "center",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="file"
                          multiple
                          style={{ display: "none" }}
                          onChange={(e) =>
                            handleFileUpload(e.target.files, true)
                          }
                        />
                        {uploading ? (
                          <span
                            style={{
                              fontSize: 13,
                              color: "#6366f1",
                              fontWeight: 600,
                            }}
                          >
                            {t("⏳ 업로드 중...", "⏳ Uploading...")}
                          </span>
                        ) : (
                          <span style={{ fontSize: 13, color: "#6b7280" }}>
                            {t("📎 파일 추가하기", "📎 Add files")}
                          </span>
                        )}
                      </label>
                      {editData.attachments?.length > 0 && (
                        <div
                          style={{
                            marginTop: 8,
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          {editData.attachments.map((f, i) => (
                            <div
                              key={i}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                background: "#f9fafb",
                                borderRadius: 8,
                                padding: "8px 12px",
                              }}
                            >
                              <span>📄</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {f.name}
                                </div>
                                <div style={{ fontSize: 11, color: "#9ca3af" }}>
                                  {formatFileSize(f.size)}
                                </div>
                              </div>
                              <button
                                className="btn"
                                onClick={() => removeAttachment(i, true)}
                                style={{ color: "#ef4444", fontSize: 18 }}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
                      <button
                        className="btn"
                        onClick={saveEdit}
                        disabled={saving}
                        style={{
                          flex: 1,
                          padding: 13,
                          background: saving ? "#a5b4fc" : "#6366f1",
                          color: "white",
                          borderRadius: 12,
                          fontWeight: 800,
                          fontSize: 15,
                        }}
                      >
                        {saving
                          ? t("⏳ 저장 중...", "⏳ Saving...")
                          : t("💾 저장하기", "💾 Save")}
                      </button>
                      <button
                        className="btn"
                        onClick={() => setEditMode(false)}
                        style={{
                          padding: "13px 20px",
                          background: "#f3f4f6",
                          color: "#374151",
                          borderRadius: 12,
                          fontWeight: 700,
                        }}
                      >
                        {t("취소", "Cancel")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        {showDeleteConfirm && selectedTicket && (
          <div
            className="overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowDeleteConfirm(false);
            }}
          >
            <div className="small-modal" style={{ textAlign: "center" }}>
              <div style={{ fontSize: 36, marginBottom: 16 }}>🗑️</div>
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 8 }}>
                {t("티켓을 삭제할까요?", "Delete this ticket?")}
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: "#6b7280",
                  marginBottom: 24,
                  lineHeight: 1.6,
                }}
              >
                <strong>{selectedTicket.title}</strong>
                <br />
                {t(
                  "삭제하면 복구할 수 없습니다.",
                  "This action cannot be undone."
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="btn"
                  onClick={() => deleteTicket(selectedTicket.id)}
                  style={{
                    flex: 1,
                    padding: 13,
                    background: "#ef4444",
                    color: "white",
                    borderRadius: 12,
                    fontWeight: 800,
                  }}
                >
                  {t("삭제하기", "Delete")}
                </button>
                <button
                  className="btn"
                  onClick={() => setShowDeleteConfirm(false)}
                  style={{
                    flex: 1,
                    padding: 13,
                    background: "#f3f4f6",
                    color: "#374151",
                    borderRadius: 12,
                    fontWeight: 700,
                  }}
                >
                  {t("취소", "Cancel")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
