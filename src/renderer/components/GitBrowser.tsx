import React, { useState, useEffect } from "react";
import type { Workspace } from "../../main/sharedTypes";

interface GitBrowserProps {
  workspace: Workspace;
}

export function GitBrowser({ workspace }: GitBrowserProps): JSX.Element {
  const [branch, setBranch] = useState("main");
  const [status, setStatus] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");

  // Minimal stub for now, would typically use git CLI commands to fetch info
  
  return (
    <div className="git-browser" style={{ padding: 20, color: "var(--color-fg)", height: "100%", overflow: "auto" }}>
      <h2>Git Browser</h2>
      <div style={{ marginBottom: 20 }}>
        <strong>Current Branch:</strong> {branch}
      </div>
      
      <div style={{ marginBottom: 20 }}>
        <h3>Uncommitted Changes</h3>
        {status.length === 0 ? (
          <p>No changes</p>
        ) : (
          <ul>
            {status.map((item, idx) => <li key={idx}>{item}</li>)}
          </ul>
        )}
      </div>

      <div style={{ marginBottom: 20, display: "flex", flexDirection: "column", gap: 8, maxWidth: 400 }}>
        <input 
          type="text" 
          value={commitMessage} 
          onChange={(e) => setCommitMessage(e.target.value)} 
          placeholder="Commit message"
          style={{ padding: 8, borderRadius: 4, border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-fg)" }}
        />
        <button 
          className="primary-button" 
          disabled={!commitMessage || status.length === 0}
          style={{ padding: 8, alignSelf: "flex-start" }}
        >
          Commit
        </button>
      </div>
    </div>
  );
}
