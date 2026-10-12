import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Avatar } from "@/components/Avatar";
import { useProfile } from "@/lib/profile-store";
import {
  acceptRequest,
  declineRequest,
  requestId,
  type FriendRequest,
} from "@/lib/friends-repo";
import {
  ChevronLeft,
  Heart,
  MessageCircle,
  Send,
  UserPlus,
  Users,
  AtSign,
  Check,
  CheckCheck,
  Settings2,
  UserMinus,
  Ban,
  X,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  useNotifs,
  useNotifPrefs,
  filterByPrefs,
  dismissNotifs,
  markAllRead,
  markRead,
  unreadCount,
  type Notif,
  type NotifKind,
} from "@/lib/notifications-store";

export const Route = createFileRoute("/app/notifications")({
  head: () => ({ meta: [{ title: "Notifications · ChatZ" }] }),
  component: NotifPage,
});

const ICON: Record<NotifKind, React.ComponentType<{ size?: number }>> = {
  reaction: Heart,
  comment: MessageCircle,
  message: Send,
  friend_request: UserPlus,
  group_invite: Users,
  mention: AtSign,
  unfriend: UserMinus,
  block: Ban,
};
const TINT: Record<NotifKind, string> = {
  reaction: "#FF2D55",
  comment: "#5E72E4",
  message: "#34C759",
  friend_request: "#AF52DE",
  group_invite: "#FF9500",
  mention: "#22C55E",
  unfriend: "#8E8E93",
  block: "#FF3B30",
};

/** Prefer the real timestamp; the "ago" string is only a fallback. */
function isToday(n: Notif): boolean {
  if (n.createdAt) {
    const d = new Date(n.createdAt);
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  }
  return /m$|h$|^now$/.test(n.ago);
}

function NotifPage() {
  const navigate = useNavigate();
  const profile = useProfile();
  const [prefs] = useNotifPrefs();
  const list = filterByPrefs(useNotifs(), prefs);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [backendError, setBackendError] = useState(false);
  useEffect(() => {
    const onBackendStatus = (event: Event) => {
      const state = (event as CustomEvent<{ state?: string }>).detail?.state;
      setBackendError(state === "error");
    };
    window.addEventListener("chatz:backend-status", onBackendStatus);
    return () => window.removeEventListener("chatz:backend-status", onBackendStatus);
  }, []);
  // Notifications already acted on from this screen: id → outcome label.
  const [handled, setHandled] = useState<Map<string, string>>(new Map());
  const unread = unreadCount(list);

  const today = list.filter(isToday);
  const earlier = list.filter((n) => !isToday(n));

  const act = async (n: Notif, kind: "accept" | "decline") => {
    const myUid = profile?.uid;
    if (!myUid || !n.fromUid) return;
    setHandled((m) => new Map(m).set(n.id, kind === "accept" ? "Accepted" : "Declined"));
    const req: FriendRequest = {
      id: requestId(n.fromUid, myUid),
      fromUid: n.fromUid,
      toUid: myUid,
      status: "pending",
      createdAt: "",
      fromName: n.fromName,
      fromHandle: n.fromHandle ?? "",
      fromColor: n.fromColor,
      fromAvatarId: n.fromAvatarId,
    };
    try {
      if (kind === "accept") await acceptRequest(req, myUid);
      else await declineRequest(req);
      // Delete the notification once the action stuck: the live listener then
      // removes the row (and its buttons) from every open surface at once.
      dismissNotifs((x) => x.kind === "friend_request" && x.fromUid === n.fromUid);
    } catch {
      setHandled((m) => {
        const next = new Map(m);
        next.delete(n.id);
        return next;
      });
    }
  };

  return (
    <>
      <header className="sticky top-0 z-20 glass-blur safe-top px-3 pt-2 pb-2 flex items-center gap-2 border-b border-border">
        <button
          onClick={() => navigate({ to: "/app" })}
          className="text-primary p-2 -ml-1 flex items-center"
        >
          <ChevronLeft size={22} />
        </button>
        <h1 className="text-[17px] font-semibold tracking-tight flex-1">
          Notifications{" "}
          {unread > 0 && <span className="ml-1.5 text-[12px] text-primary">({unread})</span>}
        </h1>
        {unread > 0 && (
          <button
            onClick={markAllRead}
            className="text-[13px] text-primary font-medium flex items-center gap-1"
          >
            <CheckCheck size={14} /> Mark all
          </button>
        )}
        <button
          onClick={() => setPrefsOpen(true)}
          className="w-8 h-8 rounded-full bg-secondary grid place-items-center active:scale-95"
          aria-label="Notification settings"
        >
          <Settings2 size={15} />
        </button>
      </header>

      <div className="px-2 pt-3 pb-8">
        {today.length > 0 && (
          <Section
            title="Today"
            items={today}
            onOpen={openItem}
            handled={handled}
            onAccept={(n) => act(n, "accept")}
            onDecline={(n) => act(n, "decline")}
          />
        )}
        {earlier.length > 0 && (
          <Section
            title="Earlier"
            items={earlier}
            onOpen={openItem}
            handled={handled}
            onAccept={(n) => act(n, "accept")}
            onDecline={(n) => act(n, "decline")}
          />
        )}
        {list.length === 0 && (
          <div className="text-center py-16 px-6">
            <div className="text-sm font-medium text-foreground">
              {backendError ? "Notifications are temporarily unavailable" : "You're all caught up ✨"}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {backendError
                ? "Your notifications haven't been cleared. Check your connection and retry in a moment."
                : "New activity will appear here."}
            </p>
            {backendError && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-4 inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-xs font-medium"
              >
                <RefreshCw size={13} /> Retry
              </button>
            )}
          </div>
        )}
      </div>

      {prefsOpen && <PrefsSheet onClose={() => setPrefsOpen(false)} />}
    </>
  );

  function openItem(n: Notif) {
    markRead(n.id);
    if (!n.link) return;
    // Interpolated paths ("/app/stats/<uid>") don't resolve against the typed
    // route map, so dynamic links are matched and passed as params instead.
    const statsMatch = /^\/app\/stats\/([^/]+)$/.exec(n.link);
    if (statsMatch) {
      navigate({ to: "/app/stats/$friendId", params: { friendId: statsMatch[1] } });
      return;
    }
    const chatMatch = /^\/app\/chats\/([^/]+)$/.exec(n.link);
    if (chatMatch) {
      navigate({ to: "/app/chats/$chatId", params: { chatId: chatMatch[1] } });
      return;
    }
    navigate({ to: n.link as "/app" });
  }
}

