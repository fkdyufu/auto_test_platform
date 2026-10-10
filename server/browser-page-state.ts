export interface BrowserElementSnapshot {
  ref: string;
  tag: string;
  text: string;
  label?: string;
  role?: string;
  ariaLabel?: string;
  title?: string;
  placeholder?: string;
  type?: string;
  name?: string;
  value?: string;
  draggable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  inViewport: boolean;
  controlType?: "custom-select" | "native-select" | "option";
  options?: { text: string; value: string; selected: boolean }[];
}

export interface BrowserTargetState {
  available: boolean;
  reason?: string;
  label: string;
  tag: string;
  controlType?: BrowserElementSnapshot["controlType"];
}

export interface BrowserPageState {
  title: string;
  url: string;
  text: string;
  activeDialog?: { title: string };
  validationErrors: { label: string; message: string }[];
  elements: BrowserElementSnapshot[];
  targetStates?: BrowserTargetState[];
}

// This function runs inside the browser via page.evaluate. Keep its helpers
// self-contained so reading and target validation use the same visibility rules.
export function readBrowserPageState(input: { firstRef?: number; targets?: Node[] }): BrowserPageState {
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const helpers = {
    style(element: Element): CSSStyleDeclaration {
      let style = styles.get(element);
      if (!style) {
        style = window.getComputedStyle(element);
        styles.set(element, style);
      }
      return style;
    },
    intersectsViewport(rect: DOMRect): boolean {
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
        && rect.left < viewport.width && rect.top < viewport.height;
    },
    hiddenReason(element: Element): string | undefined {
      if (!element.isConnected) return "元素已从页面移除";
      // LuCI keeps closed dialogs in the DOM and moves their overlay offscreen.
      const overlay = element.closest("#modal_overlay");
      if (overlay && !document.body.classList.contains("modal-overlay-active")) {
        const style = this.style(overlay);
        if (Number(style.opacity) === 0 || (style.position === "fixed" && !this.intersectsViewport(overlay.getBoundingClientRect()))) {
          return "目标位于已关闭的弹窗中，请重新打开编辑弹窗";
        }
      }
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = this.style(node);
        if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true"
          || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
          || Number(style.opacity) === 0) return "目标或其所在容器已隐藏";
        if (style.position === "fixed" && !this.intersectsViewport(node.getBoundingClientRect())) {
          return "目标所在的固定容器已移出视口，无法通过页面滚动访问";
        }
      }
      return undefined;
    },
    hasBox(element: Element): boolean {
      return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
    },
    inViewport(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      let left = Math.max(0, rect.left);
      let top = Math.max(0, rect.top);
      let right = Math.min(viewport.width, rect.right);
      let bottom = Math.min(viewport.height, rect.bottom);
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = this.style(node);
        const bounds = node.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
      }
      return right > left && bottom > top;
    },
    label(element: Element): string {
      const labelledBy = element.getAttribute("aria-labelledby")?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      const labels = Array.from((element as HTMLInputElement).labels || [])
        .map((label) => label.textContent || "").join(" ").trim();
      const field = element.closest(".cbi-value, .form-group, .form-field, [data-field]");
      const fieldLabel = field?.querySelector(".cbi-value-title, label")?.textContent?.trim();
      return (element.getAttribute("aria-label") || labelledBy || labels || fieldLabel || "")
        .replace(/\s+/g, " ").slice(0, 180);
    },
    controlType(element: Element): BrowserElementSnapshot["controlType"] {
      if (element.tagName === "SELECT") return "native-select";
      if (element.matches(".cbi-dropdown, [role='combobox'], [role='listbox']")) return "custom-select";
      if (element.matches("[role='option'], .cbi-dropdown li[data-value]")) return "option";
      return undefined;
    },
    dialogTitle(element: Element): string {
      return (this.label(element) || element.querySelector("h1, h2, h3, h4, [data-dialog-title]")?.textContent || "弹窗")
        .replace(/\s+/g, " ").trim().slice(0, 180);
    },
    stackingOrder(element: Element): number {
      let zIndex = 0;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const value = Number.parseInt(this.style(node).zIndex, 10);
        if (Number.isFinite(value)) zIndex = Math.max(zIndex, value);
      }
      return element.matches("dialog:modal") ? Number.MAX_SAFE_INTEGER : zIndex;
    },
  };

  const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true'], dialog[open], #modal_overlay .modal"))
    .filter((element) => element.getAttribute("aria-modal") !== "false" && !helpers.hiddenReason(element)
      && helpers.intersectsViewport(element.getBoundingClientRect()));
  // Prefer the innermost dialog on ties (including nested confirmations).
  const activeDialog = dialogs.sort((a, b) => helpers.stackingOrder(a) - helpers.stackingOrder(b)).at(-1);
  const scopes: Element[] = activeDialog ? [activeDialog] : [document.body];
  if (activeDialog) {
    // Some custom dropdowns render their options in a portal outside the dialog.
    for (const owner of Array.from(activeDialog.querySelectorAll("[aria-controls], [aria-owns]"))) {
      const ids = `${owner.getAttribute("aria-controls") || ""} ${owner.getAttribute("aria-owns") || ""}`.trim().split(/\s+/);
      for (const id of ids) {
        const popup = document.getElementById(id);
        if (popup?.matches("[role='listbox'], [role='menu']") && !helpers.hiddenReason(popup) && !scopes.includes(popup)) scopes.push(popup);
      }
    }
  }
  const activeDialogState = activeDialog ? { title: helpers.dialogTitle(activeDialog) } : undefined;
  const state = {
    target(element: Element): BrowserTargetState {
      let reason = helpers.hiddenReason(element);
      if (!reason && !helpers.hasBox(element)) reason = "目标当前没有可操作的显示区域";
      if (!reason && !scopes.some((scope) => scope.contains(element))) reason = "目标被当前弹窗遮挡，请先在弹窗内操作或关闭弹窗";
      if (!reason && ((element as HTMLInputElement).disabled || element.matches(":disabled") || element.closest("[aria-disabled='true']"))) {
        reason = "目标当前已禁用";
      }
      return {
        available: !reason,
        reason,
        tag: element.tagName.toLowerCase(),
        label: helpers.label(element) || (element as HTMLElement).innerText?.trim().slice(0, 180) || element.getAttribute("title") || "",
        controlType: helpers.controlType(element),
      };
    },
    text(root: Element): string {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node instanceof Element) {
            if (node.matches("script, style, template, noscript") || helpers.hiddenReason(node)) return NodeFilter.FILTER_REJECT;
            return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const parts: string[] = [];
      let length = 0;
      let previousBlock: Element | undefined;
      for (let node = walker.nextNode(); node && length < 6000; node = walker.nextNode()) {
        if (node instanceof Element) {
          parts.push(" ");
          continue;
        }
        let block = node.parentElement || root;
        while (block !== root && block.parentElement && /^(inline|contents)/.test(helpers.style(block).display)) block = block.parentElement;
        if (previousBlock && previousBlock !== block) parts.push(" ");
        previousBlock = block;
        // Keep adjacent inline fragments together (e.g. an icon + link text),
        // but separate rendered blocks and normalize source whitespace.
        const value = node.textContent?.replace(/\s+/g, " ");
        if (value) {
          parts.push(value);
          length += value.length + 1;
        }
      }
      return parts.join("").replace(/\s+/g, " ").trim().slice(0, 6000);
    },
  };

  if (input.targets) {
    return {
      title: document.title, url: window.location.href, text: "", elements: [], validationErrors: [],
      activeDialog: activeDialogState, targetStates: input.targets.map((element) => element instanceof Element
        ? state.target(element)
        : { available: false, reason: "目标不是页面元素", tag: "", label: "" }),
    };
  }

  document.querySelectorAll("[data-pi-agent-ref]").forEach((element) => element.removeAttribute("data-pi-agent-ref"));
  document.querySelectorAll("[data-pi-agent-target]").forEach((element) => element.removeAttribute("data-pi-agent-target"));
  const selector = [
    "a", "button", "input", "textarea", "select", "[draggable='true']", ".drag-handle", "[aria-grabbed]",
    "[role='button']", "[role='link']", "[role='textbox']", "[contenteditable='true']",
    "[role='combobox']", "[role='listbox']", "[role='option']", ".cbi-dropdown", ".cbi-dropdown li[data-value]",
  ].join(",");
  const candidates = Array.from(new Set(scopes.flatMap((scope) => Array.from(scope.querySelectorAll<HTMLElement>(selector)))))
    .filter((element) => !helpers.hiddenReason(element) && helpers.hasBox(element));
  const elements = candidates.slice(0, 120).map((element, index): BrowserElementSnapshot => {
    const ref = `e${(input.firstRef || 1) + index}`;
    element.setAttribute("data-pi-agent-ref", ref);
    const field = element as HTMLInputElement;
    const controlType = helpers.controlType(element);
    const value = field.type === "password" ? undefined : field.value;
    const options = controlType === "native-select"
      ? Array.from((element as unknown as HTMLSelectElement).options).map((option) => ({ text: option.text, value: option.value, selected: option.selected }))
      : controlType === "custom-select"
        ? Array.from(element.querySelectorAll<HTMLElement>("[role='option'], li[data-value]"))
          .filter((option) => !helpers.hiddenReason(option) && helpers.hasBox(option))
          .map((option) => ({ text: option.innerText.trim(), value: option.getAttribute("data-value") || "", selected: option.getAttribute("aria-selected") === "true" || option.hasAttribute("selected") }))
        : undefined;
    return {
      ref: `@${ref}`, tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.getAttribute("aria-label") || element.title || value || "").trim().slice(0, 180),
      label: helpers.label(element) || undefined,
      role: element.getAttribute("role") || undefined,
      ariaLabel: element.getAttribute("aria-label") || undefined,
      title: element.title || undefined, placeholder: field.placeholder || undefined,
      type: field.type || undefined, name: field.name || undefined, value,
      draggable: element.draggable || undefined, disabled: field.disabled || element.matches(":disabled") || Boolean(element.closest("[aria-disabled='true']")) || undefined,
      readOnly: field.readOnly || undefined, inViewport: helpers.inViewport(element), controlType, options,
    };
  });

  const validationErrors: BrowserPageState["validationErrors"] = [];
  for (const element of candidates) {
    const field = element as HTMLInputElement;
    const customInvalid = element.matches(".cbi-input-invalid, [aria-invalid='true']");
    const nativeInvalid = field.willValidate && !field.validity.valid && (Boolean(field.value) || element.matches(":user-invalid"));
    if (!customInvalid && !nativeInvalid) continue;
    const describedBy = element.getAttribute("aria-describedby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
    validationErrors.push({
      label: helpers.label(element) || field.name || "输入字段",
      message: (describedBy || element.getAttribute("data-tooltip") || element.getAttribute("title") || field.validationMessage || "字段值未通过页面校验").slice(0, 500),
    });
  }
  for (const scope of scopes) {
    for (const error of Array.from(scope.querySelectorAll(".cbi-value-error, .validation-error, [role='alert']"))) {
      if (helpers.hiddenReason(error) || !helpers.hasBox(error)) continue;
      const message = state.text(error).slice(0, 500);
      if (message && !validationErrors.some((item) => item.message === message)) validationErrors.push({ label: helpers.label(error) || "页面提示", message });
    }
  }
  return {
    title: document.title, url: window.location.href,
    text: scopes.map((scope) => state.text(scope)).join(" ").slice(0, 6000),
    activeDialog: activeDialogState, validationErrors: validationErrors.slice(0, 20), elements,
  };
}
