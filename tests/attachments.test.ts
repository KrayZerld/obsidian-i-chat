import { describe, expect, it } from "vitest";
import type { TAbstractFile, TFile, TFolder } from "obsidian";
import { collectVaultFiles, parseObsidianOpenUri } from "../src/utils/attachments";

describe("attachments helpers", () => {
  it("parses obsidian://open URI file parameter cleanly", () => {
    expect(
      parseObsidianOpenUri(
        "obsidian://open?vault=Vault&file=90_Meta%2F98_IChatBox%2FConversation%2F20261122183237"
      )
    ).toBe("90_Meta/98_IChatBox/Conversation/20261122183237");

    expect(
      parseObsidianOpenUri(
        "obsidian://open?vault=MyVault&file=%E6%96%87%E6%A1%A3%2F%E6%B5%8B%E8%AF%95.png"
      )
    ).toBe("文档/测试.png");

    expect(parseObsidianOpenUri("hello world")).toBeNull();
    expect(parseObsidianOpenUri("https://example.com")).toBeNull();
  });

  it("recursively collects files from nested vault folders with deduplication and limit", () => {
    const f1 = { path: "Docs/a.md", name: "a.md", extension: "md" } as unknown as TFile;
    const f2 = { path: "Docs/sub/b.png", name: "b.png", extension: "png" } as unknown as TFile;
    const subFolder = { path: "Docs/sub", name: "sub", children: [f2] } as unknown as TFolder;
    const rootFolder = {
      path: "Docs",
      name: "Docs",
      children: [subFolder, f1],
    } as unknown as TFolder;

    const result = collectVaultFiles([rootFolder as TAbstractFile, f1 as TAbstractFile], 10);
    expect(result.truncated).toBe(false);
    expect(result.files.map((f) => f.path)).toEqual(["Docs/a.md", "Docs/sub/b.png"]);

    const capped = collectVaultFiles([rootFolder as TAbstractFile], 1);
    expect(capped.truncated).toBe(true);
    expect(capped.files).toHaveLength(1);
  });
});
