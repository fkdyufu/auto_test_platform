import { useEffect, useLayoutEffect, useRef, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { AlertCircle, Check, X } from "lucide-react";

export type Notice = { kind: "success" | "error"; message: string } | null;

export function AutoResizeTextarea({ value, ...props }: Omit<ComponentProps<"textarea">, "value"> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);

  return <textarea {...props} value={value} ref={ref} />;
}

export function PageHeader({
  icon,
  title,
  status,
  actions,
}: {
  icon: ReactNode;
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-title">
        <span className="page-icon">{icon}</span>
        <h1>{title}</h1>
      </div>
      {actions || status}
    </header>
  );
}

export function InlineNotice({ notice, onClose }: { notice: Exclude<Notice, null>; onClose: () => void }) {
  return (
    <div className={`inline-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.kind === "success" ? <Check size={17} /> : <AlertCircle size={17} />}
      <span>{notice.message}</span>
      <button type="button" onClick={onClose} title="关闭提示">
        <X size={16} />
      </button>
    </div>
  );
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  onSubmit,
  submitting,
  submitLabel = "保存",
  submitDisabled = false,
  hideSubmit = false,
  footerStart,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  submitting: boolean;
  submitLabel?: string;
  submitDisabled?: boolean;
  hideSubmit?: boolean;
  /** Extra buttons on the left of the footer, e.g. a back button. */
  footerStart?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className={`modal ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title} onSubmit={onSubmit}>
        <header className="modal-header">
          <h2>{title}{subtitle && <span className="modal-subtitle">{subtitle}</span>}</h2>
          <button type="button" className="icon-button static" onClick={onClose} disabled={submitting} title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-actions">
          {footerStart && <div className="modal-actions-start">{footerStart}</div>}
          <button type="button" className="button secondary" onClick={onClose} disabled={submitting}>
            取消
          </button>
          {!hideSubmit && (
            <button type="submit" className="button primary" disabled={submitting || submitDisabled}>
              {submitting ? "保存中..." : submitLabel}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}