function PrefsSheet({ onClose }: { onClose: () => void }) {
  const [prefs, update] = useNotifPrefs();
  const rows: { key: "reaction" | "comment"; label: string; desc: string }[] = [
    { key: "reaction", label: "Reactions", desc: "When someone reacts to your screen time" },
    { key: "comment", label: "Comments & replies", desc: "When someone comments on your stats" },
  ];
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-foreground/30"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-background rounded-t-3xl p-6 safe-bottom animate-in slide-in-from-bottom duration-200"
      >
        <div className="w-10 h-1 rounded-full bg-border mx-auto mb-4" />
        <h2 className="text-xl font-semibold tracking-tight mb-1">Notifications</h2>
        <p className="text-[12px] text-muted-foreground mb-3">
          Shown only to you. Turn kinds off to hide them from your feed.
        </p>
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 py-3">
              <div className="flex-1">
                <div className="text-[15px] font-medium">{r.label}</div>
                <div className="text-[12px] text-muted-foreground">{r.desc}</div>
              </div>
              <Switch
                checked={prefs[r.key]}
                onCheckedChange={(v) => update({ [r.key]: v })}
                aria-label={r.label}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Section({
  title,
  items,
  onOpen,
  handled,
  onAccept,
  onDecline,
}: {
  title: string;
  items: Notif[];
  onOpen: (n: Notif) => void;
  handled: Map<string, string>;
  onAccept: (n: Notif) => void;
  onDecline: (n: Notif) => void;
}) {
  return (
    <section className="mb-4">
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
        {title}
      </div>
      <ul>
        {items.map((n) => {
          const Icon = ICON[n.kind];
          const outcome = handled.get(n.id);
          const isRequest = n.kind === "friend_request" && !!n.fromUid;
          return (
            <li key={n.id}>
              <div className={`rounded-2xl ${n.read ? "" : "bg-primary/5"}`}>
                <button
                  onClick={() => onOpen(n)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-left active:bg-secondary transition"
                >
                  <div className="relative">
                    <Avatar
                      name={n.fromName}
                      color={n.fromColor}
                      avatarId={n.fromAvatarId}
                      size="md"
                    />
                    <span
                      className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full grid place-items-center text-white ring-2 ring-background"
                      style={{ background: TINT[n.kind] }}
                    >
                      <Icon size={11} />
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] leading-snug">
                      <span className="font-semibold">{n.fromName}</span>{" "}
                      <span className="text-muted-foreground">{n.text}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{n.ago}</div>
                  </div>
                  {!n.read && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />}
                </button>
                {isRequest && outcome && (
                  <div className="px-3 pb-3 -mt-1 text-[12px] text-muted-foreground">
                    {outcome}
                  </div>
                )}
                {isRequest && !outcome && (
                  <div className="flex gap-2 px-3 pb-3 -mt-1">
                    <button
                      onClick={() => onAccept(n)}
                      className="flex-1 h-9 rounded-full bg-primary text-primary-foreground text-[13px] font-medium active:scale-[0.98] inline-flex items-center justify-center gap-1.5"
                    >
                      <Check size={15} /> Accept
                    </button>
                    <button
                      onClick={() => onDecline(n)}
                      className="flex-1 h-9 rounded-full bg-secondary text-[13px] font-medium active:scale-[0.98] inline-flex items-center justify-center gap-1.5"
                    >
                      <X size={15} /> Decline
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
