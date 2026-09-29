"use client";

import { useChat } from "@ai-sdk/react";
import { Popover } from "@base-ui/react/popover";
import { DefaultChatTransport } from "ai";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/ai/chat-panel";
import { LauncherGlyph } from "@/components/ai/launcher-glyph";
import { useSlashShortcut } from "@/hooks/use-slash-shortcut";

// A round launcher in the lower right that opens a floating chat box. Both are position: fixed, so
// scrolling the page never moves them. The launcher is the only close control (plus Esc). The chat
// state lives here, above the popup, so closing the box keeps the conversation.
export function AskAssistant({ tick }: { tick?: number }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const transport = useMemo(() => new DefaultChatTransport({ api: "/ai/chat" }), []);
  const { messages, setMessages, sendMessage, status, stop, error, regenerate, clearError } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  useSlashShortcut(useCallback(() => setOpen(true), []));

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    clearError();
    void sendMessage({ text: trimmed });
    setInput("");
  }

  function reset() {
    void stop();
    clearError();
    setMessages([]);
    inputRef.current?.focus();
  }

  const context = tick === undefined ? "Live data" : `Live data, tick ${tick}`;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // The box stays put while the operator works on the page behind it.
        if (!next && (details.reason === "outside-press" || details.reason === "focus-out")) return;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        aria-label={open ? "Close assistant" : "Ask FuelOps"}
        title={open ? "Close (Esc)" : "Ask FuelOps (/)"}
        className="fixed right-5 bottom-5 z-40 grid size-14 place-items-center rounded-full bg-foreground text-background shadow-[0_6px_20px_-6px_rgb(17_17_17/0.35)] transition-transform duration-200 outline-none hover:scale-[1.04] focus-visible:ring-[3px] focus-visible:ring-ring/60 active:scale-[0.96] motion-reduce:transition-none motion-reduce:hover:scale-100 dark:shadow-none"
      >
        <LauncherGlyph open={open} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          positionMethod="fixed"
          side="top"
          align="end"
          sideOffset={12}
          collisionPadding={16}
          className="z-50"
        >
          <Popover.Popup
            initialFocus={inputRef}
            finalFocus={false}
            className="flex h-[min(36rem,calc(100dvh-8rem))] w-[min(24rem,calc(100vw-2rem))] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-[0_16px_40px_-16px_rgb(17_17_17/0.22)] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] outline-none data-[ending-style]:translate-y-1 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 motion-reduce:transition-none motion-reduce:data-[ending-style]:transform-none motion-reduce:data-[starting-style]:transform-none dark:shadow-none"
          >
            <ChatPanel
              context={context}
              messages={messages}
              status={status}
              error={error}
              input={input}
              inputRef={inputRef}
              onInput={setInput}
              onSend={send}
              onStop={() => void stop()}
              onRetry={() => void regenerate()}
              onReset={reset}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
