import { useEffect, useRef, type KeyboardEvent } from "react";
import { Box, ChevronLeft, Network, PlugZap, Plus, Router, SquareTerminal, Trash2 } from "lucide-react";
import type { ControlInterfaceInput, ControlKind, DeviceResource, DeviceResourceInput, DeviceTemplateId } from "../api";
import {
  CONTROL_GROUPS,
  CONTROL_KINDS,
  CONTROL_KIND_ORDER,
  controlDefaults,
  controlSummary,
  isFieldShown,
  missingControlFields,
  type ControlField,
} from "../../shared/control-interfaces";
import { DEVICE_TEMPLATES, deviceTemplate, deviceTemplateName, type TemplateInterface } from "../../shared/device-templates";
import { AutoResizeTextarea } from "./ui";

export interface DeviceEditorUi {
  step: "pick" | "form";
  /** Set once interfaces are edited, so picking another type no longer swaps them for its defaults. */
  touched: boolean;
  /** The interface card whose fields are open; nothing is open until a card is clicked. */
  selectedId?: string;
  adding: boolean;
  query: string;
  showErrors: boolean;
}

export interface DeviceDialogState {
  kind: "device";
  id?: string;
  form: DeviceResourceInput;
  editor: DeviceEditorUi;
}

function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function interfaceFrom(item: TemplateInterface): ControlInterfaceInput {
  return { id: newId(), name: item.name || "", kind: item.kind, settings: { ...controlDefaults(item.kind), ...item.settings }, secretsSet: [] };
}

const freshUi = (step: DeviceEditorUi["step"], touched: boolean): DeviceEditorUi => ({ step, touched, adding: false, query: "", showErrors: false });

export function newDeviceDialog(): DeviceDialogState {
  return { kind: "device", form: { name: "", template: "custom", description: "", controlInterfaces: [] }, editor: freshUi("pick", false) };
}

export function editDeviceDialog(device: DeviceResource): DeviceDialogState {
  return {
    kind: "device",
    id: device.id,
    form: {
      name: device.name,
      template: device.template,
      description: device.description,
      controlInterfaces: device.controlInterfaces.map((control) => ({
        id: control.id,
        name: control.name,
        kind: control.kind,
        settings: { ...control.settings },
        secretsSet: [...control.secretsSet],
      })),
    },
    editor: freshUi("form", true),
  };
}

/** Problems that stop saving: an empty name, or interfaces with required fields left blank. */
export function deviceFormProblems(form: DeviceResourceInput): { name: boolean; incomplete: string[] } | null {
  const incomplete = form.controlInterfaces.filter((control) => missingControlFields(control, control.secretsSet).length).map((control) => control.id);
  const name = !form.name.trim();
  return name || incomplete.length ? { name, incomplete } : null;
}

/** The request body: secret boxes left empty keep the stored secret on the server. */
export function deviceRequest(form: DeviceResourceInput): DeviceResourceInput {
  return { ...form, name: form.name.trim(), description: form.description.trim(), controlInterfaces: form.controlInterfaces.map((control) => ({ ...control, name: control.name.trim() })) };
}

export function DeviceTypeIcon({ template, size = 16 }: { template: DeviceTemplateId; size?: number }) {
  const strokeWidth = size > 20 ? 1.75 : 2;
  switch (template) {
    case "product":
      // A 1U rack unit seen from the front: chassis, rack ears, a status light and a row of ports.
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="8.5" width="18" height="7" rx="1" />
          <path d="M1.5 9.5v5" />
          <path d="M22.5 9.5v5" />
          <path d="M6.5 12h.01" />
          <path d="M12 12h6" />
        </svg>
      );
    case "switch": return <Network size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case "router": return <Router size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case "linux": return <SquareTerminal size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case "power": return <PlugZap size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    default: return <Box size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
  }
}

