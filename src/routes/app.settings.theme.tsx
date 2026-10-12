import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useProfile, writeProfile, ACCENT_SWATCH, type Accent, type Theme } from "@/lib/profile-store";
import { ChevronLeft, Moon, Sun, Monitor, Minimize2, Waves } from "lucide-react";

export const Route = createFileRoute("/app/settings/theme")({
  head: () => ({ meta: [{ title: "Appearance · ChatZ" }] }),
  component: ThemePage,
});

function ThemePage() {
  const profile = useProfile();
  const navigate = useNavigate();
  const [reduceMotion, setReduceMotion] = useState(() => {
    try { return localStorage.getItem("chatz.appearance.reduceMotion") === "1"; } catch { return false; }
  });
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem("chatz.appearance.compact") === "1"; } catch { return false; }
  });

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
    try { localStorage.setItem("chatz.appearance.reduceMotion", reduceMotion ? "1" : "0"); } catch {}
  }, [reduceMotion]);
  useEffect(() => {
    document.documentElement.classList.toggle("compact-ui", compact);
    try { localStorage.setItem("chatz.appearance.compact", compact ? "1" : "0"); } catch {}
  }, [compact]);

  if (!profile) return null;

  const setTheme = (t: Theme) => writeProfile({ ...profile, theme: t });
  const setAccent = (a: Accent) => writeProfile({ ...profile, accent: a });

  const themes: { v: Theme; label: string; icon: React.ReactNode }[] = [
    { v: "light", label: "Light", icon: <Sun size={18} /> },
    { v: "dark", label: "Dark", icon: <Moon size={18} /> },
    { v: "system", label: "Auto", icon: <Monitor size={18} /> },
  ];

  return (
    <>
      <header className="sticky top-0 z-20 glass-blur safe-top px-3 pt-2 pb-2 flex items-center gap-2 border-b border-border">
        <button onClick={() => navigate({ to: "/app/profile" })} className="text-primary p-2 -ml-1 flex items-center">
          <ChevronLeft size={22} />
        </button>
        <h1 className="text-[17px] font-semibold tracking-tight">Appearance</h1>
      </header>

      <div className="px-4 pt-5 pb-6 space-y-6">
        <section>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-3 px-1">Theme</div>
          <div className="grid grid-cols-3 gap-3">
            {themes.map((t) => (
              <button
                key={t.v}
                onClick={() => setTheme(t.v)}
                className={`flex flex-col items-center gap-2 py-4 rounded-2xl border transition ${
                  profile.theme === t.v ? "bg-primary/10 border-primary text-primary" : "bg-surface border-border"
                }`}
              >
                <div className="w-10 h-10 rounded-full bg-secondary grid place-items-center">{t.icon}</div>
                <span className="text-[13px] font-medium">{t.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-3 px-1">Accent color</div>
          <div className="grid grid-cols-6 gap-3">
            {(Object.keys(ACCENT_SWATCH) as Accent[]).map((a) => (
              <button
                key={a}
                onClick={() => setAccent(a)}
                className={`aspect-square rounded-full transition-transform ${profile.accent === a ? "ring-2 ring-foreground ring-offset-2 ring-offset-background scale-110" : ""}`}
                style={{ background: ACCENT_SWATCH[a] }}
                aria-label={a}
              />
            ))}
          </div>
        </section>

        <section>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-3 px-1">Interface</div>
          <div className="rounded-2xl bg-surface border border-border divide-y divide-border overflow-hidden">
            <button
              type="button"
              onClick={() => setReduceMotion((v) => !v)}
              aria-pressed={reduceMotion}
              className="w-full flex items-center gap-3 p-4 text-left active:bg-secondary/70 transition-colors"
            >
              <span className="w-10 h-10 rounded-xl bg-secondary grid place-items-center"><Waves size={18} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium">Reduce motion</span>
                <span className="block text-xs text-muted-foreground mt-0.5">Tone down animations and transitions</span>
              </span>
              <span className={`w-11 h-6 rounded-full p-0.5 transition-colors ${reduceMotion ? "bg-primary" : "bg-muted"}`}>
                <span className={`block w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${reduceMotion ? "translate-x-5" : ""}`} />
              </span>
            </button>
            <button
              type="button"
              onClick={() => setCompact((v) => !v)}
              aria-pressed={compact}
              className="w-full flex items-center gap-3 p-4 text-left active:bg-secondary/70 transition-colors"
            >
              <span className="w-10 h-10 rounded-xl bg-secondary grid place-items-center"><Minimize2 size={18} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium">Compact layout</span>
                <span className="block text-xs text-muted-foreground mt-0.5">Fit more settings on screen with less spacing</span>
              </span>
              <span className={`w-11 h-6 rounded-full p-0.5 transition-colors ${compact ? "bg-primary" : "bg-muted"}`}>
                <span className={`block w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${compact ? "translate-x-5" : ""}`} />
              </span>
            </button>
          </div>
        </section>

        <section className="rounded-3xl bg-surface border border-border p-5">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Preview</div>
          <div className="rounded-2xl p-4 bg-gradient-to-br from-primary to-[oklch(0.55_0.2_260)] text-primary-foreground">
            <div className="text-xs opacity-80">Today</div>
            <div className="text-3xl font-semibold tabular-nums">2h 36m</div>
            <div className="mt-3 h-1.5 rounded-full bg-white/20 overflow-hidden">
              <div className="h-full w-2/3 bg-white rounded-full" />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button className="flex-1 h-10 rounded-full bg-primary text-primary-foreground font-medium text-[13px]">Primary action</button>
            <button className="h-10 px-4 rounded-full bg-secondary font-medium text-[13px]">Secondary</button>
          </div>
        </section>
      </div>
    </>
  );
}
