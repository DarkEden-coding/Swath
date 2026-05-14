export interface ShellProfile {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AppSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  defaultShellProfileId: string;
  shellProfiles: ShellProfile[];
  globalEnv: Record<string, string>;
  confirmBeforeClosingPane: boolean;
}
