"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PublicBookingType } from "@/lib/booking/types";
import { BookingWidget } from "../../_ui/BookingWidget";
import { BTN_PRIMARY, BTN_SECONDARY, INPUT } from "../../_ui/Shell";

export function ManageActions({
  token,
  type,
  duration,
  guestTz,
  ownerName,
}: {
  token: string;
  type: PublicBookingType;
  duration: number;
  guestTz: string;
  ownerName: string;
}) {
  const t = useTranslations("booking.manage");
  const tp = useTranslations("booking.public");
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "reschedule" | "cancel">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/book/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, reason }),
      });
      if (!res.ok) {
        const out = (await res.json().catch(() => ({}))) as { error?: string };
        setError(["rate", "too_late", "not_found"].includes(out.error ?? "") ? out.error! : "failed");
        return;
      }
      setNotice(t("cancelledDone", { owner: ownerName }));
      setMode("idle");
      router.refresh();
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  if (notice) return <p role="status" className="mt-5 text-[14px] text-ink-soft">{notice}</p>;

  return (
    <div className="mt-6 border-t border-line pt-5">
      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN_PRIMARY} onClick={() => setMode("reschedule")}>
            {t("reschedule")}
          </button>
          <button type="button" className={BTN_SECONDARY} onClick={() => setMode("cancel")}>
            {t("cancel")}
          </button>
        </div>
      )}
      {mode === "reschedule" && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[15px] font-medium">{t("pickNew")}</h2>
            <button type="button" className="text-[13px] text-ink-soft hover:text-ink" onClick={() => setMode("idle")}>
              {t("keep")}
            </button>
          </div>
          <BookingWidget
            type={type}
            mode={{ kind: "reschedule", token, duration }}
            initialZone={guestTz}
            onRescheduled={() => {
              setNotice(t("rescheduledDone"));
              router.refresh();
            }}
          />
        </div>
      )}
      {mode === "cancel" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void cancel();
          }}
        >
          <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink-soft">
            {t("cancelReason")}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} className={`${INPUT} !h-auto py-2`} />
          </label>
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {tp(`errors.${error}` as "errors.failed")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={`${BTN_PRIMARY} !bg-danger !text-white`}>
              {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
              {t("confirmCancel")}
            </button>
            <button type="button" className={BTN_SECONDARY} onClick={() => setMode("idle")}>
              {t("keep")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
