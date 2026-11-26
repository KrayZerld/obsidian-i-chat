import { setIcon } from "obsidian";

export interface IconButtonOptions {
  icon: string;
  ariaLabel: string;
  className?: string;
  onClick: (evt: MouseEvent) => void;
}

/**
 * Creates a transparent, background-free SVG icon button following plugin UI conventions.
 */
export function createIconButton(
  parent: HTMLElement,
  options: IconButtonOptions
): HTMLButtonElement {
  const btn = parent.createEl("button", {
    type: "button",
    cls: `clickable-icon ichat-icon-btn ${options.className ?? ""}`.trim(),
    attr: {
      "aria-label": options.ariaLabel,
    },
  });
  setIcon(btn, options.icon);
  btn.addEventListener("click", (evt) => {
    evt.stopPropagation();
    options.onClick(evt);
  });
  return btn;
}

export function setButtonIcon(button: HTMLElement, icon: string, ariaLabel?: string): void {
  button.empty();
  setIcon(button, icon);
  if (ariaLabel) {
    button.setAttribute("aria-label", ariaLabel);
  }
}
