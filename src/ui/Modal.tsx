// Small building blocks shared by the Inventory and Purchasing screens.

import { useEffect, useId, useRef, type ReactNode } from "react";

/** Native modal <dialog>: focus stays inside, Esc closes it. */
export function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h3 id={titleId}>{title}</h3>
        <button type="button" className="icon-btn" aria-label="إغلاق" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Field({ id, label, children, hint }: { id: string; label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="form-field">
      <label htmlFor={id} className="label">{label}</label>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

/** Digits only, as an integer (dinars and quantities have no fractions). */
export function toInt(s: string): number {
  const n = Number(s.replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
