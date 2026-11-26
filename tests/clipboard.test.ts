import { describe, expect, it } from "vitest";
import {
  convertTsvToMarkdownTable,
  formatMarkdownTable,
  resolvePasteAction,
} from "../src/utils/clipboard";

describe("clipboard paste resolution", () => {
  it("converts Excel HTML table with accompanying image.png into a Markdown table instead of attachment", () => {
    const excelHtml = [
      '<html xmlns:o="urn:schemas-microsoft-com:office:office">',
      "<head><style><!-- table { color: black; } --></style></head>",
      "<body>",
      "<table>",
      "<!--StartFragment-->",
      " <tr height=19>",
      "  <td class=xl65>部门</td>",
      "  <td>负责人</td>",
      "  <td>备注</td>",
      " </tr>",
      " <tr height=19>",
      "  <td>供应链|运营</td>",
      "  <td>张三<br>\r\n    副主管</td>",
      "  <td>A &amp; B</td>",
      " </tr>",
      "<!--EndFragment-->",
      "</table>",
      "</body>",
      "</html>",
    ].join("\n");

    const action = resolvePasteAction({
      files: [{ name: "image.png", type: "image/png" }],
      plainText: "部门\t负责人\t备注\r\n供应链|运营\t\"张三\n副主管\"\tA & B\r\n",
      html: excelHtml,
    });

    expect(action).toEqual({
      kind: "insert-text",
      text: [
        "| 部门 | 负责人 | 备注 |",
        "| --- | --- | --- |",
        "| 供应链\\|运营 | 张三<br>副主管 | A & B |",
      ].join("\n"),
    });
  });

  it("handles colspan and rowspan in Excel HTML tables", () => {
    const html = `
      <html><body>
      <table>
        <tr><th colspan="2">汇总</th><th>状态</th></tr>
        <tr><td rowspan="2">华东</td><td>上海</td><td>正常</td></tr>
        <tr><td>杭州</td><td>待定</td></tr>
      </table>
      </body></html>
    `;

    const action = resolvePasteAction({
      files: [{ name: "image.png", type: "image/png" }],
      plainText: "汇总\t\t状态\n华东\t上海\t正常\n\t杭州\t待定",
      html,
    });

    expect(action).toEqual({
      kind: "insert-text",
      text: [
        "| 汇总 |  | 状态 |",
        "| --- | --- | --- |",
        "| 华东 | 上海 | 正常 |",
        "|  | 杭州 | 待定 |",
      ].join("\n"),
    });
  });

  it("pastes a single Excel cell as plain text instead of image attachment or 1x1 table", () => {
    const action = resolvePasteAction({
      files: [{ name: "image.png", type: "image/png" }],
      plainText: "2026-11-23\r\n",
      html: "<html><body><table><tr><td>2026-11-23</td></tr></table></body></html>",
    });

    expect(action).toEqual({
      kind: "insert-text",
      text: "2026-11-23",
    });
  });

  it("keeps mixed HTML content containing text + table as plain text rather than dropping surrounding text", () => {
    const html = "<html><body><p>请看下表：</p><table><tr><td>A</td><td>B</td></tr></table></body></html>";
    const action = resolvePasteAction({
      files: [{ name: "image.png", type: "image/png" }],
      plainText: "请看下表：\nA\tB",
      html,
    });

    expect(action).toEqual({
      kind: "insert-text",
      text: "请看下表：\nA\tB",
    });
  });

  it("falls back to TSV Markdown table when image preview + TSV plain text has no HTML", () => {
    const action = resolvePasteAction({
      files: [{ name: "image.png", type: "image/png" }],
      plainText: "Name\tScore\r\nAlice\t95\r\nBob\t88\r\n",
      html: "",
    });

    expect(action).toEqual({
      kind: "insert-text",
      text: ["| Name | Score |", "| --- | --- |", "| Alice | 95 |", "| Bob | 88 |"].join("\n"),
    });
  });

  it("keeps screenshot paste and browser copy-image as attachments", () => {
    const screenshot = { name: "image.png", type: "image/png" };
    expect(
      resolvePasteAction({
        files: [screenshot],
        plainText: "",
        html: "",
      })
    ).toEqual({ kind: "attachments", files: [screenshot] });

    expect(
      resolvePasteAction({
        files: [screenshot],
        plainText: "",
        html: '<img src="https://example.com/a.png">',
      })
    ).toEqual({ kind: "attachments", files: [screenshot] });
  });

  it("always keeps non-image files (e.g. PDF/MD copied from OS explorer) as attachments", () => {
    const pdf = { name: "report.pdf", type: "application/pdf" };
    expect(
      resolvePasteAction({
        files: [pdf],
        plainText: "report.pdf",
        html: "",
      })
    ).toEqual({ kind: "attachments", files: [pdf] });
  });

  it("returns default for normal plain text paste without files or table HTML", () => {
    expect(
      resolvePasteAction({
        files: [],
        plainText: "Hello Captain",
        html: "",
      })
    ).toEqual({ kind: "default" });
  });

  it("does not misclassify ragged tab-indented code as a TSV table", () => {
    expect(convertTsvToMarkdownTable("\tif (x) {\n\t\treturn 1;\n\t}")).toBeNull();
    expect(formatMarkdownTable([["only-one-cell"]])).toBeNull();
  });
});