export function DeviceEditor({
  productName,
  dialog,
  setDialog,
}: {
  productName: string;
  dialog: DeviceDialogState;
  setDialog: (value: DeviceDialogState) => void;
}) {
  if (dialog.editor.step === "pick") {
    const pick = (template: DeviceTemplateId) => {
      // Interfaces follow the new type until they are edited; the name and description are kept.
      const interfaces = dialog.editor.touched ? dialog.form.controlInterfaces : deviceTemplate(template).interfaces.map(interfaceFrom);
      setDialog({ ...dialog, form: { ...dialog.form, template, controlInterfaces: interfaces }, editor: freshUi("form", dialog.editor.touched) });
    };
    return (
      <div className="device-type-grid">
        {DEVICE_TEMPLATES.map((template, index) => (
          <button
            key={template.id}
            type="button"
            autoFocus={index === 0}
            className={["device-type-tile", template.id === "custom" ? "custom" : "", dialog.id && dialog.form.template === template.id ? "current" : ""].filter(Boolean).join(" ")}
            onClick={() => pick(template.id)}
          >
            <span className="device-type-icon large"><DeviceTypeIcon template={template.id} size={26} /></span>
            <strong>{deviceTemplateName(template.id, productName)}</strong>
          </button>
        ))}
      </div>
    );
  }
  return <DeviceForm productName={productName} dialog={dialog} setDialog={setDialog} />;
}

