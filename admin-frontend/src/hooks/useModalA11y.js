import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[tabindex]:not([tabindex=\"-1\"])",
  "[contenteditable]"
].join(", ");

/**
 * useModalA11y - Accessibility hook for managing keyboard focus, Tab traps,
 * Escape key dismissal, and focus restoration for modal dialogs and drawers.
 */
export function useModalA11y({
  isOpen,
  onClose,
  modalRef,
  initialFocusRef,
  triggerRef,
  isTopmost = true
}) {
  const previousActiveElement = useRef(null);
  const onCloseRef = useRef(onClose);
  const isTopmostRef = useRef(isTopmost);

  // Keep callback and topmost refs up-to-date without triggering effect cleanup
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    isTopmostRef.current = isTopmost;
  }, [isTopmost]);

  useEffect(() => {
    if (!isOpen) return;

    // Capture the trigger element that launched the modal
    if (triggerRef && triggerRef.current) {
      previousActiveElement.current = triggerRef.current;
    } else if (document.activeElement && document.activeElement !== document.body) {
      previousActiveElement.current = document.activeElement;
    }

    // Set initial focus inside modal
    const timer = setTimeout(() => {
      if (initialFocusRef && initialFocusRef.current) {
        initialFocusRef.current.focus();
      } else if (modalRef && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll(FOCUSABLE_SELECTOR);
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          modalRef.current.focus();
        }
      }
    }, 10);

    const handleKeyDown = (e) => {
      // Only the topmost active overlay should handle Escape and Tab traps
      if (!isTopmostRef.current) return;

      if (e.key === "Escape" || e.key === "Esc") {
        e.preventDefault();
        e.stopPropagation();
        if (onCloseRef.current) {
          onCloseRef.current();
        }
        return;
      }

      if (e.key === "Tab") {
        if (!modalRef || !modalRef.current) return;

        const allFocusable = Array.from(
          modalRef.current.querySelectorAll(FOCUSABLE_SELECTOR)
        ).filter((el) => {
          if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") return false;
          try {
            const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (style && (style.display === "none" || style.visibility === "hidden")) return false;
          } catch {
            // ignore
          }
          return true;
        });

        if (allFocusable.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = allFocusable[0];
        const lastElement = allFocusable[allFocusable.length - 1];

        if (e.shiftKey) {
          // Shift + Tab: wrap to last element
          if (
            document.activeElement === firstElement ||
            !modalRef.current.contains(document.activeElement)
          ) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          // Tab: wrap to first element
          if (
            document.activeElement === lastElement ||
            !modalRef.current.contains(document.activeElement)
          ) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown, true);

      // Restore focus to opener
      const toRestore = previousActiveElement.current;
      if (toRestore && typeof toRestore.focus === "function" && document.body.contains(toRestore)) {
        setTimeout(() => {
          try {
            toRestore.focus();
          } catch {
            // Ignore if element is no longer in DOM or cannot be focused
          }
        }, 0);
      }
    };
  }, [isOpen, initialFocusRef, modalRef, triggerRef]);
}

export default useModalA11y;
