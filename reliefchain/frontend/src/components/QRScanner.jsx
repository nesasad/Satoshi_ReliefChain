import React, { useEffect, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";

export default function QRScanner({ onScan, onClose }) {
  const ref = useRef(null);
  const scannerRef = useRef(null);

  useEffect(() => {
    const scanner = new Html5Qrcode("qr-reader");
    scannerRef.current = scanner;
    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decoded) => {
          scanner.stop().catch(() => {});
          onScan(decoded);
        },
        () => {} // per-frame decode errors are normal, ignore
      )
      .catch((err) => {
        console.error("Camera start failed:", err);
        alert("Camera unavailable. Use the manual transfer button instead.");
        onClose();
      });

    return () => {
      scannerRef.current?.stop().catch(() => {});
    };
  }, [onScan, onClose]);

  return (
    <div className="scanner-overlay">
      <div className="scanner-modal">
        <div id="qr-reader" ref={ref} style={{ width: 280 }} />
        <button onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
