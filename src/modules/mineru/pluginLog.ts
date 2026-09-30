/** Window-only records. Never pass process output or configuration to diagnostics. */
export type PluginLogStage =
  | "preparing"
  | "parsing"
  | "validation"
  | "saving"
  | "recovery"
  | "task";
export type PluginLogRecord = {
  timestamp: string;
  stage: PluginLogStage;
  event: "start" | "complete" | "error" | "success" | "failure";
  message: string;
  details?: string;
};

function safeText(text: string): string {
  return text
    .slice(0, 12000)
    .split(/\r?\n/)
    .map((original) => {
      const line = original
        .replace(
          /\b(?:authorization)\b\s*[:=]\s*(?:Bearer|Basic)\s+\S+/gi,
          "[redacted]",
        )
        .replace(
          /\b(?:api[_-]?key|access[_-]?key|token|secret|password|credential|authorization|cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
          "[redacted]",
        );
      // Error messages sometimes embed YAML, JSON, environment or credentials.
      // Suppress payload lines; only diagnostic text and stack frames belong here.
      if (
        /^\s*[{[](?!redacted\])|^\s*[A-Z_][A-Z_0-9]*=|^\s*[a-z_][\w.-]*\s*[:=]|config(?:uration)?\s*(?:contents?|payload)|environment\s*[:={]|\b(?:secret|credential|password|token)\b(?!\s*[:=])/i.test(
          line,
        )
      )
        return "[sensitive payload omitted]";
      return line
        .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
        .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, "$1[parameters redacted]");
    })
    .join("\n");
}

/** Read only diagnostic fields, never serialize arbitrary exception objects. */
export function safeDiagnostic(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): string => {
    if (depth > 4 || seen.has(value)) return "";
    if (typeof value === "string") return safeText(value.split(/\r?\n/)[0]);
    if (!value || typeof value !== "object") return "";
    seen.add(value);
    const diagnostic = value as {
      message?: unknown;
      stack?: unknown;
      cause?: unknown;
    };
    const parts: string[] = [];
    try {
      if (typeof diagnostic.message === "string")
        parts.push(safeText(diagnostic.message.split(/\r?\n/)[0]));
      // Keep frames, not another copy of the message or embedded payload.
      if (typeof diagnostic.stack === "string") {
        const frames = diagnostic.stack
          .split(/\r?\n/)
          .filter((line) => /^\s*at\s|^[^\s]*@/.test(line));
        if (frames.length) parts.push(`Stack:\n${safeText(frames.join("\n"))}`);
      }
      if (value instanceof AggregateError && Array.isArray(value.errors)) {
        for (const [index, related] of value.errors.slice(0, 8).entries()) {
          const detail = visit(related, depth + 1);
          if (detail) parts.push(`Related error ${index + 1}:\n${detail}`);
        }
      }
      const cause = visit(diagnostic.cause, depth + 1);
      if (cause) parts.push(`Cause:\n${cause}`);
    } catch {
      // Exotic external exception getters are not safe to inspect further.
    }
    return parts.join("\n");
  };
  return visit(error, 0) || undefined;
}
