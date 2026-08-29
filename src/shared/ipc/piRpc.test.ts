import { describe, expect, it } from "vitest";
import { agentTabRequestFrom, type PiIncoming } from "./piRpc";

describe("agentTabRequestFrom", () => {
  it("accepts Swath's agent-tab signal and rejects malformed status updates", () => {
    const event: PiIncoming = {
      type: "extension_ui_request",
      id: "tab-1",
      method: "setStatus",
      statusKey: "swath:create-agent-tab",
      statusText: JSON.stringify({
        task: "Review the parser",
        title: "Parser review",
        model: "openai/gpt-5.6",
        reasoningLevel: "high",
      }),
    };

    expect(agentTabRequestFrom(event)).toEqual({
      task: "Review the parser",
      title: "Parser review",
      model: "openai/gpt-5.6",
      reasoningLevel: "high",
    });
    expect(
      agentTabRequestFrom({
        ...event,
        statusText: JSON.stringify({ task: "" }),
      }),
    ).toBeNull();
  });
});
