import { isApiError } from "@/lib/api/http";

const HINTS: Record<string, string> = {
  UNAUTHORIZED: "Add an operator or admin token in the Control tab.",
  EXPIRED: "The simulator was reset since this was proposed.",
  NOT_PROPOSED: "Someone already decided this one. The list will refresh.",
  MOCK_READONLY: "",
};

// Inline error for a failed action: the API's message, its details (e.g. why a shipment is UNSAFE), and a hint.
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = isApiError(error) ? error.message : "Something went wrong. Try again.";
  const details = isApiError(error) ? error.details : [];
  const hint = isApiError(error) ? HINTS[error.code] : undefined;
  return (
    <div role="alert" className="rounded-md bg-bad-bg px-3 py-2 text-sm text-bad-fg">
      <p>{message}</p>
      {details.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
      {hint ? <p className="mt-1 text-xs">{hint}</p> : null}
    </div>
  );
}

export function ActionDone({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="rounded-md bg-ok-bg px-3 py-2 text-sm text-ok-fg">
      {children}
    </p>
  );
}
