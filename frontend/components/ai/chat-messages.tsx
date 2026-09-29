import { isToolUIPart, type UIMessage } from "ai";
import { ToolCall } from "@/components/ai/tool-call";

function UserMessage({ message }: { message: UIMessage }) {
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm">{text}</div>;
}

function AssistantMessage({ message }: { message: UIMessage }) {
  return (
    <div className="flex gap-3">
      <span className="mt-2 h-4 w-px shrink-0 bg-foreground/25" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return (
              <p key={index} className="whitespace-pre-wrap text-sm leading-relaxed">
                {part.text}
              </p>
            );
          }
          if (isToolUIPart(part)) return <ToolCall key={part.toolCallId} part={part} />;
          return null;
        })}
      </div>
    </div>
  );
}

export function ChatMessages({ messages }: { messages: UIMessage[] }) {
  return (
    <ol className="space-y-5" role="log" aria-label="Conversation">
      {messages.map((message) => (
        <li key={message.id}>
          {message.role === "user" ? <UserMessage message={message} /> : <AssistantMessage message={message} />}
        </li>
      ))}
    </ol>
  );
}
