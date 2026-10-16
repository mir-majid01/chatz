import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { appendMessage, useChatMessages, type Message } from "@/lib/chat-store";
import { markChatRead, sendDm, useDmMessages } from "@/lib/dm-repo";
import { useGroup, addMember, removeMember, updateGroup, type Group } from "@/lib/groups-store";
import { getPublicProfile, type PublicProfile } from "@/lib/profile-repo";
import { listFriends } from "@/lib/friends-repo";
import { fetchBlockState, type BlockState } from "@/lib/blocks-repo";
import { useProfile } from "@/lib/profile-store";
import { Avatar } from "@/components/Avatar";
import {
  ChevronLeft,
  Info,
  Send,
  X,
  Users,
  BellOff,
  Bell,
  LogOut,
  UserPlus,
  Check,
  Trash2,
  Ban,
} from "lucide-react";

export const Route = createFileRoute("/app/chats/$chatId")({
  head: () => ({ meta: [{ title: "Chat · ChatZ" }] }),
  component: ChatDetail,
});

type ChatMeta =
  | { id: string; name: string; color: string; isGroup: true }
  | {
      id: string;
      name: string;
      color: string;
      isGroup: false;
      handle?: string;
      avatarId?: string;
    };

function ChatDetail() {
  const { chatId } = Route.useParams();
  const navigate = useNavigate();
  const profile = useProfile();
  const liveGroup = useGroup(chatId);

  // A chatId is either a local group id or a friend's uid (DM).
  const [friend, setFriend] = useState<PublicProfile | null>(null);
  const [resolving, setResolving] = useState(true);
  const [peerBlock, setPeerBlock] = useState<BlockState>({
    blockedByMe: false,
    blockedByThem: false,
  });

  useEffect(() => {
    let cancelled = false;
    if (liveGroup) {
      setFriend(null);
      setPeerBlock({ blockedByMe: false, blockedByThem: false });
      setResolving(false);
      return;
    }
    setResolving(true);
    setPeerBlock({ blockedByMe: false, blockedByThem: false });
    getPublicProfile(chatId)
      .then((u) => {
        if (!cancelled) setFriend(u);
      })
      .catch(() => {
        if (!cancelled) setFriend(null);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    // A block (either direction) makes this conversation inaccessible; the
    // blocked screen below explains it instead of a bare "not found".
    const myUid = profile?.uid;
    if (myUid) {
      fetchBlockState(myUid, chatId)
        .catch(() => ({ blockedByMe: false, blockedByThem: false }))
        .then((b) => {
          if (!cancelled) setPeerBlock(b);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [chatId, liveGroup, profile?.uid]);

  const groupMessages = useChatMessages(chatId);
  const dmThread = useDmMessages(liveGroup ? null : chatId, profile?.uid ?? null);

  // Bubbles render one shape; DMs come from Firestore and are mapped into the
  // same chat-store Message shape so the transcript stays single-path.
  const messages = useMemo<Message[]>(() => {
    if (liveGroup) return groupMessages;
    const myUid = profile?.uid;
    if (!myUid) return [];
    return dmThread.messages.map((m) => {
      const mine = m.fromUid === myUid;
      const d = new Date(m.createdAt);
      return {
        id: m.id,
        author: mine ? (profile?.name ?? "You") : (friend?.name ?? "Them"),
        color: mine ? profile?.color : friend?.color,
        text: m.text,
        time: `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`,
        mine,
      };
    });
  }, [
    liveGroup,
    groupMessages,
    dmThread,
    profile?.uid,
    profile?.name,
    profile?.color,
    friend?.name,
    friend?.color,
  ]);

  const [text, setText] = useState("");
  const [info, setInfo] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [lastSendAt, setLastSendAt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  // Opening a DM clears its unread dot for this account (per-account marker).
  useEffect(() => {
    const myUid = profile?.uid;
    if (liveGroup || !myUid) return;
    const last = dmThread.messages[dmThread.messages.length - 1];
    if (!last) return;
    markChatRead(myUid, chatId, Math.max(Date.now(), last.createdAt));
  }, [liveGroup, profile?.uid, chatId, dmThread]);

  const chat: ChatMeta | null = liveGroup
    ? {
        id: liveGroup.id,
        name: liveGroup.name,
        color: liveGroup.color,
        isGroup: true,
      }
    : friend
      ? {
          id: friend.uid,
          name: friend.name,
          color: friend.color,
          isGroup: false,
          handle: friend.handle,
          avatarId: friend.avatarId,
        }
      : null;

  if (!liveGroup && (peerBlock.blockedByMe || peerBlock.blockedByThem)) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <header className="sticky top-0 z-20 glass-blur safe-top px-3 pt-2 pb-2 flex items-center gap-2 border-b border-border">
          <button
            onClick={() => navigate({ to: "/app/friends" })}
            className="text-primary p-2 -ml-1 flex items-center"
            aria-label="Back"
          >
            <ChevronLeft size={22} />
          </button>
        </header>
        <div className="flex-1 grid place-items-center p-6">
          <div className="text-center rounded-3xl bg-surface border border-border/60 p-6 max-w-sm">
            <span className="mx-auto w-12 h-12 rounded-full bg-secondary grid place-items-center text-muted-foreground">
              <Ban size={22} />
            </span>
            <h2 className="mt-3 text-[17px] font-semibold">
              {peerBlock.blockedByMe ? "You blocked this person" : "Chat unavailable"}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground leading-relaxed">
              {peerBlock.blockedByMe
                ? "You can't message them while they're blocked. Unblock them from their profile to chat again."
                : "This person blocked you. You can't message them from this account."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!chat) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <header className="sticky top-0 z-20 glass-blur safe-top px-3 pt-2 pb-2 flex items-center gap-2 border-b border-border">
          <button
            onClick={() => navigate({ to: "/app/friends" })}
            className="text-primary p-2 -ml-1 flex items-center"
          >
            <ChevronLeft size={22} />
          </button>
        </header>
        <div className="flex-1 grid place-items-center p-6 text-center text-muted-foreground">
          <div>
            {resolving ? "Loading chat…" : "Chat not found."}
            <div className="mt-2">
              <Link to="/app/friends" className="text-primary">
                Back to friends
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const MIN_SEND_INTERVAL = 2000; // 2s cooldown between messages

  const send = () => {
    const v = text.trim();
    if (!v) return;
    if (!liveGroup) {
      const myUid = profile?.uid;
      const now = Date.now();
      if (!myUid || sending) return;
      // Enforce cooldown: prevent rapid-fire sends even after previous message succeeds
      if (now - lastSendAt < MIN_SEND_INTERVAL) return;
      setSending(true);
      setLastSendAt(now);
      setSendError("");
      setText("");
      sendDm(myUid, chatId, v)
        .catch(() => {
          setSendError("Couldn't send — check your connection.");
          setText((cur) => (cur.trim() ? cur : v));
        })
        .finally(() => setSending(false));
      return;
    }
    // Group chats (local): same cooldown applies
    const now = Date.now();
    if (now - lastSendAt < MIN_SEND_INTERVAL) return;
    setLastSendAt(now);
    const time = (() => {
      const d = new Date(now);
      return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
    })();
    appendMessage(chatId, {
      id: String(Date.now()),
      author: profile?.name || "You",
      color: profile?.color,
      text: v,
      time,
      mine: true,
    });
    setText("");
  };

  const HeaderInner = (
    <div className="flex items-center gap-2.5 flex-1 min-w-0">
      <Avatar
        name={chat.name}
        color={chat.color}
        avatarId={chat.isGroup ? undefined : chat.avatarId}
        size="sm"
        square={chat.isGroup}
      />
      <div className="min-w-0">
        <div className="font-semibold text-[15px] leading-tight truncate flex items-center gap-1.5">
          {chat.name}
          {liveGroup?.muted && <BellOff size={11} className="text-muted-foreground" />}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">
          {chat.isGroup
            ? `${liveGroup?.members.length ?? 0} members`
            : chat.handle
              ? `@${chat.handle}`
              : ""}
        </div>
      </div>
    </div>
  );

  const expiredNotice =
    dmThread.expiredCount === 0
      ? ""
      : `${dmThread.expiredCount} older ${
          dmThread.expiredCount === 1 ? "message has" : "messages have"
        } expired. Chats are kept for 24 hours.`;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="sticky top-0 z-20 glass-blur safe-top px-3 pt-2 pb-2 flex items-center gap-2 border-b border-border">
        <button
          onClick={() => navigate({ to: "/app/friends" })}
          className="text-primary p-2 -ml-1 flex items-center"
        >
          <ChevronLeft size={22} />
        </button>
        {!chat.isGroup ? (
          <Link to="/app/user/$friendId" params={{ friendId: chat.id }} className="flex-1 min-w-0">
            {HeaderInner}
          </Link>
        ) : (
          <button onClick={() => setInfo(true)} className="flex-1 min-w-0">
            {HeaderInner}
          </button>
        )}
        <button
          onClick={() => setInfo(true)}
          className="w-9 h-9 rounded-full bg-secondary grid place-items-center"
          aria-label="Info"
        >
          <Info size={16} />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-1.5">
        {!chat.isGroup && expiredNotice && messages.length > 0 ? (
          <div className="text-center text-[11px] text-muted-foreground pb-1">{expiredNotice}</div>
        ) : null}
        {messages.length === 0 ? (
          <div className="h-full grid place-items-center text-center text-muted-foreground">
            <div>
              {chat.isGroup || dmThread.expiredCount === 0 ? (
                <>
                  <div className="text-[14px] font-medium">No messages yet</div>
                  <div className="text-[12px] mt-1">
                    Say hi to {chat.isGroup ? "the group" : chat.name.split(" ")[0]}.
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[14px] font-medium">Earlier messages have expired</div>
                  <div className="text-[12px] mt-1">
                    Chats are kept for 24 hours, then the messages are deleted — this conversation
                    stays here.
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const showAuthor = chat.isGroup && !m.mine && prev?.author !== m.author;
            return <Bubble key={m.id} m={m} showAuthor={showAuthor} chatColor={chat.color} />;
          })
        )}
      </div>

      <div className="border-t border-border bg-background px-3 pt-2 pb-2">
        {sendError && (
          <div className="pb-1.5 px-1 text-[12px] text-destructive">{sendError}</div>
        )}
        <div className="flex items-end gap-2">
          <div className="flex-1 bg-secondary rounded-3xl px-4 py-2 flex items-center min-h-[40px]">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder={
                chat.isGroup ? "Message group" : `Message ${chat.name.split(" ")[0]}`
              }
              className="flex-1 bg-transparent outline-none text-[15px] text-foreground placeholder:text-muted-foreground caret-primary"
            />
          </div>
          <button
            onClick={send}
            disabled={!text.trim() || sending || (Date.now() - lastSendAt < MIN_SEND_INTERVAL)}
            className="w-9 h-9 rounded-full bg-primary text-primary-foreground grid place-items-center disabled:opacity-40 active:scale-95 transition flex-shrink-0"
            aria-label="Send"
          >
            <Send size={15} />
          </button>
        </div>
      </div>

      {info && chat.isGroup && (
        <GroupInfoSheet
          liveGroup={liveGroup}
          fallbackName={chat.name}
          fallbackColor={chat.color}
          myUid={profile?.uid}
          onClose={() => setInfo(false)}
          onLeave={() => {
            if (liveGroup) updateGroup(liveGroup.id, { left: true });
            setInfo(false);
            navigate({ to: "/app/friends" });
          }}
        />
      )}
      {info && !chat.isGroup && (
        <div
          className="fixed inset-0 z-40 bg-foreground/30 flex items-end"
          onClick={() => setInfo(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md mx-auto bg-background rounded-t-3xl p-6 safe-bottom"
          >
            <div className="w-10 h-1 rounded-full bg-border mx-auto mb-4" />
            <div className="text-center mb-4">
              <Avatar
                name={chat.name}
                color={chat.color}
                avatarId={chat.isGroup ? undefined : chat.avatarId}
                size="2xl"
              />
              <div className="mt-2 text-lg font-semibold">{chat.name}</div>
              {chat.handle && (
                <div className="text-[13px] text-muted-foreground">@{chat.handle}</div>
              )}
            </div>
            <Link
              to="/app/user/$friendId"
              params={{ friendId: chat.id }}
              onClick={() => setInfo(false)}
              className="block w-full h-11 rounded-full bg-primary text-primary-foreground text-[14px] font-medium grid place-items-center"
            >
              View full profile
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function GroupInfoSheet({
  liveGroup,
  fallbackName,
  fallbackColor,
  myUid,
  onClose,
  onLeave,
}: {
  liveGroup?: Group;
  fallbackName: string;
  fallbackColor: string;
  myUid?: string;
  onClose: () => void;
  onLeave: () => void;
}) {
  const members = liveGroup?.members ?? [];
  const name = liveGroup?.name ?? fallbackName;
  const color = liveGroup?.color ?? fallbackColor;
  const muted = !!liveGroup?.muted;

  const [addOpen, setAddOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  // Real friends that aren't in the group yet.
  const [friends, setFriends] = useState<PublicProfile[]>([]);
  useEffect(() => {
    if (!addOpen || !myUid) return;
    let cancelled = false;
    listFriends(myUid)
      .then((list) => {
        if (!cancelled) setFriends(list);
      })
      .catch(() => {
        if (!cancelled) setFriends([]);
      });
    return () => {
      cancelled = true;
    };
  }, [addOpen, myUid]);

  const memberIds = new Set(members.map((m) => m.id));
  const candidates = friends.filter((f) => !memberIds.has(f.uid));

  const toggleMute = () => {
    if (liveGroup) updateGroup(liveGroup.id, { muted: !muted });
  };

  return (
    <div className="fixed inset-0 z-40 bg-foreground/30 flex items-end" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md mx-auto bg-background rounded-t-3xl max-h-[85vh] overflow-y-auto safe-bottom"
      >
        <div className="sticky top-0 bg-background safe-top px-5 pt-2 pb-3 flex items-center justify-between border-b border-border z-10">
          <div className="w-9" />
          <div className="text-[14px] font-semibold">Group info</div>
          <button
            onClick={onClose}
            className="w-8 h-8 grid place-items-center rounded-full bg-secondary"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-5 pt-5 pb-3 text-center">
          <div
            className="inline-flex w-24 h-24 rounded-3xl items-center justify-center text-5xl"
            style={{ background: color }}
          >
            <span>{liveGroup?.emoji ?? "👥"}</span>
          </div>
          <div className="mt-3 text-xl font-semibold">{name}</div>
          <div className="text-[12px] text-muted-foreground flex items-center justify-center gap-1 mt-0.5">
            <Users size={12} /> {members.length} members · Group{muted ? " · muted" : ""}
          </div>
        </div>

        <div className="px-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Members
            </div>
            {liveGroup && (
              <button
                onClick={() => setAddOpen(true)}
                className="text-[12px] text-primary font-semibold flex items-center gap-1"
              >
                <UserPlus size={13} /> Add
              </button>
            )}
          </div>
          {members.length === 0 ? (
            <p className="text-[13px] text-muted-foreground text-center py-6">No members yet.</p>
          ) : (
            <ul className="space-y-1 mb-4">
              {members.map((m) => {
                const removable = liveGroup && m.id !== "me" && m.id !== myUid;
                const content = (
                  <div className="flex items-center gap-3 px-2 py-2 rounded-xl active:bg-secondary">
                    <Avatar name={m.name} color={m.color} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium truncate">{m.name}</div>
                      {m.role && <div className="text-[11px] text-primary">{m.role}</div>}
                    </div>
                    {removable && (
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          removeMember(liveGroup.id, m.id);
                        }}
                        className="p-1.5 rounded-full text-muted-foreground hover:bg-secondary active:scale-95"
                        aria-label={`Remove ${m.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                );
                return (
                  <li key={m.id}>
                    <Link to="/app/user/$friendId" params={{ friendId: m.id }} onClick={onClose}>
                      {content}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="space-y-2 pb-6">
            <button
              onClick={() => setAddOpen(true)}
              disabled={!liveGroup}
              className="w-full h-11 rounded-2xl bg-secondary text-[14px] font-medium flex items-center justify-center gap-2 disabled:opacity-40"
            >
              <UserPlus size={15} /> Add members
            </button>
            <button
              onClick={toggleMute}
              disabled={!liveGroup}
              className="w-full h-11 rounded-2xl bg-secondary text-[14px] font-medium flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {muted ? (
                <>
                  <Bell size={15} /> Unmute notifications
                </>
              ) : (
                <>
                  <BellOff size={15} /> Mute notifications
                </>
              )}
            </button>
            <button
              onClick={() => setConfirmLeave(true)}
              disabled={!liveGroup}
              className="w-full h-11 rounded-2xl bg-destructive/10 text-destructive text-[14px] font-medium flex items-center justify-center gap-2 disabled:opacity-40"
            >
              <LogOut size={15} /> Leave group
            </button>
          </div>
        </div>

        {addOpen && liveGroup && (
          <div
            className="fixed inset-0 z-50 bg-foreground/40 flex items-end"
            onClick={() => setAddOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md mx-auto bg-background rounded-t-3xl p-6 safe-bottom max-h-[80vh] overflow-y-auto"
            >
              <div className="w-10 h-1 rounded-full bg-border mx-auto mb-4" />
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Add to {name}</h3>
                <button
                  onClick={() => setAddOpen(false)}
                  className="w-8 h-8 grid place-items-center rounded-full bg-secondary"
                >
                  <X size={16} />
                </button>
              </div>
              {candidates.length === 0 ? (
                <p className="text-[13px] text-muted-foreground text-center py-8">
                  No friends available to add.
                </p>
              ) : (
                <ul className="space-y-1">
                  {candidates.map((f) => (
                    <li key={f.uid}>
                      <button
                        onClick={() => {
                          addMember(liveGroup.id, {
                            id: f.uid,
                            name: f.name,
                            color: f.color,
                          });
                        }}
                        className="w-full flex items-center gap-3 px-2 py-2 rounded-xl active:bg-secondary"
                      >
                        <Avatar name={f.name} color={f.color} avatarId={f.avatarId} size="sm" />
                        <span className="flex-1 text-left text-[14px] font-medium">{f.name}</span>
                        <span className="w-7 h-7 rounded-full bg-primary text-primary-foreground grid place-items-center">
                          <Check size={14} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                onClick={() => setAddOpen(false)}
                className="mt-4 w-full h-11 rounded-2xl bg-foreground text-background text-[14px] font-medium"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {confirmLeave && (
          <div
            className="fixed inset-0 z-50 bg-foreground/40 grid place-items-center p-6"
            onClick={() => setConfirmLeave(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-background rounded-3xl p-5"
            >
              <h3 className="text-lg font-semibold">Leave {name}?</h3>
              <p className="text-[13px] text-muted-foreground mt-1">
                You'll stop receiving messages from this group. You can be re-added later.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  onClick={() => setConfirmLeave(false)}
                  className="h-11 rounded-2xl bg-secondary text-[14px] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={onLeave}
                  className="h-11 rounded-2xl bg-destructive text-destructive-foreground text-[14px] font-medium"
                >
                  Leave
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({
  m,
  showAuthor,
  chatColor,
}: {
  m: Message;
  showAuthor: boolean;
  chatColor: string;
}) {
  if (m.mine) {
    return (
      <div className="flex justify-end pl-12">
        <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-md px-3.5 py-2 max-w-[78%] text-[15px] leading-snug whitespace-pre-wrap">
          {m.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-end gap-2 pr-12">
      <Avatar name={m.author} color={m.color ?? chatColor} size="xs" />
      <div className="max-w-[78%]">
        {showAuthor && (
          <div className="text-[11px] text-muted-foreground px-3 pb-0.5">{m.author}</div>
        )}
        <div className="bg-secondary text-foreground rounded-2xl rounded-bl-md px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap">
          {m.text}
        </div>
      </div>
    </div>
  );
}
