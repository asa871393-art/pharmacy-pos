import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Receipt } from "../core/types.ts";
import { ReceiptPrint } from "./ReceiptPrint.tsx";

// Printing a receipt: requestPrint() hands the receipt to the one PrintHost (mounted next to the app). It renders it,
// sets the page to the receipt's paper and exact length (a thermal printer then feeds only what is printed), and
// opens the print dialog. While printing, src/styles/print.css hides everything but the host.

const EVENT = "pos:print-receipt";

export function requestPrint(receipt: Receipt) {
  window.dispatchEvent(new CustomEvent<Receipt>(EVENT, { detail: receipt }));
}

const PAPER_WIDTH_MM: Record<Receipt["settings"]["paper"], number> = { "80": 80, "58": 58, a4: 210 };

export function PrintHost() {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onRequest = (e: Event) => setReceipt({ ...(e as CustomEvent<Receipt>).detail });
    window.addEventListener(EVENT, onRequest);
    return () => window.removeEventListener(EVENT, onRequest);
  }, []);

  // After the receipt is in the page: size the paper, print, clean up.
  useLayoutEffect(() => {
    if (!receipt || !ref.current) return;
    const paper = receipt.settings.paper;
    const style = document.createElement("style");
    if (paper === "a4") {
      style.textContent = "@page { size: A4; margin: 12mm; }";
    } else {
      // The host is laid out off-screen at the paper's width (print.css), so it can be measured.
      // 1 CSS px = 25.4/96 mm, plus a little feed at the end.
      const heightMm = Math.ceil((ref.current.getBoundingClientRect().height * 25.4) / 96) + 6;
      style.textContent = `@page { size: ${PAPER_WIDTH_MM[paper]}mm ${heightMm}mm; margin: 0; }`;
    }
    document.head.appendChild(style);
    document.body.classList.add("printing-receipt");
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.body.classList.remove("printing-receipt");
      style.remove();
      window.removeEventListener("afterprint", cleanup);
      setReceipt(null);
    };
    window.addEventListener("afterprint", cleanup);
    // Let the browser lay the receipt out before the dialog snapshots the page.
    const t = setTimeout(() => {
      window.print();
      // Some webviews do not fire afterprint; print() returns once the dialog closes.
      setTimeout(cleanup, 500);
    }, 50);
    return () => clearTimeout(t);
  }, [receipt]);

  return (
    <div className="print-host" ref={ref} aria-hidden="true">
      {receipt && <ReceiptPrint receipt={receipt} />}
    </div>
  );
}
