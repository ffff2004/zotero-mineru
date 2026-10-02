/** Machine-readable failures shared by the local task API and service. */
export class MineruAPIError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 503,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MineruAPIError";
  }
}

export type ItemIdentity = { libraryID: number; itemKey: string };

export function identity(value: unknown): ItemIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MineruAPIError(
      400,
      "invalid_identity",
      "Provide libraryID and itemKey",
    );
  const candidate = value as ItemIdentity;
  if (
    !Number.isSafeInteger(candidate.libraryID) ||
    candidate.libraryID < 1 ||
    typeof candidate.itemKey !== "string" ||
    !/^[A-Z0-9]{8}$/.test(candidate.itemKey) ||
    Object.keys(candidate).some(
      (key) => !["libraryID", "itemKey"].includes(key),
    )
  )
    throw new MineruAPIError(
      400,
      "invalid_identity",
      "Invalid libraryID or itemKey",
    );
  return { libraryID: candidate.libraryID, itemKey: candidate.itemKey };
}

export function itemIdentity(item: Zotero.Item): ItemIdentity {
  return { libraryID: item.libraryID, itemKey: item.key };
}
