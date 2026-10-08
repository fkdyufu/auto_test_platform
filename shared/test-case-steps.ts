export interface TestCaseStep {
  step: string;
  expected: string;
}

export function parseStepRows(value: unknown): TestCaseStep[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("用例步骤须为 1 至 100 行");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`第 ${index + 1} 行步骤格式不正确`);
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["step", "expected"].includes(key)) || typeof row.step !== "string" || typeof row.expected !== "string") {
      throw new Error(`第 ${index + 1} 行须包含文本格式的步骤和预期`);
    }
    if (row.step.length > 20_000 || row.expected.length > 10_000) throw new Error(`第 ${index + 1} 行内容过长`);
    return { step: row.step, expected: row.expected };
  });
}

function numberedBlocks(text: string): string[] | undefined {
  const blocks: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+)[.)、．]\s*(.*)$/.exec(line);
    if (match) {
      if (Number(match[1]) !== blocks.length + 1) return undefined;
      blocks.push(match[2]);
    } else if (blocks.length) blocks[blocks.length - 1] += `\n${line}`;
    else if (line.trim()) return undefined;
  }
  return blocks.length > 1 ? blocks.map((block) => block.trim()) : undefined;
}

export function stepRowsFromLegacy(steps: string, expectedResult: string): TestCaseStep[] {
  const actions = numberedBlocks(steps);
  const expectations = numberedBlocks(expectedResult);
  // Only split unambiguous matching numbered lists; free text stays intact.
  if (actions && expectations && actions.length === expectations.length && actions.length <= 100) {
    return actions.map((step, index) => ({ step, expected: expectations[index] }));
  }
  return [{ step: steps, expected: expectedResult }];
}

export function stepRowsToText(rows: TestCaseStep[]): { steps: string; expectedResult: string } {
  const format = (field: keyof TestCaseStep) => rows.map((row, index) => rows.length === 1 ? row[field] : `${index + 1}. ${row[field]}`).join("\n");
  return { steps: format("step"), expectedResult: format("expected") };
}

export function formatStepRows(rows: TestCaseStep[]): string {
  return rows.map((row, index) => `步骤 ${index + 1}：\n${row.step}\n对应预期：\n${row.expected || "本步骤未指定单独预期"}`).join("\n\n");
}
