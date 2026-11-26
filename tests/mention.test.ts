import { describe, expect, it } from "vitest";
import { findActiveMentionToken, resolveNoteDisplayTitle } from "../src/utils/mention";

describe("mention token & frontmatter title helpers", () => {
  it("triggers @ mention at start of input or after whitespace", () => {
    expect(findActiveMentionToken("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(findActiveMentionToken("@项目计划", 5)).toEqual({
      start: 0,
      end: 5,
      query: "项目计划",
    });
    expect(findActiveMentionToken("请参考 @notes/v2", 13)).toEqual({
      start: 4,
      end: 13,
      query: "notes/v2",
    });
    expect(findActiveMentionToken("第一行\n@会议纪要", 9)).toEqual({
      start: 4,
      end: 9,
      query: "会议纪要",
    });
  });

  it("ignores email addresses and closes after whitespace", () => {
    expect(findActiveMentionToken("联系 test@example.com", 19)).toBeNull();
    expect(findActiveMentionToken("@项目计划 帮我总结", 10)).toBeNull();
    expect(findActiveMentionToken("普通文本", 4)).toBeNull();
  });

  it("resolves frontmatter title field with fallback to basename", () => {
    expect(resolveNoteDisplayTitle({ title: "季度复盘报告" }, "20261123")).toBe("季度复盘报告");
    expect(resolveNoteDisplayTitle({ title: "  自定义标题  " }, "fallback")).toBe("自定义标题");
    expect(resolveNoteDisplayTitle({ title: "   " }, "fallback")).toBe("fallback");
    expect(resolveNoteDisplayTitle(undefined, "20261123")).toBe("20261123");
  });
});