function DeviceForm({
  productName,
  dialog,
  setDialog,
}: {
  productName: string;
  dialog: DeviceDialogState;
  setDialog: (value: DeviceDialogState) => void;
}) {
  const { form, editor } = dialog;
  const template = deviceTemplate(form.template);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusNewInterface = useRef(false);
  const selected = form.controlInterfaces.find((control) => control.id === editor.selectedId);

  useEffect(() => {
    if (!focusNewInterface.current || !panelRef.current) return;
    focusNewInterface.current = false;
    panelRef.current.scrollIntoView({ block: "nearest" });
    panelRef.current.querySelector<HTMLElement>(".control-fields input, .control-fields select, .control-fields textarea")?.focus({ preventScroll: true });
  }, [editor.selectedId]);

  useEffect(() => {
    if (editor.adding) panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [editor.adding]);

  const setEditor = (patch: Partial<DeviceEditorUi>) => setDialog({ ...dialog, editor: { ...editor, ...patch } });
  const setInterfaces = (controlInterfaces: ControlInterfaceInput[], patch: Partial<DeviceEditorUi> = {}) =>
    setDialog({ ...dialog, form: { ...form, controlInterfaces }, editor: { ...editor, touched: true, ...patch } });
  const updateInterface = (id: string, patch: Partial<ControlInterfaceInput>) =>
    setInterfaces(form.controlInterfaces.map((control) => control.id === id ? { ...control, ...patch } : control));
  const addInterface = (kind: ControlKind) => {
    // A type's preset for this method (e.g. the LuCI path) fills the first interface of that method.
    const preset = template.presets.find((item) => item.kind === kind && !form.controlInterfaces.some((control) => control.kind === kind && control.name === (item.name || "")));
    const control = interfaceFrom(preset || { kind });
    focusNewInterface.current = true;
    setInterfaces([...form.controlInterfaces, control], { selectedId: control.id, adding: false, query: "" });
  };

  const query = editor.query.trim().toLowerCase();
  const matches = (kind: ControlKind) => !query || [CONTROL_KINDS[kind].label, CONTROL_KINDS[kind].group, CONTROL_KINDS[kind].keywords || "", kind].join(" ").toLowerCase().includes(query);
  const sections = [
    { title: "常用", kinds: template.common.filter(matches) },
    ...CONTROL_GROUPS.map((group) => ({
      title: group,
      kinds: CONTROL_KIND_ORDER.filter((kind) => CONTROL_KINDS[kind].group === group && !template.common.includes(kind) && matches(kind)),
    })),
  ].filter((section) => section.kinds.length);

  const closePickerOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // Escape folds the picker instead of closing the whole dialog.
    event.stopPropagation();
    setEditor({ adding: false, query: "" });
  };

  return (
    <div className="device-editor">
      <div className="device-chosen">
        <span className="device-type-icon"><DeviceTypeIcon template={form.template} /></span>
        <strong>{deviceTemplateName(form.template, productName)}</strong>
        <button type="button" className="device-repick" onClick={() => setEditor({ step: "pick" })}>
          <ChevronLeft size={15} />{dialog.id ? "更换类型" : "重新选择"}
        </button>
      </div>

      <label className="field">
        <span>名称 <em className="required-mark">*</em></span>
        <input
          autoFocus={!dialog.id}
          value={form.name}
          maxLength={160}
          className={editor.showErrors && !form.name.trim() ? "invalid" : ""}
          onChange={(event) => setDialog({ ...dialog, form: { ...form, name: event.target.value } })}
        />
      </label>
      <label className="field">
        <span>说明</span>
        <AutoResizeTextarea
          rows={2}
          className="device-description"
          value={form.description}
          maxLength={4_000}
          onChange={(event) => setDialog({ ...dialog, form: { ...form, description: event.target.value } })}
        />
      </label>

      <div className="device-section-title">控制接口</div>
      <div className="control-cards">
        {form.controlInterfaces.map((control) => {
          const missing = missingControlFields(control, control.secretsSet).length > 0;
          const summary = missing ? "" : controlSummary(control);
          const className = [
            "control-card",
            control.id === editor.selectedId && !editor.adding ? "selected" : "",
            editor.showErrors && missing ? "invalid" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={control.id}
              type="button"
              className={className}
              aria-expanded={control.id === editor.selectedId && !editor.adding}
              onClick={() => setEditor({ selectedId: control.id === editor.selectedId && !editor.adding ? undefined : control.id, adding: false })}
            >
              <span className="control-card-top">
                <strong>{CONTROL_KINDS[control.kind].label}</strong>
                {control.name && <span>{control.name}</span>}
              </span>
              <span className={summary ? "control-card-summary" : "control-card-summary empty"}>{summary || "未填写"}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={editor.adding ? "control-card add selected" : "control-card add"}
          title="添加控制接口"
          aria-label="添加控制接口"
          aria-expanded={editor.adding}
          onClick={() => setEditor({ adding: !editor.adding, query: "" })}
        >
          <Plus size={22} />
        </button>
      </div>

      {editor.adding ? (
        <div className="control-panel control-kind-picker" ref={panelRef} onKeyDown={closePickerOnEscape}>
          <input autoFocus value={editor.query} placeholder="搜索" aria-label="搜索控制方式" onChange={(event) => setEditor({ query: event.target.value })} />
          {sections.map((section) => (
            <div className="control-kind-group" key={section.title}>
              <span>{section.title}</span>
              <div>
                {section.kinds.map((kind) => (
                  <button type="button" className="control-kind-chip" key={kind} onClick={() => addInterface(kind)}>{CONTROL_KINDS[kind].label}</button>
                ))}
              </div>
            </div>
          ))}
          {!sections.length && <p className="control-kind-empty">没有匹配的方式</p>}
        </div>
      ) : selected ? (
        <div className="control-panel" ref={panelRef}>
          <div className="control-panel-head">
            <span className="control-kind-tag">{CONTROL_KINDS[selected.kind].label}</span>
            <input value={selected.name} maxLength={120} placeholder="名称" aria-label="接口名称" onChange={(event) => updateInterface(selected.id, { name: event.target.value })} />
            <button
              type="button"
              className="icon-action danger"
              title="删除接口"
              onClick={() => setInterfaces(form.controlInterfaces.filter((control) => control.id !== selected.id), { selectedId: undefined })}
            >
              <Trash2 size={16} />
            </button>
          </div>
          <div className="control-fields">
            {CONTROL_KINDS[selected.kind].fields.filter((field) => isFieldShown(field, selected.settings)).map((field) => (
              <ControlFieldInput
                key={field.key}
                field={field}
                control={selected}
                invalid={editor.showErrors && missingControlFields(selected, selected.secretsSet).some((item) => item.key === field.key)}
                onChange={(value) => updateInterface(selected.id, { settings: { ...selected.settings, [field.key]: value } })}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ControlFieldInput({
  field,
  control,
  invalid,
  onChange,
}: {
  field: ControlField;
  control: ControlInterfaceInput;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const value = control.settings[field.key] ?? "";
  const className = invalid ? "invalid" : undefined;
  let input;
  if (field.input === "select") {
    const options = field.options || [];
    // Keep a stored value the list does not offer, e.g. a migrated 921600 baud rate.
    const all = !value || options.some((option) => option.value === value) ? options : [...options, { value, label: value }];
    input = (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {all.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  } else if (field.input === "textarea") {
    input = <AutoResizeTextarea rows={2} className={className} value={value} maxLength={4_000} onChange={(event) => onChange(event.target.value)} />;
  } else {
    const storedSecret = field.input === "secret" && control.secretsSet.includes(field.key);
    input = (
      <input
        className={className}
        value={value}
        type={field.input === "secret" ? "password" : "text"}
        inputMode={field.input === "number" ? "numeric" : undefined}
        autoComplete={field.input === "secret" ? "new-password" : "off"}
        placeholder={storedSecret ? "未修改" : field.placeholder}
        maxLength={2_048}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <label className={`control-field span-${field.span || 1}`}>
      <span>{field.label}</span>
      {input}
    </label>
  );
}
