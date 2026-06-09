"use client";

import { useState, useEffect } from "react";

interface MobileWarningProps {
  onContinue: () => void;
}

export default function MobileWarning({ onContinue }: MobileWarningProps) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkSize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkSize();
    window.addEventListener("resize", checkSize);
    return () => window.removeEventListener("resize", checkSize);
  }, []);

  if (!isMobile) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center p-6 text-center bg-[#0a0a0f] gradient-bg overflow-y-auto">
      <div className="max-w-md w-full bg-[#141419] border border-[#27272a] rounded-2xl p-8 shadow-2xl relative overflow-hidden glow-border">
        {/* Glow effects */}
        <div className="absolute -top-10 -left-10 w-40 h-40 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-accent/10 rounded-full blur-3xl pointer-events-none" />

        {/* Warning Icon */}
        <div className="w-16 h-16 rounded-2xl bg-amber-500/10 flex items-center justify-center text-amber-500 mx-auto mb-6 border border-amber-500/20">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>

        {/* Title */}
        <h2 className="text-xl font-bold text-foreground mb-4">
          Larger Screen Recommended
        </h2>

        {/* Message */}
        <p className="text-muted text-sm leading-relaxed mb-8">
          CodeMap AI is optimized for larger screens. For the best repository visualization and issue mapping experience, please use a tablet, laptop, or desktop device.
        </p>

        {/* Continue Button */}
        <div className="flex flex-col gap-3">
          <button
            onClick={onContinue}
            className="w-full py-3 px-4 rounded-xl bg-primary hover:bg-primary-hover text-white font-medium text-sm transition-all shadow-md shadow-primary/20 cursor-pointer"
          >
            Continue Anyway
          </button>
        </div>
      </div>
    </div>
  );
}
