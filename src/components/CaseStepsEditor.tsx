import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { TestCaseStep } from "../../shared/test-case-steps";
import { AutoResizeTextarea } from "./ui";

export function CaseStepsEditor({ rows, onChange, disabled = false }: {
  rows: TestCaseStep[];
  onChange: (rows: TestCaseStep[]) => void;
  disabled?: boolean;
}) {
  const move = (index: number, offset: number) => {
    const next = [...rows];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    onChange(next);
  };

  return (
    <section className="case-steps-editor full-width" aria-label="用例步骤">
      <div className="case-steps-heading">
        <span>用例步骤</span>
        <button type="button" className="button secondary compact" disabled={disabled || rows.length >= 100} onClick={() => onChange([...rows, { step: "", expected: "" }])}>
          <Plus size={14} />添加步骤
        </button>
      </div>
      <table className="case-steps-table">
        <thead><tr><th aria-label="序号">#</th><th>步骤</th><th>预期</th><th aria-label="操作" /></tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={index}>
            <td className="case-step-number">{index + 1}</td>
            <td><AutoResizeTextarea aria-label={`步骤 ${index + 1}`} value={row.step} rows={3} disabled={disabled} onChange={(event) => onChange(rows.map((item, rowIndex) => rowIndex === index ? { ...item, step: event.target.value } : item))} /></td>
            <td><AutoResizeTextarea aria-label={`预期 ${index + 1}`} value={row.expected} rows={3} disabled={disabled} onChange={(event) => onChange(rows.map((item, rowIndex) => rowIndex === index ? { ...item, expected: event.target.value } : item))} /></td>
            <td><div className="case-step-actions">
              <button type="button" className="icon-action" title="上移步骤" aria-label={`上移步骤 ${index + 1}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
              <button type="button" className="icon-action" title="下移步骤" aria-label={`下移步骤 ${index + 1}`} disabled={disabled || index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
              <button type="button" className="icon-action danger" title="删除步骤" aria-label={`删除步骤 ${index + 1}`} disabled={disabled || rows.length === 1} onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={14} /></button>
            </div></td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}
