import { Popover } from "@base-ui/react/popover";
import { ArrowCounterClockwise, ArrowUp, Stop } from "@phosphor-icons/react";
import type { ChatStatus, UIMessage } from "ai";
import { useEffect, useRef, type RefObject } from "react";
import { ChatMessages } from "@/components/ai/chat-messages";
import { Suggestions } from "@/components/ai/suggestions";
import { ICON_SM } from "@/components/icon-props";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/ai/errors";

interface ChatPanelProps {
  context: string; // what the assistant is looking at, e.g. "Live, tick 148"
  messages: UIMessage[];
  status: ChatStatus;
  error?: Error;
  input: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onInput: (value: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: () => void;
  onReset: () => void;
}

// Close is the launcher (or Esc); this panel only carries content and the composer.
export function ChatPanel({ context, messages, status, error, input, inputRef, onInput, onSend, onStop, onRetry, onReset }: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <Popover.Title className="text-sm leading-none font-medium">Ask FuelOps</Popover.Title>
          <p className="mt-1.5 truncate font-mono text-[0.6875rem] text-muted-foreground">{context}</p>
        </div>
        {messages.length > 0 ? (
          <Button variant="ghost" size="icon-sm" onClick={onReset} aria-label="New conversation" title="New conversation">
            <ArrowCounterClockwise {...ICON_SM} />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto overscroll-contain px-4 py-4">
        {messages.length === 0 ? (
          <div className="mt-auto">
            <Suggestions onPick={onSend} />
          </div>
        ) : (
          <ChatMessages messages={messages} />
        )}
        <p className="mt-3 text-sm text-muted-foreground" role="status" aria-live="polite">
          {status === "submitted" ? (
            <span className="inline-flex items-center gap-1.5">
              Checking the data
              <span className="inline-flex gap-0.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="size-1 animate-pulse rounded-full bg-current motion-reduce:animate-none"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </span>
            </span>
          ) : null}
        </p>
        {error ? (
          <p role="alert" className="mt-3 flex items-center gap-2 text-sm text-bad-fg">
            {friendlyError(error)}
            <Button variant="ghost" size="xs" onClick={onRetry}>
              Retry
            </Button>
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <form
        className="border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSend(input);
        }}
      >
        <div className="flex items-center gap-1.5 rounded-lg border bg-background p-1.5 pl-3 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => onInput(event.target.value)}
            maxLength={2000}
            aria-label="Message"
            placeholder="Ask about stock, routes, events"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {busy ? (
            <Button type="button" variant="outline" size="icon-sm" onClick={onStop} aria-label="Stop">
              <Stop {...ICON_SM} weight="fill" />
            </Button>
          ) : (
            <Button type="submit" size="icon-sm" disabled={input.trim() === ""} aria-label="Send">
              <ArrowUp {...ICON_SM} />
            </Button>
          )}
        </div>
      </form>
    </>
  );
}
