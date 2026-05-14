import { useEffect, useState } from "react";
import type { ShellProfile } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { useConfigStore } from "../../../state/configStore";
import { useUiStore } from "../../../state/uiStore";
import { IconClose } from "../../shell/icons";

export function SettingsModal(): JSX.Element | null {
  const open = useUiStore((state) => state.settingsOpen);
  const config = useConfigStore((state) => state.config);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileCommand, setNewProfileCommand] = useState("");
  const [newProfileArgs, setNewProfileArgs] = useState("");
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvValue, setNewEnvValue] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") appActions.closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
    <div className="modal-backdrop" onMouseDown={() => appActions.closeSettings()}>
      <section className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <div className="eyebrow">Local Settings</div>
            <h2>Terminal preferences</h2>
          </div>
          <button type="button" className="icon-button" onClick={() => appActions.closeSettings()} aria-label="Close settings">
            <IconClose width={18} height={18} />
          </button>
        </header>

        <div className="settings-grid">
          <label>
            Font family
            <input value={settings.fontFamily} onChange={(event) => appActions.updateSettings({ fontFamily: event.target.value })} />
          </label>

          <label>
            Font size
            <input
              type="number"
              min={9}
              max={28}
              value={settings.fontSize}
              onChange={(event) => appActions.updateSettings({ fontSize: Number(event.target.value) })}
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
              onChange={(event) => appActions.updateSettings({ lineHeight: Number(event.target.value) })}
            />
          </label>

          <label>
            Cursor style
            <select
              value={settings.cursorStyle}
              onChange={(event) => appActions.updateSettings({ cursorStyle: event.target.value as "block" | "underline" | "bar" })}
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
              onChange={(event) => appActions.updateSettings({ cursorBlink: event.target.checked })}
            />
            Blinking cursor
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.confirmBeforeClosingPane}
              onChange={(event) => appActions.updateSettings({ confirmBeforeClosingPane: event.target.checked })}
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
            <button className="secondary-button" onClick={addEnvVar}>
              Add Variable
            </button>
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
                onDefault={() => appActions.updateSettings({ defaultShellProfileId: profile.id })}
                onRemove={() => appActions.removeShellProfile(profile.id)}
              />
            ))}
          </div>

          <div className="new-shell-grid">
            <input placeholder="Name" value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} />
            <input placeholder="Command" value={newProfileCommand} onChange={(event) => setNewProfileCommand(event.target.value)} />
            <input placeholder="Args, e.g. -l" value={newProfileArgs} onChange={(event) => setNewProfileArgs(event.target.value)} />
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
