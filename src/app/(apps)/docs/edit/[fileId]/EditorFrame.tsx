"use client";

// Standard Collabora integration: POST the WOPI access token into a named iframe, then talk
// to the editor over postMessage (ready handshake, close button).
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const FRAME = "collabora-editor";

export function EditorFrame({
  action,
  origin,
  token,
  ttl,
  backHref,
  title,
}: {
  action: string;
  origin: string;
  token: string;
  ttl: number;
  backHref: string;
  title: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const router = useRouter();

  useEffect(() => {
    formRef.current?.submit();
  }, [action, token]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== origin || e.source !== frameRef.current?.contentWindow) return;
      let msg: { MessageId?: string; Values?: { Status?: string } };
      try {
        msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (msg?.MessageId === "App_LoadingStatus" && msg.Values?.Status === "Frame_Ready") {
        frameRef.current?.contentWindow?.postMessage(
          JSON.stringify({ MessageId: "Host_PostmessageReady", SendTime: Date.now(), Values: {} }),
          origin,
        );
      } else if (msg?.MessageId === "UI_Close") {
        router.push(backHref);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin, backHref, router]);

  return (
    <div className="relative min-h-0 flex-1 bg-sheet-muted">
      <form ref={formRef} action={action} method="post" target={FRAME} className="hidden">
        <input type="hidden" name="access_token" value={token} />
        <input type="hidden" name="access_token_ttl" value={String(ttl)} />
      </form>
      <iframe
        ref={frameRef}
        name={FRAME}
        title={title}
        allow="clipboard-read; clipboard-write; fullscreen"
        allowFullScreen
        className="absolute inset-0 h-full w-full border-0"
      />
    </div>
  );
}
