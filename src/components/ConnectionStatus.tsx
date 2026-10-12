import { useEffect, useState } from "react";
import { CloudOff, RefreshCw, ServerCrash } from "lucide-react";

/**
 * Small, non-blocking status banner. Browser online/offline events describe
 * device connectivity; backend status is only shown when a live data listener
 * reports a real error, and clears after a successful snapshot.
 */
export function ConnectionStatus() {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [backendDown, setBackendDown] = useState(false);

  useEffect(() => {
    const offline = () => setOnline(false);
    const onlineAgain = () => setOnline(true);
    const backendStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: string }>).detail;
      setBackendDown(detail?.state === "error");
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", onlineAgain);
    window.addEventListener("chatz:backend-status", backendStatus);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", onlineAgain);
      window.removeEventListener("chatz:backend-status", backendStatus);
    };
  }, []);

  if (online && !backendDown) return null;
  const offline = !online;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 inset-x-0 z-[80] safe-top px-4 py-2.5 flex items-center gap-2 border-b border-border bg-background/95 backdrop-blur"
    >
      {offline ? <CloudOff size={17} className="shrink-0 text-warning" /> : <ServerCrash size={17} className="shrink-0 text-destructive" />}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold">{offline ? "You're offline" : "ChatZ is having trouble connecting"}</div>
        <div className="text-[11px] text-muted-foreground">
          {offline ? "Cached information may still be available. Some actions will wait for a connection." : "Your last loaded content is preserved. Try again when the service recovers."}
        </div>
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium"
      >
        <RefreshCw size={12} /> Retry
      </button>
    </div>
  );
}
