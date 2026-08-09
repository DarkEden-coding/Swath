import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ShellProfile } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { useConfigStore } from "../../../state/configStore";
import { useUiStore } from "../../../state/uiStore";
import { IconClose } from "../../shell/icons";
import {
  clearErrorLog,
  getErrorLog,
  subscribeToErrorLog,
  type ErrorEntry,
} from "../../../lib/errorLog";

const fieldLabel = "flex flex-col gap-[7px] text-xs font-semibold text-swath-muted";

const fieldInput =
  "w-full rounded-lg border border-swath-border bg-swath-bg px-2.5 py-2 text-swath-text outline-none [-webkit-app-region:no-drag] [app-region:no-drag] focus:border-swath-accent focus:shadow-[0_0_0_2px_rgba(56,139,253,0.15)]";

const secondaryBtn =
  "cursor-pointer rounded-lg border border-swath-border bg-swath-bg px-2.5 py-1.5 text-swath-accent-strong [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-[#161b22]";

const shellRowBtn =
  "cursor-pointer rounded-lg border border-swath-border bg-swath-bg px-2.5 py-1.5 text-sm text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-[#161b22]";

export function SettingsModal(): JSX.Element | null {
  const open = useUiStore((state) => state.settingsOpen);
  const config = useConfigStore((state) => state.config);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileCommand, setNewProfileCommand] = useState("");
  const [newProfileArgs, setNewProfileArgs] = useState("");
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() =>
      dialogRef.current
        ?.querySelector<HTMLElement>("button, input, select, [tabindex]:not([tabindex='-1'])")
        ?.focus(),
    );
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") appActions.closeSettings();
      if (event.key === "Tab" && dialogRef.current) {
        const items = [
          ...dialogRef.current.querySelectorAll<HTMLElement>(
            "button, input, select, [tabindex]:not([tabindex='-1'])",
          ),
        ].filter((item) => !item.hasAttribute("disabled"));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open || !config) return null;

  const { settings } = config;

  const setEnvVar = (key: string, value: string | null): void => {
    const next = { ...(settings.globalEnv ?? {}) };
    if (value === null) delete next[key];
    else next[key] = value;
    appActions.updateSettings({ globalEnv: next });
  };

  const addEnvVar = (): void => {
    const key = newEnvKey.trim();
    if (!key) return;
    setEnvVar(key, newEnvValue);
    setNewEnvKey("");
    setNewEnvValue("");
  };

  const createProfile = (): void => {
    const name = newProfileName.trim();
    const command = newProfileCommand.trim();
    if (!name || !command) return;

    appActions.addShellProfile({
      name,
      command,
      args: newProfileArgs.trim() ? splitArgs(newProfileArgs) : [],
    });
    setNewProfileName("");
    setNewProfileCommand("");
    setNewProfileArgs("");
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(5,7,10,0.64)] p-7 backdrop-blur-md [-webkit-app-region:no-drag] [app-region:no-drag]"
      onMouseDown={() => appActions.closeSettings()}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="max-h-[min(760px,92vh)] w-[min(780px,96vw)] overflow-y-auto rounded-xl border border-swath-border-strong bg-swath-panel p-[18px] shadow-swath-modal [-webkit-app-region:no-drag] [app-region:no-drag]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mb-[18px] flex items-center justify-between gap-3 [-webkit-app-region:drag] [app-region:drag]">
          <div>
            <div className="text-[11px] font-bold uppercase leading-none tracking-[0.12em] text-swath-muted-2">
              Local Settings
            </div>
            <h2 id="settings-title" className="mt-1 text-lg leading-snug">
              Terminal preferences
            </h2>
          </div>
          <button
            type="button"
            className="grid size-8 cursor-pointer place-items-center rounded-lg border border-swath-border bg-swath-bg text-lg text-swath-accent-strong [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-[#161b22]"
            onClick={() => appActions.closeSettings()}
            aria-label="Close settings"
          >
            <IconClose width={18} height={18} className="block" />
          </button>
        </header>

        <div className="grid grid-cols-2 gap-3 max-[980px]:grid-cols-1">
          <label className={fieldLabel}>
            Font family
            <input
              className={fieldInput}
              value={settings.fontFamily}
              onChange={(event) => appActions.updateSettings({ fontFamily: event.target.value })}
            />
          </label>

          <label className={fieldLabel}>
            Font size
            <input
              className={fieldInput}
              type="number"
              min={9}
              max={28}
              value={settings.fontSize}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value))
                  appActions.updateSettings({ fontSize: Math.min(28, Math.max(9, value)) });
              }}
            />
          </label>

          <label className={fieldLabel}>
            Line height
            <input
              className={fieldInput}
              type="number"
              min={1}
              max={2}
              step={0.05}
              value={settings.lineHeight}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value))
                  appActions.updateSettings({ lineHeight: Math.min(2, Math.max(1, value)) });
              }}
            />
          </label>

          <label className={fieldLabel}>
            Cursor style
            <select
              className={fieldInput}
              value={settings.cursorStyle}
              onChange={(event) =>
                appActions.updateSettings({
                  cursorStyle: event.target.value as "block" | "underline" | "bar",
                })
              }
            >
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </label>

          <label className="col-span-2 flex flex-row items-center gap-2 text-xs font-semibold text-swath-muted max-[980px]:col-span-1">
            <input
              type="checkbox"
              className="w-auto [-webkit-app-region:no-drag] [app-region:no-drag]"
              checked={settings.cursorBlink}
              onChange={(event) => appActions.updateSettings({ cursorBlink: event.target.checked })}
            />
            Blinking cursor
          </label>

          <label className="col-span-2 flex flex-row items-center gap-2 text-xs font-semibold text-swath-muted max-[980px]:col-span-1">
            <input
              type="checkbox"
              className="w-auto [-webkit-app-region:no-drag] [app-region:no-drag]"
              checked={settings.confirmBeforeClosingPane}
              onChange={(event) =>
                appActions.updateSettings({ confirmBeforeClosingPane: event.target.checked })
              }
            />
            Confirm before closing panes
          </label>
        </div>

        <section className="mt-6 border-t border-swath-border pt-[18px]">
          <h3 className="mb-1 text-[15px]">Global environment</h3>
          <p className="mb-3 text-xs text-swath-muted-2">
            These key/value pairs are captured into new panes and passed to spawned shells.
          </p>
          <div className="grid gap-2">
            {Object.entries(settings.globalEnv ?? {}).map(([key, value]) => (
              <div
                className="grid grid-cols-[minmax(120px,0.7fr)_minmax(160px,1fr)_auto] items-center gap-2 rounded-2xl border border-swath-border bg-swath-bg p-2.5 max-[980px]:grid-cols-1"
                key={key}
              >
                <strong className="min-w-0 truncate text-[13px]">{key}</strong>
                <input
                  className={fieldInput}
                  value={value}
                  onChange={(event) => setEnvVar(key, event.target.value)}
                />
                <button type="button" className={shellRowBtn} onClick={() => setEnvVar(key, null)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2 max-[980px]:grid-cols-1">
            <input
              className={fieldInput}
              placeholder="KEY"
              value={newEnvKey}
              onChange={(event) => setNewEnvKey(event.target.value)}
            />
            <input
              className={fieldInput}
              placeholder="Value"
              value={newEnvValue}
              onChange={(event) => setNewEnvValue(event.target.value)}
            />
            <button type="button" className={secondaryBtn} onClick={addEnvVar}>
              Add Variable
            </button>
          </div>
        </section>

        <section className="mt-6 border-t border-swath-border pt-[18px]">
          <h3 className="mb-1 text-[15px]">Shell profiles</h3>
          <p className="mb-3 text-xs text-swath-muted-2">
            Profiles are spawned from the selected workspace folder.
          </p>

          <div className="grid gap-2">
            {settings.shellProfiles.map((profile) => (
              <ShellProfileRow
                key={profile.id}
                profile={profile}
                active={settings.defaultShellProfileId === profile.id}
                canRemove={settings.shellProfiles.length > 1}
                onDefault={() => appActions.updateSettings({ defaultShellProfileId: profile.id })}
                onRemove={() => appActions.removeShellProfile(profile.id)}
              />
            ))}
          </div>

          <div className="mt-3 grid grid-cols-[1fr_1.2fr_1fr_auto] gap-2 max-[980px]:grid-cols-1">
            <input
              className={fieldInput}
              placeholder="Name"
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
            />
            <input
              className={fieldInput}
              placeholder="Command"
              value={newProfileCommand}
              onChange={(event) => setNewProfileCommand(event.target.value)}
            />
            <input
              className={fieldInput}
              placeholder="Args, e.g. -l"
              value={newProfileArgs}
              onChange={(event) => setNewProfileArgs(event.target.value)}
            />
            <button type="button" className={secondaryBtn} onClick={createProfile}>
              Add Shell
            </button>
          </div>
        </section>

        <DiagnosticsSection />
      </section>
    </div>
  );
}

interface ShellProfileRowProps {
  profile: ShellProfile;
  active: boolean;
  canRemove: boolean;
  onDefault: () => void;
  onRemove: () => void;
}

function ShellProfileRow({
  profile,
  active,
  canRemove,
  onDefault,
  onRemove,
}: ShellProfileRowProps): JSX.Element {
  const rowRing = active ? "border-swath-accent" : "border-swath-border";

  return (
    <div
      className={`grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-2xl border bg-swath-bg p-2.5 max-[980px]:grid-cols-1 ${rowRing}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <strong className="min-w-0 truncate text-[13px]">{profile.name}</strong>
        <span className="truncate font-mono text-xs text-swath-muted-2">
          {profile.command} {profile.args.join(" ")}
        </span>
      </div>
      <button type="button" className={shellRowBtn} onClick={onDefault}>
        {active ? "Default" : "Use"}
      </button>
      {canRemove ? (
        <button type="button" className={shellRowBtn} onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

function splitArgs(value: string): string[] {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((arg) => arg.replace(/^"|"$/g, "")) ?? [];
}

/**
 * Warnings recorded this session, newest first.
 *
 * Only failures that leave the app unusable interrupt with the crash overlay; everything else is
 * collected here with the interaction that preceded it, so a warning nobody saw is still
 * reportable after the fact.
 */
function DiagnosticsSection(): JSX.Element {
  const entries = useSyncExternalStore(subscribeToErrorLog, getErrorLog);

  return (
    <section className="mt-6 border-t border-swath-border pt-[18px]">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-[15px]">Diagnostics</h3>
        {entries.length > 0 ? (
          <button type="button" className={secondaryBtn} onClick={clearErrorLog}>
            Clear
          </button>
        ) : null}
      </div>
      <p className="mb-3 text-xs text-swath-muted-2">
        Warnings recorded since Swath started. They are not saved between runs.
      </p>

      {entries.length === 0 ? (
        <p className="text-xs text-swath-muted-2">Nothing has gone wrong yet.</p>
      ) : (
        <div className="grid gap-2">
          {entries.map((entry) => (
            <DiagnosticsRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function DiagnosticsRow({ entry }: { entry: ErrorEntry }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-2xl border border-swath-border bg-swath-bg p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <strong className={`text-[13px] ${entry.critical ? "text-swath-danger" : ""}`}>
          {entry.source}
        </strong>
        <span className="shrink-0 font-mono text-xs text-swath-muted-2">
          {new Date(entry.time).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-0.5 break-words font-mono text-xs text-swath-text">{entry.message}</div>
      <div className="mt-0.5 text-xs text-swath-muted-2">
        {entry.context ? `Triggered by: ${entry.context.action}` : "No recent interaction"}
      </div>
      {entry.stack ? (
        <>
          <button
            type="button"
            className="mt-2 text-xs text-swath-accent-strong hover:underline"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Hide details" : "Show details"}
          </button>
          {open ? (
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-swath-muted-2">
              {entry.stack}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
