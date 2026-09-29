"use client";

import { useChat } from "@ai-sdk/react";
import { Popover } from "@base-ui/react/popover";
import { DefaultChatTransport } from "ai";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/ai/chat-panel";
import { LauncherGlyph } from "@/components/ai/launcher-glyph";
import { useSlashShortcut } from "@/hooks/use-slash-shortcut";

// A floating chat bar at the bottom centre that opens a floating chat box above it. Both are position: fixed,
// so scrolling the page never moves them. The bar is the only close control (plus Esc). The chat
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
        className="fixed bottom-4 left-1/2 z-40 flex h-12 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-full border bg-card/85 py-2 pr-3 pl-2 text-left text-sm text-muted-foreground shadow-[0_10px_30px_-12px_rgb(17_17_17/0.35)] backdrop-blur-md transition-[box-shadow,background-color] duration-200 outline-none hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/60 motion-reduce:transition-none dark:shadow-none"
      >
        <span className="grid size-8 flex-none place-items-center rounded-full bg-foreground text-background">
          <LauncherGlyph open={open} className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">{open ? "Close the assistant" : "Ask FuelOps about the network, risks or the RL policy…"}</span>
        <kbd className="flex-none rounded border px-1.5 py-0.5 font-mono text-[0.6875rem]">{open ? "Esc" : "/"}</kbd>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          positionMethod="fixed"
          side="top"
          align="center"
          sideOffset={12}
          collisionPadding={16}
          className="z-50"
        >
          <Popover.Popup
            initialFocus={inputRef}
            finalFocus={false}
            className="flex h-[min(36rem,calc(100dvh-8rem))] w-[min(36rem,calc(100vw-2rem))] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-[0_16px_40px_-16px_rgb(17_17_17/0.22)] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] outline-none data-[ending-style]:translate-y-1 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 motion-reduce:transition-none motion-reduce:data-[ending-style]:transform-none motion-reduce:data-[starting-style]:transform-none dark:shadow-none"
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
