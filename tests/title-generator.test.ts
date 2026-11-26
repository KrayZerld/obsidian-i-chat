import { describe, expect, it } from "vitest";
import { buildAutoTitlePrompt, sanitizeGeneratedTitle } from "../src/core/title-generator";

describe("auto title generator helpers", () => {
  it("builds a concise prompt containing user and assistant excerpts", () => {
    const prompt = buildAutoTitlePrompt("帮我写一个 VBA 去重脚本", "可以使用 Scripting.Dictionary 实现");
    expect(prompt).toContain("用户：帮我写一个 VBA 去重脚本");
    expect(prompt).toContain("助手：可以使用 Scripting.Dictionary 实现");
  });

  it("sanitizes generated titles by stripping quotes, prefixes, markdown, and extra lines", () => {
    expect(sanitizeGeneratedTitle("标题：《VBA 数据去重脚本》\n\n补充说明")).toBe("VBA 数据去重脚本");
    expect(sanitizeGeneratedTitle('  "Obsidian Plugin Architecture!"  ')).toBe(
      "Obsidian Plugin Architecture"
    );
    expect(sanitizeGeneratedTitle("### **Gemini 联网搜索配置。**")).toBe("Gemini 联网搜索配置");
    expect(sanitizeGeneratedTitle("   \n  ")).toBe("");
    expect(sanitizeGeneratedTitle("这是一个非常非常非常非常非常非常长到超过限制的标题文本内容", 15)).toBe(
      "这是一个非常非常非常非常非常非"
    );
  });
});
