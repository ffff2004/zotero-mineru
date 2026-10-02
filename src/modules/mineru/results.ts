/** Resolve exact PDF identities and inspect their published attachment bundles. */
import { validatePublishedPackage, type ParseOptions } from "./package";
import type { TaskSnapshot } from "./task";
import {
  identity,
  itemIdentity,
  MineruAPIError,
  type ItemIdentity,
} from "./apiError";

export type ResultRecord = ItemIdentity & {
  availability: "valid" | "stale" | "partial" | "damaged";
  title: string;
  dateAdded: string;
  sourceSha256?: string;
  options?: ParseOptions;
  runtime?: { release_id?: string; profile?: string };
  configurationSha256?: string;
  environmentSha256?: string;
  paths: {
    markdown: string | null;
    middle: string | null;
    provenance: string | null;
  };
  issues: string[];
};
export type SourceRecord = ItemIdentity & {
  path: string | null;
  sha256: string | null;
};
export type ResultsResponse = { source: SourceRecord; results: ResultRecord[] };

export async function resolveSource(value: unknown): Promise<Zotero.Item> {
  const selected = identity(value);
  const item = await Zotero.Items.getByLibraryAndKeyAsync(
    selected.libraryID,
    selected.itemKey,
  );
  if (!item || item.deleted)
    throw new MineruAPIError(
      404,
      "item_not_found",
      "Zotero item does not exist",
    );
  if (item.isPDFAttachment()) return item;
  if (!item.isRegularItem())
    throw new MineruAPIError(
      400,
      "invalid_source",
      "Select a PDF or bibliographic item",
    );
  const attachments = (await Zotero.Items.getAsync(
    item.getAttachments(false),
  )) as Zotero.Item[];
  const pdfs = attachments.filter(
    (child) => child && !child.deleted && child.isPDFAttachment(),
  );
  if (!pdfs.length)
    throw new MineruAPIError(
      404,
      "missing_pdf",
      "This item has no PDF attachment",
    );
  if (pdfs.length > 1)
    throw new MineruAPIError(409, "multiple_pdfs", "Choose the source PDF", {
      candidates: pdfs.map((pdf) => ({
        ...itemIdentity(pdf),
        title: pdf.getField("title"),
        filename: pdf.attachmentFilename,
      })),
    });
  return pdfs[0];
}

export async function describeSource(
  source: Zotero.Item,
): Promise<SourceRecord> {
  const path = await source.getFilePathAsync();
  return {
    ...itemIdentity(source),
    path: path || null,
    sha256: path ? await IOUtils.computeHexDigest(path, "sha256") : null,
  };
}

export async function inspectResult(
  item: Zotero.Item,
  sha256: string | null,
): Promise<ResultRecord> {
  const result: ResultRecord = {
    ...itemIdentity(item),
    title: String(item.getField("title")),
    dateAdded: item.dateAdded,
    availability: "damaged",
    paths: { markdown: null, middle: null, provenance: null },
    issues: [],
  };
  const main = await item.getFilePathAsync();
  if (!main || PathUtils.filename(main) !== "markdown.md") {
    result.issues.push("markdown_missing");
    return result;
  }
  result.paths.markdown = main;
  try {
    await IOUtils.readUTF8(main);
  } catch {
    result.issues.push("markdown_unreadable");
    return result;
  }
  const root = PathUtils.parent(main)!;
  for (const [name, filename] of [
    ["middle", "middle_json.json"],
    ["provenance", "provenance.json"],
  ] as const) {
    const path = PathUtils.join(root, filename);
    if (await IOUtils.exists(path)) result.paths[name] = path;
    else result.issues.push(`${name}_missing`);
  }
  try {
    if (result.paths.middle) {
      // Reuse the export validator, including Markdown-only assets and ordered
      // fixed-layout blocks, rather than maintaining a weaker second validator.
      await validatePublishedPackage(root);
    }
    if (result.paths.provenance) {
      const provenance = JSON.parse(
        await IOUtils.readUTF8(result.paths.provenance),
      );
      if (
        provenance.package_format_version !== 1 ||
        !/^[a-f0-9]{64}$/.test(provenance.source?.sha256)
      )
        result.issues.push("provenance_invalid");
      else {
        result.sourceSha256 = provenance.source.sha256;
        result.options = provenance.requested_options;
        result.runtime = provenance.runtime;
        result.configurationSha256 = provenance.configuration?.sha256;
        result.environmentSha256 = provenance.configuration?.environment_sha256;
      }
    }
  } catch {
    result.issues.push("sidecar_invalid");
  }
  if (!sha256) result.issues.push("source_unavailable");
  result.availability = result.issues.length
    ? "partial"
    : result.sourceSha256 === sha256
      ? "valid"
      : "stale";
  return result;
}

export async function findResults(
  source: Zotero.Item,
  sha256?: string,
): Promise<ResultsResponse> {
  const description = sha256
    ? {
        ...itemIdentity(source),
        path: (await source.getFilePathAsync()) || null,
        sha256,
      }
    : await describeSource(source);
  const sourceURI = Zotero.URI.getItemURI(source);
  const relations = await (
    Zotero as unknown as {
      Relations: {
        getByObject(
          type: "item",
          uri: string,
        ): Promise<{ subject: Zotero.Item; predicate: string }[]>;
      };
    }
  ).Relations.getByObject("item", sourceURI);
  const candidates = [
    ...new Map(
      relations
        .filter(
          (relation) =>
            relation.predicate === "dc:relation" &&
            relation.subject.libraryID === source.libraryID,
        )
        .map((relation) => [relation.subject.id, relation.subject]),
    ).values(),
  ];
  const results: ResultRecord[] = [];
  for (const item of candidates) {
    await item.loadAllData();
    if (
      item &&
      !item.deleted &&
      item.isAttachment() &&
      item.isStoredFileAttachment() &&
      item.attachmentContentType === "text/markdown" &&
      item.getNote().includes("zotero-mineru-generation:v1") &&
      item.getRelationsByPredicate("dc:relation").includes(sourceURI)
    )
      results.push(await inspectResult(item, description.sha256));
  }
  results.sort(
    (a, b) =>
      b.dateAdded.localeCompare(a.dateAdded) ||
      b.itemKey.localeCompare(a.itemKey),
  );
  return { source: description, results };
}

export async function reusableResult(
  snapshot: TaskSnapshot,
): Promise<Zotero.Item | undefined> {
  const { results } = await findResults(snapshot.source, snapshot.inputSha256);
  const options = snapshot.requestedOptions;
  const match = results.find(
    (result) =>
      result.availability === "valid" &&
      result.runtime?.release_id === snapshot.runtime.descriptor.release_id &&
      result.runtime?.profile === snapshot.runtime.descriptor.profile &&
      result.configurationSha256 === snapshot.configurationSha256 &&
      result.environmentSha256 === snapshot.environmentSha256 &&
      result.options?.tier === options.tier &&
      result.options.ocr_mode === options.ocr_mode &&
      result.options.image_analysis === options.image_analysis &&
      result.options.page_range === options.page_range,
  );
  if (match)
    return (
      (await Zotero.Items.getByLibraryAndKeyAsync(
        match.libraryID,
        match.itemKey,
      )) || undefined
    );
  return undefined;
}
