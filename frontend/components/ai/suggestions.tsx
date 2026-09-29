const SUGGESTIONS = [
  "Which stations are running low?",
  "Any disrupted routes?",
  "What is happening right now?",
  "Show recent allocations",
] as const;

// Command-list rows rather than chips: one question per line, hairline dividers.
export function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">Try asking</p>
      <ul className="divide-y divide-border/70 border-y border-border/70">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <button
              type="button"
              onClick={() => onPick(text)}
              className="w-full px-1 py-2.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
