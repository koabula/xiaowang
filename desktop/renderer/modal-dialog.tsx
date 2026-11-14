import { useEffect, useRef, type ReactNode } from "react";

export function ModalDialog({ children, className, label, onCancel }: { children: ReactNode; className: string; label: string; onCancel(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  return <dialog ref={dialog} className={className} aria-label={label} onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }} onClick={event => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onCancel(); }}>{children}</dialog>;
}
