import { describe, expect, it } from "vitest";
import { bbKeys } from "./keys.js";

describe("bbKeys", () => {
  it("roots every key at ['bb', orgId] so tenants never collide", () => {
    expect(bbKeys("orgA").agents.list).toEqual(["bb", "orgA", "agents", "list"]);
    expect(bbKeys("orgB").agents.list).toEqual(["bb", "orgB", "agents", "list"]);
    expect(bbKeys("orgA").agents.list).not.toEqual(bbKeys("orgB").agents.list);
  });

  it("builds bot list and detail keys", () => {
    expect(bbKeys("o").bots.list).toEqual(["bb", "o", "bots", "list"]);
    expect(bbKeys("o").bots.detail("b1")).toEqual(["bb", "o", "bots", "detail", "b1"]);
  });

  it("scopes a paginated message list by convo + keyword filter", () => {
    expect(bbKeys("o").messages.list("c1")).toEqual(["bb", "o", "messages", "c1", { keyword: "" }]);
    expect(bbKeys("o").messages.list("c1", { keyword: "hi" })).toEqual([
      "bb",
      "o",
      "messages",
      "c1",
      { keyword: "hi" },
    ]);
  });

  it("messages.forConvo is a prefix of every message list key (invalidation semantics)", () => {
    const prefix = bbKeys("o").messages.forConvo("c1");
    const list = bbKeys("o").messages.list("c1", { keyword: "x" });
    expect(prefix).toEqual(["bb", "o", "messages", "c1"]);
    expect(list.slice(0, prefix.length)).toEqual([...prefix]);
  });

  it("nests conversation sub-resources under the conversation detail key", () => {
    expect(bbKeys("o").conversations.detail("c1")).toEqual([
      "bb",
      "o",
      "conversations",
      "detail",
      "c1",
    ]);
    expect(bbKeys("o").conversations.attachments("c1")).toEqual([
      "bb",
      "o",
      "conversations",
      "detail",
      "c1",
      "attachments",
    ]);
  });
});
