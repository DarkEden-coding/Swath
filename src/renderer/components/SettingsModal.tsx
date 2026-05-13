import { useEffect, useState } from "react";
import type { ShellProfile } from "../../main/sharedTypes";
import { useAppStore } from "../state/appStore";
import { IconClose } from "./icons";

export function SettingsModal(): JSX.Element | null {
  const open = useAppStore((state) => state.settingsOpen);
  const closeSettings = useAppStore((state) => state.closeSettings);
  const config = useAppStore((state) => state.config);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const addShellProfile = useAppStore((state) => state.addShellProfile);
  const removeShellProfile = useAppStore((state) => state.removeShellProfile);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileCommand, setNewProfileCommand] = useState("");
  const [newProfileArgs, setNewProfileArgs] = useState("");
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeSettings]);

  if (!open || !config) return null;

  const { settings } = config;

  const setEnvVar = (key: string, value: string | null): void => {
    const next = { ...(settings.globalEnv ?? {}) };
    if (value === null) delete next[key];
    else next[key] = value;
    updateSettings({ globalEnv: next });
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

    addShellProfile({
      name,
      command,
      args: newProfileArgs.trim() ? splitArgs(newProfileArgs) : []
    });
    setNewProfileName("");
    setNewProfileCommand("");
    setNewProfileArgs("");
  };

  return (
    <div className="modal-backdrop" onMouseDown={closeSettings}>
      <section className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <div className="eyebrow">Local Settings</div>
            <h2>Terminal preferences</h2>
          </div>
          <button type="button" className="icon-button" onClick={closeSettings} aria-label="Close settings">
            <IconClose width={18} height={18} />
          </button>
        </header>

        <div className="settings-grid">
          <label>
            Font family
            <input
              value={settings.fontFamily}
              onChange={(event) => updateSettings({ fontFamily: event.target.value })}
            />
          </label>

          <label>
            Font size
            <input
              type="number"
              min={9}
              max={28}
              value={settings.fontSize}
              onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })}
            />
          </label>

          <label>
            Line height
            <input
              type="number"
              min={1}
              max={2}
              step={0.05}
              value={settings.lineHeight}
              onChange={(event) => updateSettings({ lineHeight: Number(event.target.value) })}
            />
          </label>

          <label>
            Cursor style
            <select
              value={settings.cursorStyle}
              onChange={(event) => updateSettings({ cursorStyle: event.target.value as "block" | "underline" | "bar" })}
            >
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.cursorBlink}
              onChange={(event) => updateSettings({ cursorBlink: event.target.checked })}
            />
            Blinking cursor
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.confirmBeforeClosingPane}
              onChange={(event) => updateSettings({ confirmBeforeClosingPane: event.target.checked })}
            />
            Confirm before closing panes
          </label>
        </div>

        <section className="shell-section">
          <h3>Global environment</h3>
          <p>These key/value pairs are captured into new panes and passed to spawned shells.</p>
          <div className="env-list">
            {Object.entries(settings.globalEnv ?? {}).map(([key, value]) => (
              <div className="env-row" key={key}>
                <strong>{key}</strong>
                <input value={value} onChange={(event) => setEnvVar(key, event.target.value)} />
                <button onClick={() => setEnvVar(key, null)}>Remove</button>
              </div>
            ))}
          </div>
          <div className="new-shell-grid">
            <input placeholder="KEY" value={newEnvKey} onChange={(event) => setNewEnvKey(event.target.value)} />
            <input placeholder="Value" value={newEnvValue} onChange={(event) => setNewEnvValue(event.target.value)} />
            <button className="secondary-button" onClick={addEnvVar}>Add Variable</button>
          </div>
        </section>

        <section className="shell-section">
          <h3>Shell profiles</h3>
          <p>Profiles are spawned from the selected workspace folder.</p>

          <div className="shell-list">
            {settings.shellProfiles.map((profile) => (
              <ShellProfileRow
                key={profile.id}
                profile={profile}
                active={settings.defaultShellProfileId === profile.id}
                canRemove={settings.shellProfiles.length > 1}
                onDefault={() => updateSettings({ defaultShellProfileId: profile.id })}
                onRemove={() => removeShellProfile(profile.id)}
              />
            ))}
          </div>

          <div className="new-shell-grid">
            <input placeholder="Name" value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} />
            <input
              placeholder="Command"
              value={newProfileCommand}
              onChange={(event) => setNewProfileCommand(event.target.value)}
            />
            <input
              placeholder="Args, e.g. -l"
              value={newProfileArgs}
              onChange={(event) => setNewProfileArgs(event.target.value)}
            />
            <button className="secondary-button" onClick={createProfile}>
              Add Shell
            </button>
          </div>
        </section>
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

function ShellProfileRow({ profile, active, canRemove, onDefault, onRemove }: ShellProfileRowProps): JSX.Element {
  return (
    <div className={`shell-row ${active ? "active" : ""}`}>
      <div>
        <strong>{profile.name}</strong>
        <span>
          {profile.command} {profile.args.join(" ")}
        </span>
      </div>
      <button onClick={onDefault}>{active ? "Default" : "Use"}</button>
      {canRemove ? <button onClick={onRemove}>Remove</button> : null}
    </div>
  );
}

function splitArgs(value: string): string[] {
  return value
    .match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((arg) => arg.replace(/^"|"$/g, "")) ?? [];
}
