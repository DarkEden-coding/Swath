import type { AppConfig, AppSettings, ShellProfile } from "../../../shared/types";
import { createId } from "../../utils/ids";

export function updateSettings(config: AppConfig, settings: Partial<AppSettings>): AppConfig {
  return { ...config, settings: { ...config.settings, ...settings } };
}

export function addShellProfile(config: AppConfig, profile: Omit<ShellProfile, "id">): AppConfig {
  return {
    ...config,
    settings: { ...config.settings, shellProfiles: [...config.settings.shellProfiles, { ...profile, id: createId("shell") }] }
  };
}

export function removeShellProfile(config: AppConfig, profileId: string): AppConfig {
  if (config.settings.shellProfiles.length <= 1) return config;
  const shellProfiles = config.settings.shellProfiles.filter((profile) => profile.id !== profileId);
  return {
    ...config,
    settings: {
      ...config.settings,
      shellProfiles,
      defaultShellProfileId: config.settings.defaultShellProfileId === profileId ? shellProfiles[0]!.id : config.settings.defaultShellProfileId
    }
  };
}
